import { randomUUID } from 'node:crypto';

import {
  AppError,
  ChatMessageSchema,
  CoreError,
  nowIso,
  type ChatMessage,
  type ChatMessageView,
  type ChatVisibility,
  type DomainEvent,
  type MessageId,
  type PlayerId,
  type SessionId,
} from '@mnemosin/contracts';
import {
  appendOutbox,
  createEvent,
  deterministicUuidFromSeed,
  newTraceId,
  runCommand,
  type CommandRunner,
  type TxScope,
  type UnitOfWork,
} from '@mnemosin/core';

import {
  GetMessageOutputSchema,
  HistoryInputSchema,
  HistoryOutputSchema,
  SendGMMessageInputSchema,
  SendPrivateMessageInputSchema,
  SendPublicMessageInputSchema,
  SendSystemMessageInputSchema,
  type SendGMMessageInput,
  type SendPrivateMessageInput,
  type SendPublicMessageInput,
  type SendMessageOutput,
  type SendSystemMessageInput,
  type GetMessageOutput,
  type HistoryInput,
  type HistoryOutput,
} from './contract.js';
import { sanitizeChatText } from './sanitize.js';
import { TokenBucketLimiter } from './rate-limit.js';

/**
 * ChatService (v3 §IV.7; промпт 1.9, п.2; аудит §8.5).
 *
 *  - sanitize: trim, нормализация переводов строк, лимит maxMessageLen
 *    (limits.yaml), отклонение управляющих символов;
 *  - видимость (матрица приватности §8.4): PUBLIC/SYSTEM — broadcast,
 *    PRIVATE — только адресату (событие публикуется, доставку TARGETED
 *    выполняет ws-транспорт в 1.11 по WS_PRIVACY_POLICY), GM — только GM;
 *  - rate limit: token bucket на публичные сообщения (chat.publicPerSecond
 *    из limits.yaml) → RATE_LIMIT;
 *  - события CHAT_MESSAGE_* — через outbox в той же транзакции, что запись
 *    сообщения (D113);
 *  - обработчики TURN_COMMITTED (нарратив + приватные из черновика, D238) и
 *    PLAYER_JOINED/PLAYER_LEFT/SESSION_STATUS_CHANGED (системные сообщения)
 *    идемпотентны: детерминированный messageId из сида → повторная доставка
 *    пропускается (at-least-once).
 */

export interface ChatLimits {
  readonly maxMessageLen: number;
  readonly publicPerSecond: number;
  readonly burstSeconds?: number;
}

export interface ChatLog {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export interface ChatServiceDeps {
  readonly uow: UnitOfWork;
  readonly guard: CommandRunner;
  readonly limits: ChatLimits;
  readonly logger?: ChatLog;
  readonly now?: () => number;
}

/** Детерминированный MessageId (uuid-форма из sha256 сида) — основа идемпотентности (D247). */
export function deterministicMessageId(seed: string): MessageId {
  return deterministicUuidFromSeed(seed) as MessageId;
}

export class ChatService {
  private readonly deps: ChatServiceDeps;
  private readonly publicBucket: TokenBucketLimiter;

  constructor(deps: ChatServiceDeps) {
    this.deps = deps;
    const capacity = Math.max(1, Math.round(deps.limits.publicPerSecond * (deps.limits.burstSeconds ?? 1)));
    this.publicBucket = new TokenBucketLimiter(deps.limits.publicPerSecond, capacity, deps.now ?? Date.now);
  }

  // ---------------------------------------------------------------- команды

  async sendPublicMessage(rawInput: SendPublicMessageInput): Promise<SendMessageOutput> {
    const input = SendPublicMessageInputSchema.parse(rawInput);
    const text = sanitizeChatText(input.text, this.deps.limits.maxMessageLen);
    const traceId = input.traceId ?? newTraceId();
    // Token bucket: N публичных сообщений в секунду на игрока (RATE_LIMIT).
    if (!this.publicBucket.tryConsume(`${input.sessionId}:${input.playerId}`)) {
      throw new AppError('RATE_LIMIT', 'слишком много публичных сообщений — повторите позже', {
        limitPerSecond: this.deps.limits.publicPerSecond,
      });
    }
    const player = await this.sessionMember(input.sessionId, input.playerId);
    return this.post({
      sessionId: input.sessionId,
      turnId: input.turnId ?? null,
      visibility: 'PUBLIC',
      fromPlayerId: input.playerId,
      toPlayerId: null,
      fromDisplayName: player.displayName,
      text,
      messageId: input.messageId,
      idempotencyKey: input.idempotencyKey,
      command: 'sendPublicMessage',
      event: 'CHAT_MESSAGE_PUBLIC',
      traceId,
    });
  }

  async sendPrivateMessage(rawInput: SendPrivateMessageInput): Promise<SendMessageOutput> {
    const input = SendPrivateMessageInputSchema.parse(rawInput);
    const text = sanitizeChatText(input.text, this.deps.limits.maxMessageLen);
    const traceId = input.traceId ?? newTraceId();
    const sender = await this.sessionMember(input.sessionId, input.fromPlayerId);
    await this.sessionMember(input.sessionId, input.toPlayerId);
    return this.post({
      sessionId: input.sessionId,
      turnId: input.turnId ?? null,
      visibility: 'PRIVATE',
      fromPlayerId: input.fromPlayerId,
      toPlayerId: input.toPlayerId,
      fromDisplayName: sender.displayName,
      text,
      messageId: input.messageId,
      idempotencyKey: input.idempotencyKey,
      command: 'sendPrivateMessage',
      // Доставка TARGETED — ws-транспорт (1.11) по WS_PRIVACY_POLICY['CHAT_PRIVATE'].
      event: 'CHAT_MESSAGE_PRIVATE',
      traceId,
    });
  }

  async sendSystemMessage(rawInput: SendSystemMessageInput): Promise<SendMessageOutput> {
    const input = SendSystemMessageInputSchema.parse(rawInput);
    const text = sanitizeChatText(input.text, this.deps.limits.maxMessageLen);
    const traceId = input.traceId ?? newTraceId();
    return this.post({
      sessionId: input.sessionId,
      turnId: input.turnId ?? null,
      visibility: 'SYSTEM',
      fromPlayerId: null,
      toPlayerId: null,
      fromDisplayName: null,
      text,
      messageId: input.messageId,
      command: 'sendSystemMessage',
      event: 'CHAT_MESSAGE_SYSTEM',
      traceId,
    });
  }

  async sendGMMessage(rawInput: SendGMMessageInput): Promise<SendMessageOutput> {
    const input = SendGMMessageInputSchema.parse(rawInput);
    const text = sanitizeChatText(input.text, this.deps.limits.maxMessageLen);
    const traceId = input.traceId ?? newTraceId();
    const gm = await this.sessionMember(input.sessionId, input.gmPlayerId);
    if (!gm.isGM) {
      throw new AppError('AUTH_FORBIDDEN', 'GM-канал доступен только ведущему', { reason: 'not_gm' });
    }
    return this.post({
      sessionId: input.sessionId,
      turnId: input.turnId ?? null,
      visibility: 'GM',
      fromPlayerId: input.gmPlayerId,
      toPlayerId: null,
      fromDisplayName: gm.displayName,
      text,
      messageId: input.messageId,
      command: 'sendGMMessage',
      event: 'CHAT_MESSAGE_GM',
      traceId,
    });
  }

  // ---------------------------------------------------------------- запросы

  /**
   * Лента истории (A1.10): PUBLIC — вся лента; PRIVATE — только from/to игрока;
   * GM — только GM; без visibility: с playerId — матрица видимости игрока
   * (listForPlayer), без — полная лента (GM/админ). Порядок: новые сверху.
   */
  async history(rawInput: HistoryInput): Promise<HistoryOutput> {
    const input = HistoryInputSchema.parse(rawInput);
    const repos = this.deps.uow.repos();
    const limit = input.limit;
    // Фильтр since применяется поверх выборки — берём с запасом.
    const fetchLimit = Math.min(500, Math.max(limit, limit * 2));
    let messages: ChatMessage[];
    if (input.visibility === 'PRIVATE') {
      if (input.playerId === undefined) {
        throw new AppError('VALIDATION', 'history(visibility=PRIVATE) требует playerId', { reason: 'player_required' });
      }
      const playerId: PlayerId = input.playerId;
      messages = (await repos.chat.listForPlayer(input.sessionId, playerId, fetchLimit)).filter(
        (message) =>
          message.visibility === 'PRIVATE' && (message.fromPlayerId === playerId || message.toPlayerId === playerId),
      );
    } else if (input.visibility !== undefined) {
      const visibility: ChatVisibility = input.visibility;
      messages = await repos.chat.listByVisibility(input.sessionId, visibility, fetchLimit);
    } else if (input.playerId !== undefined) {
      messages = await repos.chat.listForPlayer(input.sessionId, input.playerId, fetchLimit);
    } else {
      messages = await repos.chat.listBySession(input.sessionId, fetchLimit);
    }
    const filtered =
      input.since !== undefined ? messages.filter((message) => message.createdAt > (input.since as string)) : messages;
    return HistoryOutputSchema.parse(filtered.slice(0, limit).map(toChatMessageView));
  }

  /**
   * D271 (промпт 1.11): одно сообщение как view — WS-транспорт строит из него
   * CHAT_PUBLIC/PRIVATE/SYSTEM/GM при доставке CHAT_MESSAGE_*-событий.
   * Приватность обеспечивает вызывающий (WS_PRIVACY_POLICY в projections.ts).
   */
  async getMessage(messageId: MessageId): Promise<GetMessageOutput> {
    const message = await this.deps.uow.repos().chat.findById(messageId);
    return GetMessageOutputSchema.parse(message === null ? null : toChatMessageView(message));
  }

  // ------------------------------------------------------- обработчики событий

  /**
   * TURN_COMMITTED → доставка черновика (D238): публичные сегменты — SYSTEM-
   * сообщениями, GM-сегменты — в GM-канал, PLAYER/PLAYERS-сегменты и
   * privateMessages — приватными от имени GM/Директора. Только item'ы APPLIED.
   * Идемпотентно: messageId детерминирован (сид — turnId+segmentId/индекс).
   */
  async onTurnCommitted(event: DomainEvent): Promise<void> {
    if (event.type !== 'TURN_COMMITTED') return;
    const { sessionId, turnId } = event.payload;
    const repos = this.deps.uow.repos();
    const turn = await repos.turns.findById(turnId);
    if (turn === null || turn.resolution === null) return;
    const session = await repos.sessions.findById(sessionId);
    if (session === null) return;
    const gmPlayerId = session.gmPlayerId;

    for (const segment of turn.resolution.segments) {
      if (segment.status !== 'APPLIED') continue;
      const audience = segment.audience;
      if (audience.kind === 'ALL') {
        await this.sendSystemMessage({
          sessionId,
          text: segment.text,
          turnId,
          messageId: deterministicMessageId(`turn:${turnId}:seg:${segment.segmentId}`),
          traceId: event.traceId,
        });
      } else if (audience.kind === 'GM') {
        await this.sendGMMessage({
          sessionId,
          gmPlayerId,
          text: segment.text,
          turnId,
          messageId: deterministicMessageId(`turn:${turnId}:seg:${segment.segmentId}`),
          traceId: event.traceId,
        });
      } else {
        const recipients = audience.kind === 'PLAYER' ? [audience.playerId] : audience.playerIds;
        for (const playerId of recipients) {
          await this.sendPrivateMessage({
            sessionId,
            fromPlayerId: gmPlayerId,
            toPlayerId: playerId,
            text: segment.text,
            turnId,
            messageId: deterministicMessageId(`turn:${turnId}:seg:${segment.segmentId}:${playerId}`),
            traceId: event.traceId,
          });
        }
      }
    }

    for (const [index, message] of turn.resolution.privateMessages.entries()) {
      if (message.status !== 'APPLIED') continue;
      await this.sendPrivateMessage({
        sessionId,
        fromPlayerId: gmPlayerId,
        toPlayerId: message.playerId,
        text: message.text,
        turnId,
        messageId: deterministicMessageId(`turn:${turnId}:pm:${index}:${message.playerId}`),
        traceId: event.traceId,
      });
    }
  }

  /** PLAYER_JOINED → системное сообщение ленты (идемпотентно по traceId события). */
  async onPlayerJoined(event: DomainEvent): Promise<void> {
    if (event.type !== 'PLAYER_JOINED') return;
    const { sessionId, displayName, characterName } = event.payload;
    await this.sendSystemMessage({
      sessionId,
      text: `Игрок ${displayName} (персонаж «${characterName}») присоединился к партии.`,
      messageId: deterministicMessageId(`sys:joined:${event.traceId}`),
      traceId: event.traceId,
    });
  }

  /** PLAYER_LEFT → системное сообщение ленты. */
  async onPlayerLeft(event: DomainEvent): Promise<void> {
    if (event.type !== 'PLAYER_LEFT') return;
    const { sessionId, playerId, reason } = event.payload;
    const player = await this.deps.uow.repos().players.findById(playerId);
    const who = player?.displayName ?? playerId.slice(0, 8);
    const verb =
      reason === 'KICKED' ? 'удалён ведущим из партии' : reason === 'TIMEOUT' ? 'потерял соединение' : 'покинул партию';
    await this.sendSystemMessage({
      sessionId,
      text: `Игрок ${who} ${verb}.`,
      messageId: deterministicMessageId(`sys:left:${event.traceId}`),
      traceId: event.traceId,
    });
  }

  /** SESSION_STATUS_CHANGED → системное сообщение ленты. */
  async onSessionStatusChanged(event: DomainEvent): Promise<void> {
    if (event.type !== 'SESSION_STATUS_CHANGED') return;
    const { sessionId, from, to } = event.payload;
    await this.sendSystemMessage({
      sessionId,
      text: `Статус сессии: ${from} → ${to}.`,
      messageId: deterministicMessageId(`sys:status:${event.traceId}`),
      traceId: event.traceId,
    });
  }

  /** WORLD_EVENT_FIRED — этап 2 (Event Engine, промпт 2.1): объявлено, не обрабатывается. */
  async onWorldEventFired(event: DomainEvent): Promise<void> {
    if (event.type !== 'WORLD_EVENT_FIRED') return;
    this.deps.logger?.debug({ ...event.payload, event: 'world_event_chat_stub' }, 'world_event_chat_stub');
  }

  // ---------------------------------------------------------------- внутреннее

  private async post(input: {
    sessionId: SessionId;
    turnId: ChatMessage['turnId'];
    visibility: ChatVisibility;
    fromPlayerId: PlayerId | null;
    toPlayerId: PlayerId | null;
    fromDisplayName: string | null;
    text: string;
    messageId?: MessageId | undefined;
    idempotencyKey?: string | undefined;
    command: 'sendPublicMessage' | 'sendPrivateMessage' | 'sendSystemMessage' | 'sendGMMessage';
    event: 'CHAT_MESSAGE_PUBLIC' | 'CHAT_MESSAGE_PRIVATE' | 'CHAT_MESSAGE_SYSTEM' | 'CHAT_MESSAGE_GM';
    traceId: string;
  }): Promise<SendMessageOutput> {
    const messageId = input.messageId ?? (randomUUID() as MessageId);

    // Дедупликация по детерминированному id: повторная доставка события или
    // повтор клиента с тем же messageId — НЕ создаёт вторую запись.
    const existing = await this.deps.uow.repos().chat.findById(messageId);
    if (existing !== null) {
      return { messageId, sequenceId: await this.sequenceOf(input.sessionId), replayed: true };
    }

    const message = ChatMessageSchema.parse({
      messageId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      visibility: input.visibility,
      fromPlayerId: input.fromPlayerId,
      toPlayerId: input.toPlayerId,
      fromDisplayName: input.fromDisplayName,
      text: input.text,
      createdAt: nowIso(),
    } satisfies ChatMessage);

    const work = async (scope: TxScope): Promise<SendMessageOutput> => {
      await scope.repos.chat.insert(message);
      await appendOutbox([this.messageEvent(input, messageId, input.traceId)], scope);
      return { messageId, sequenceId: await this.sequenceOf(input.sessionId, scope), replayed: false };
    };

    if (input.idempotencyKey !== undefined) {
      const result = await runCommand(
        this.deps.guard,
        {
          key: input.idempotencyKey,
          command: input.command,
          sessionId: input.sessionId,
          turnId: null,
          traceId: input.traceId,
        },
        work,
      );
      return result.replayed ? { ...result.value, replayed: true } : result.value;
    }
    return this.deps.uow.runInTx(work);
  }

  private messageEvent(
    input: {
      event: string;
      sessionId: SessionId;
      fromPlayerId: PlayerId | null;
      toPlayerId: PlayerId | null;
      turnId: ChatMessage['turnId'];
    },
    messageId: MessageId,
    traceId: string,
  ): DomainEvent {
    switch (input.event) {
      case 'CHAT_MESSAGE_PUBLIC':
        return createEvent(
          'CHAT_MESSAGE_PUBLIC',
          {
            sessionId: input.sessionId,
            messageId,
            fromPlayerId: input.fromPlayerId as PlayerId, // PUBLIC всегда с отправителем (схема сообщения гарантирует)
            turnId: input.turnId,
          },
          traceId,
        );
      case 'CHAT_MESSAGE_PRIVATE':
        return createEvent(
          'CHAT_MESSAGE_PRIVATE',
          {
            sessionId: input.sessionId,
            messageId,
            fromPlayerId: input.fromPlayerId,
            toPlayerId: input.toPlayerId as PlayerId,
            turnId: input.turnId,
          },
          traceId,
        );
      case 'CHAT_MESSAGE_GM':
        return createEvent('CHAT_MESSAGE_GM', { sessionId: input.sessionId, messageId, turnId: input.turnId }, traceId);
      default:
        return createEvent(
          'CHAT_MESSAGE_SYSTEM',
          { sessionId: input.sessionId, messageId, turnId: input.turnId },
          traceId,
        );
    }
  }

  /** Порядковый номер сообщения в ленте сессии (1-based) на момент записи. */
  private async sequenceOf(sessionId: SessionId, scope?: TxScope): Promise<number> {
    const repos = scope?.repos ?? this.deps.uow.repos();
    return (await repos.chat.listBySession(sessionId, 100_000)).length;
  }

  /** Участник сессии (защита от записи «мимо» партии). */
  private async sessionMember(sessionId: SessionId, playerId: PlayerId) {
    const player = await this.deps.uow.repos().players.findById(playerId);
    if (player === null || player.sessionId !== sessionId || player.status === 'LEFT') {
      throw new CoreError('CORE_NOT_FOUND', `игрок ${playerId} не принадлежит сессии ${sessionId}`, {
        entity: 'player',
        playerId,
      });
    }
    return player;
  }
}

export function toChatMessageView(message: ChatMessage): ChatMessageView {
  return {
    messageId: message.messageId,
    visibility: message.visibility,
    fromPlayerId: message.fromPlayerId,
    fromDisplayName: message.fromDisplayName,
    toPlayerId: message.toPlayerId,
    text: message.text,
    turnId: message.turnId,
    createdAt: message.createdAt,
  };
}
