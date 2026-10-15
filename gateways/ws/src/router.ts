import { createHash, randomUUID } from 'node:crypto';

import {
  AppError,
  WS_GM_ONLY,
  WS_REQUIRES_IDEMPOTENCY_KEY,
  WSClientMessageSchema,
  type ErrorCode,
  type NoteId,
  type PlayerId,
  type SessionId,
  type TurnId,
  type WSClientType,
} from '@mnemosin/contracts';
import { ZodError } from 'zod';
import type { WebSocket } from '@fastify/websocket';

import type { ConnectionId, FlagKey } from '@mnemosin/contracts';

import { closeWithCode, type WsIdentity } from './auth.js';
import type { ConnectionRegistry } from './connection-registry.js';
import { RequestDedupeCache } from './dedupe.js';
import type { WsGatewayDeps, WsGatewayLog } from './deps.js';
import type { ServerEnvelope, WsBroadcaster } from './projections.js';
import type { ConnectionRateLimiter } from './rate-limit.js';

/**
 * Маршрутизатор входящих WS-сообщений (промпт 1.11, п.4).
 *
 * WSClientMessage.parse → switch по type → команда соответствующего модуля
 * (ACTION_SUBMIT → turn.submitAction; CHAT_* → chat; GM_* → gm/gm-review;
 * SUBSCRIBE → проверка участия; HISTORY → chat.history; PING → PONG).
 *
 *  - обязательный idempotencyKey для WS_REQUIRES_IDEMPOTENCY_KEY (отсутствие →
 *    VALIDATION; B-08: сервер ключ не додумывает);
 *  - ДЕДУПЛИКАЦИЯ по requestId (F-6.7): LRU-кэш с TTL dedupeTtlMs + in-flight
 *    карта (одновременные повторы одного requestId ждут первый результат);
 *  - неизвестный type → ERROR{VALIDATION} БЕЗ разрыва соединения;
 *  - rate limit: token bucket per connection (limits.wsRatePerConnection) →
 *    ERROR{RATE_LIMIT}, соединение живо;
 *  - ошибки команд → ERROR{code} инициатору (SENDER_ONLY) с requestId;
 *  - transport-ошибки (RATE_LIMIT, парсинг) в dedupe-кэш НЕ кладутся: их можно
 *    повторить; доменные результаты (ack И доменная ошибка) — кладутся.
 */

export interface WsConnectionState {
  readonly connectionId: ConnectionId;
  readonly ip: string;
  readonly socket: WebSocket;
  auth: WsIdentity | null;
  readonly rate: ConnectionRateLimiter;
}

export interface RouterHooks {
  /** AUTH{token} в окне неаутентифицированного соединения (server.ts). */
  onAuth(state: WsConnectionState, token: string): Promise<void>;
  /** LEAVE: закрыть сокет после leaveSession (server.ts владеет lifecycle). */
  onLeave(state: WsConnectionState): void;
}

export interface WsRouter {
  handle(state: WsConnectionState, data: string | Buffer): Promise<void>;
  readonly dedupe: RequestDedupeCache<ServerEnvelope>;
}

const MESSAGE_MAX = 500;
const ISSUE_MAX = 10;
const ISSUE_MESSAGE_MAX = 80;

/** Копия HTTP-хелпера (D258-контекст): значения полей не раскрываем (D163). */
function zodIssuesToMeta(error: ZodError): Record<string, unknown> {
  return {
    issues: error.issues.slice(0, ISSUE_MAX).map((issue) => ({
      path: issue.path.join('.'),
      code: issue.code,
      message: issue.message.slice(0, ISSUE_MESSAGE_MAX),
    })),
  };
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

interface CommandResult {
  readonly envelopes: ServerEnvelope[];
  /** Побочные эффекты ПОСЛЕ отправки ответов (kick: закрыть соединения цели). */
  readonly sideEffects?: Array<() => void>;
}

export function createWsRouter(input: {
  deps: WsGatewayDeps;
  registry: ConnectionRegistry;
  broadcaster: WsBroadcaster;
  hooks: RouterHooks;
  logger?: WsGatewayLog;
}): WsRouter {
  const { deps, registry, broadcaster, hooks, logger } = input;
  const dedupe = new RequestDedupeCache<ServerEnvelope>(deps.limits.dedupeTtlMs);
  const inFlight = new Map<string, Promise<CommandResult>>();

  const target = (state: WsConnectionState) => ({ kind: 'connection', connectionId: state.connectionId }) as const;

  function respond(state: WsConnectionState, envelope: ServerEnvelope): void {
    const extra: { requestId?: string; sessionId?: SessionId } = {};
    if (envelope.requestId !== undefined) extra.requestId = envelope.requestId;
    if (envelope.sessionId !== undefined) extra.sessionId = envelope.sessionId;
    // До аутентификации записи в реестре нет — ответ уходит напрямую в сокет
    // (окно AUTH, D267). После — обычная доставка SENDER_ONLY/GM_ONLY.
    if (registry.get(state.connectionId) === undefined) {
      broadcaster.sendDirect(state.socket, envelope.type, envelope.payload, extra);
      return;
    }
    broadcaster.send(envelope.type, envelope.payload, target(state), extra);
  }

  function errorEnvelope(
    state: WsConnectionState,
    code: ErrorCode,
    message: string,
    requestId: string | null,
    meta?: Record<string, unknown>,
  ): ServerEnvelope {
    return {
      type: 'ERROR',
      payload: {
        code,
        message: message.slice(0, MESSAGE_MAX),
        ...(meta === undefined ? {} : { meta }),
        requestId,
      },
      requestId: requestId ?? undefined,
      sessionId: state.auth?.sessionId,
    };
  }

  function ackEnvelope(
    state: WsConnectionState,
    type: 'GM_ACTION_ACK',
    action: string,
    meta: Record<string, unknown>,
    requestId?: string,
  ): ServerEnvelope {
    return {
      type,
      payload: { action, ok: true, meta },
      requestId,
      sessionId: state.auth?.sessionId,
    };
  }

  function authOf(state: WsConnectionState): WsIdentity {
    if (state.auth === null) {
      throw new AppError('AUTH_INVALID', 'соединение не аутентифицировано — сначала AUTH', { reason: 'no_auth' });
    }
    return state.auth;
  }

  function assertSameSession(state: WsConnectionState, sessionId: SessionId): void {
    const auth = authOf(state);
    if (auth.sessionId !== sessionId) {
      throw new AppError('AUTH_FORBIDDEN', 'сессия не совпадает с сессией токена', { reason: 'session_mismatch' });
    }
  }

  function requestIdOf(message: { requestId?: string }, payload: { requestId?: string }): string | undefined {
    return payload.requestId ?? message.requestId;
  }

  // ------------------------------------------------------------ исполнители

  async function execute(
    state: WsConnectionState,
    message: { type: WSClientType; payload: Record<string, unknown>; requestId?: string; sessionId?: SessionId },
    traceId: string,
  ): Promise<CommandResult> {
    const auth = authOf(state);
    const p = message.payload as never;
    // Единый echo-requestId для всех ответов (F-6.7: клиент связывает ack с запросом).
    const requestId = (message.payload as { requestId?: string }).requestId ?? message.requestId;
    switch (message.type) {
      case 'SUBSCRIBE': {
        const payload = p as { sessionId: SessionId };
        assertSameSession(state, payload.sessionId);
        const record = registry.get(state.connectionId);
        if (record !== undefined) record.subscribedAt = new Date().toISOString();
        return one({
          type: 'SUBSCRIBED',
          payload: { sessionId: payload.sessionId },
          requestId,
          sessionId: auth.sessionId,
        });
      }
      case 'UNSUBSCRIBE': {
        const payload = p as { sessionId: SessionId };
        assertSameSession(state, payload.sessionId);
        // Серверного типа UNSUBSCRIBED в протоколе нет; этап 1 — одна сессия на
        // соединение (токен), отписка фактически = LEAVE/close. Молчаливый no-op.
        logger?.debug({ sessionId: payload.sessionId, event: 'ws_unsubscribe_noop' }, 'ws_unsubscribe_noop');
        return { envelopes: [] };
      }
      case 'PING':
        return one({ type: 'PONG', payload: {} });
      case 'ACTION_SUBMIT': {
        const payload = p as {
          turnId: TurnId;
          rawText: string;
          meta?: Record<string, unknown>;
          idempotencyKey: string;
          requestId: string;
        };
        const submitted = await deps.turns.submitAction({
          turnId: payload.turnId,
          playerId: auth.playerId,
          rawText: payload.rawText,
          ...(payload.meta === undefined ? {} : { meta: payload.meta as never }),
          idempotencyKey: payload.idempotencyKey,
          traceId,
        });
        return one({
          type: 'ACTION_ACK',
          payload: {
            requestId: payload.requestId,
            actionId: submitted.actionId,
            sequenceId: submitted.sequenceId,
            turnId: payload.turnId,
          },
          requestId: payload.requestId,
          sessionId: auth.sessionId,
        });
      }
      case 'CHAT_PUBLIC': {
        const payload = p as { text: string; requestId: string };
        const sent = await deps.chat.sendPublicMessage({
          sessionId: auth.sessionId,
          playerId: auth.playerId,
          text: payload.text,
          idempotencyKey: `ws-chat-public:${auth.playerId}:${payload.requestId}`,
          traceId,
        });
        return one({
          type: 'CHAT_ACK',
          payload: { requestId: payload.requestId, messageId: sent.messageId, sequenceHint: sent.sequenceId },
          requestId: payload.requestId,
          sessionId: auth.sessionId,
        });
      }
      case 'CHAT_PRIVATE': {
        const payload = p as { toPlayerId: PlayerId; text: string; requestId: string };
        const sent = await deps.chat.sendPrivateMessage({
          sessionId: auth.sessionId,
          fromPlayerId: auth.playerId,
          toPlayerId: payload.toPlayerId,
          text: payload.text,
          idempotencyKey: `ws-chat-private:${auth.playerId}:${payload.requestId}`,
          traceId,
        });
        return one({
          type: 'CHAT_ACK',
          payload: { requestId: payload.requestId, messageId: sent.messageId, sequenceHint: sent.sequenceId },
          requestId: payload.requestId,
          sessionId: auth.sessionId,
        });
      }
      case 'HISTORY': {
        const payload = p as { sessionId: SessionId; since?: string; limit?: number; requestId?: string };
        assertSameSession(state, payload.sessionId);
        const limit = payload.limit ?? 200;
        const messages = await deps.chat.history({
          sessionId: payload.sessionId,
          playerId: auth.playerId,
          ...(payload.since === undefined ? {} : { since: payload.since }),
          limit,
        });
        return one({
          type: 'HISTORY_RESULT',
          payload: { sessionId: payload.sessionId, messages, hasMore: messages.length >= limit },
          requestId: payload.requestId,
          sessionId: auth.sessionId,
        });
      }
      case 'LEAVE': {
        await deps.sessions.leaveSession({
          sessionId: auth.sessionId,
          playerId: auth.playerId,
          // Детерминированный ключ (D256-прецедент): повторный leave — replay.
          idempotencyKey: `leave:${auth.sessionId}:${auth.playerId}`,
          traceId,
        });
        return { envelopes: [], sideEffects: [() => hooks.onLeave(state)] };
      }
      // --- GM: сессия --------------------------------------------------------
      case 'GM_OPEN_TURN': {
        const payload = p as { sessionId: SessionId; idempotencyKey: string };
        assertSameSession(state, payload.sessionId);
        const opened = await deps.gm.openTurn({
          sessionId: payload.sessionId,
          gmPlayerId: auth.playerId,
          idempotencyKey: payload.idempotencyKey,
          traceId,
        });
        return one(
          ackEnvelope(
            state,
            'GM_ACTION_ACK',
            'openTurn',
            { turnId: opened.turnId, number: opened.number, replayed: opened.replayed },
            requestId,
          ),
        );
      }
      case 'GM_PAUSE': {
        const payload = p as { sessionId: SessionId; idempotencyKey: string };
        assertSameSession(state, payload.sessionId);
        const paused = await deps.gm.pauseSession({
          sessionId: payload.sessionId,
          gmPlayerId: auth.playerId,
          idempotencyKey: payload.idempotencyKey,
          traceId,
        });
        return one(
          ackEnvelope(state, 'GM_ACTION_ACK', 'pause', { status: paused.status, replayed: paused.replayed }, requestId),
        );
      }
      case 'GM_RESUME': {
        const payload = p as { sessionId: SessionId; idempotencyKey: string };
        assertSameSession(state, payload.sessionId);
        const resumed = await deps.gm.resumeSession({
          sessionId: payload.sessionId,
          gmPlayerId: auth.playerId,
          idempotencyKey: payload.idempotencyKey,
          traceId,
        });
        return one(
          ackEnvelope(
            state,
            'GM_ACTION_ACK',
            'resume',
            { status: resumed.status, replayed: resumed.replayed },
            requestId,
          ),
        );
      }
      case 'GM_END_SESSION': {
        const payload = p as { sessionId: SessionId; idempotencyKey: string };
        assertSameSession(state, payload.sessionId);
        const ended = await deps.gm.endSession({
          sessionId: payload.sessionId,
          gmPlayerId: auth.playerId,
          reason: 'сессия завершена ведущим через WS',
          idempotencyKey: payload.idempotencyKey,
          traceId,
        });
        return one(
          ackEnvelope(state, 'GM_ACTION_ACK', 'end', { status: ended.status, replayed: ended.replayed }, requestId),
        );
      }
      case 'GM_MOVE_GROUP': {
        const payload = p as {
          sessionId: SessionId;
          playerIds: PlayerId[];
          toLocationId: string;
          idempotencyKey: string;
        };
        assertSameSession(state, payload.sessionId);
        const moved = await deps.gm.moveGroup({
          sessionId: payload.sessionId,
          gmPlayerId: auth.playerId,
          playerIds: payload.playerIds,
          toLocationId: payload.toLocationId,
          idempotencyKey: payload.idempotencyKey,
          traceId,
        });
        return one(
          ackEnvelope(
            state,
            'GM_ACTION_ACK',
            'moveGroup',
            { version: moved.version, replayed: moved.replayed },
            requestId,
          ),
        );
      }
      case 'GM_KICK_PLAYER': {
        const payload = p as { sessionId: SessionId; playerId: PlayerId };
        assertSameSession(state, payload.sessionId);
        const kicked = await deps.gm.kickPlayer({
          sessionId: payload.sessionId,
          gmPlayerId: auth.playerId,
          playerId: payload.playerId,
          idempotencyKey: `kick:${payload.sessionId}:${payload.playerId}`,
          traceId,
        });
        // D275: соединения исключённого закрываются 4403 (токен уже отозван).
        return {
          envelopes: [
            ackEnvelope(
              state,
              'GM_ACTION_ACK',
              'kick',
              { playerId: payload.playerId, replayed: kicked.replayed },
              requestId,
            ),
          ],
          sideEffects: [
            () => {
              for (const record of registry.listByPlayer(payload.playerId)) {
                closeWithCode(
                  record.socket,
                  4403,
                  { code: 'AUTH_FORBIDDEN', message: 'вы исключены из партии' },
                  logger,
                );
              }
            },
          ],
        };
      }
      case 'GM_SYSTEM_MESSAGE': {
        const payload = p as { sessionId: SessionId; text: string; requestId?: string };
        assertSameSession(state, payload.sessionId);
        const sent = await deps.gm.sendSystemMessage({
          sessionId: payload.sessionId,
          gmPlayerId: auth.playerId,
          text: payload.text,
          // requestId есть — детерминированный ключ; нет — уникальный (B-08).
          idempotencyKey:
            payload.requestId === undefined
              ? `gm-sysmsg:${randomUUID()}`
              : `gm-sysmsg:${payload.sessionId}:${payload.requestId}`,
          traceId,
        });
        return one(
          ackEnvelope(
            state,
            'GM_ACTION_ACK',
            'systemMessage',
            { messageId: sent.messageId, replayed: sent.replayed },
            requestId,
          ),
        );
      }
      case 'GM_ADD_NOTE': {
        const payload = p as {
          sessionId: SessionId;
          turnId?: TurnId | null;
          visibility: string;
          text: string;
          requestId?: string;
        };
        assertSameSession(state, payload.sessionId);
        const added = await deps.gm.addNote({
          sessionId: payload.sessionId,
          gmPlayerId: auth.playerId,
          turnId: payload.turnId ?? null,
          visibility: payload.visibility,
          text: payload.text,
          // Детерминированный ключ из содержимого (как HTTP, D256): повтор — replay.
          idempotencyKey: `gm-note:${sha1(
            `${payload.sessionId}:${auth.playerId}:${payload.visibility}:${payload.turnId ?? ''}:${payload.text}`,
          )}`,
          traceId,
        });
        return one({
          type: 'GM_NOTE_ACK',
          payload: { noteId: added.noteId as NoteId },
          requestId,
          sessionId: auth.sessionId,
        });
      }
      case 'GM_SET_FLAG': {
        const payload = p as {
          sessionId: SessionId;
          key: string;
          value: string | number | boolean;
          idempotencyKey: string;
        };
        assertSameSession(state, payload.sessionId);
        const flagged = await deps.story.setFlag({
          sessionId: payload.sessionId,
          key: payload.key as FlagKey,
          value: payload.value,
          setBy: 'GM',
          traceId,
        });
        return one(
          ackEnvelope(state, 'GM_ACTION_ACK', 'setFlag', { version: flagged.version, key: payload.key }, requestId),
        );
      }
      case 'GM_SET_NAME_REMEMBERED': {
        const payload = p as { sessionId: SessionId; playerId: PlayerId; remembered: boolean; idempotencyKey: string };
        assertSameSession(state, payload.sessionId);
        // D173: имя под затвором флага remembered_name.<playerId>.
        const flagged = await deps.story.setFlag({
          sessionId: payload.sessionId,
          key: `remembered_name.${payload.playerId}` as FlagKey,
          value: payload.remembered,
          setBy: 'GM',
          traceId,
        });
        return one(
          ackEnvelope(
            state,
            'GM_ACTION_ACK',
            'setNameRemembered',
            { version: flagged.version, playerId: payload.playerId },
            requestId,
          ),
        );
      }
      // --- GM: ход -----------------------------------------------------------
      case 'GM_LOCK_TURN': {
        const payload = p as { turnId: TurnId; idempotencyKey: string };
        const locked = await deps.gm.lockTurn({
          turnId: payload.turnId,
          gmPlayerId: auth.playerId,
          idempotencyKey: payload.idempotencyKey,
          traceId,
        });
        return one(
          ackEnvelope(
            state,
            'GM_ACTION_ACK',
            'lockTurn',
            { turnId: locked.turnId, replayed: locked.replayed },
            requestId,
          ),
        );
      }
      case 'GM_UNLOCK_TURN': {
        const payload = p as { turnId: TurnId; idempotencyKey: string };
        const unlocked = await deps.gm.unlockTurn({
          turnId: payload.turnId,
          gmPlayerId: auth.playerId,
          idempotencyKey: payload.idempotencyKey,
          traceId,
        });
        return one(
          ackEnvelope(
            state,
            'GM_ACTION_ACK',
            'unlockTurn',
            { turnId: unlocked.turnId, replayed: unlocked.replayed },
            requestId,
          ),
        );
      }
      case 'GM_COMMIT_TURN': {
        const payload = p as { turnId: TurnId; idempotencyKey: string };
        const committed = await deps.gmReview.approve({
          turnId: payload.turnId,
          gmPlayerId: auth.playerId,
          idempotencyKey: payload.idempotencyKey,
          traceId,
        });
        return one(
          ackEnvelope(
            state,
            'GM_ACTION_ACK',
            'commitTurn',
            { turnId: committed.turnId, version: committed.version, replayed: committed.replayed },
            requestId,
          ),
        );
      }
      case 'GM_EDIT_APPROVE': {
        const payload = p as {
          turnId: TurnId;
          editedResolution: unknown;
          baseResolutionHash: string;
          idempotencyKey: string;
        };
        const edited = await deps.gmReview.editAndApprove({
          turnId: payload.turnId,
          gmPlayerId: auth.playerId,
          editedResolution: payload.editedResolution,
          baseResolutionHash: payload.baseResolutionHash,
          idempotencyKey: payload.idempotencyKey,
          traceId,
        });
        return one(
          ackEnvelope(
            state,
            'GM_ACTION_ACK',
            'editAndApprove',
            { turnId: edited.turnId, version: edited.version, replayed: edited.replayed },
            requestId,
          ),
        );
      }
      case 'GM_REJECT_TURN': {
        const payload = p as { turnId: TurnId; reason: string; idempotencyKey: string };
        const rejected = await deps.gmReview.reject({
          turnId: payload.turnId,
          gmPlayerId: auth.playerId,
          reason: payload.reason,
          idempotencyKey: payload.idempotencyKey,
          traceId,
        });
        return one(
          ackEnvelope(
            state,
            'GM_ACTION_ACK',
            'rejectTurn',
            { turnId: rejected.turnId, status: rejected.status, replayed: rejected.replayed },
            requestId,
          ),
        );
      }
      case 'GM_RETRY_AI': {
        const payload = p as { turnId: TurnId; idempotencyKey: string };
        const retried = await deps.gmReview.retry({
          turnId: payload.turnId,
          gmPlayerId: auth.playerId,
          idempotencyKey: payload.idempotencyKey,
          traceId,
        });
        return one(
          ackEnvelope(
            state,
            'GM_ACTION_ACK',
            'retryAi',
            {
              turnId: retried.turnId,
              status: retried.status,
              createdNewTurn: retried.createdNewTurn,
              replayed: retried.replayed,
            },
            requestId,
          ),
        );
      }
      case 'GM_ACTIVATE_EVENT': {
        const payload = p as { eventId: string; turnId: TurnId; idempotencyKey: string };
        void payload.turnId; // Event Engine (этап 2) примет turnId; сейчас ключ обязателен.
        // Этап 2 (промпт 2.1): модуль gm бросит честный NOT_IMPLEMENTED.
        await deps.gm.activateEvent({
          sessionId: auth.sessionId,
          gmPlayerId: auth.playerId,
          eventId: payload.eventId,
          idempotencyKey: payload.idempotencyKey,
          traceId,
        });
        return { envelopes: [] };
      }
      case 'GM_REQUEST_SCENE':
        // D274: media-контур — этап 2 (промпты 2.10–2.12).
        throw new AppError('NOT_IMPLEMENTED', 'GM_REQUEST_SCENE появится на этапе 2 (media-director)', {
          reason: 'stage2',
        });
      case 'GM_CANCEL_MEDIA_JOB':
        throw new AppError('NOT_IMPLEMENTED', 'GM_CANCEL_MEDIA_JOB появится на этапе 2 (media-director)', {
          reason: 'stage2',
        });
      case 'AUTH':
        // AUTH обрабатывается server.ts до роутера (меняет состояние соединения).
        throw new AppError('VALIDATION', 'AUTH допустим только до аутентификации', { reason: 'already_authed' });
      default: {
        const exhaustive: never = message.type;
        throw new AppError('NOT_IMPLEMENTED', `команда ${String(exhaustive)} не поддерживается`, {
          reason: 'unsupported',
        });
      }
    }
  }

  function one(envelope: ServerEnvelope): CommandResult {
    return { envelopes: [envelope] };
  }

  // ------------------------------------------------------------------ handle

  async function handle(state: WsConnectionState, data: string | Buffer): Promise<void> {
    const traceId = randomUUID();
    let raw: unknown;
    try {
      raw = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
    } catch {
      respond(state, errorEnvelope(state, 'VALIDATION', 'ожидается JSON-объект', null));
      return;
    }

    const parsed = WSClientMessageSchema.safeParse(raw);
    if (!parsed.success) {
      const envelopeLike = (raw ?? {}) as { requestId?: unknown; type?: unknown };
      const requestId = typeof envelopeLike.requestId === 'string' ? envelopeLike.requestId : null;
      // Неизвестный type/битый payload → VALIDATION БЕЗ разрыва соединения.
      respond(
        state,
        errorEnvelope(
          state,
          'VALIDATION',
          'сообщение не прошло валидацию схемы',
          requestId,
          zodIssuesToMeta(parsed.error),
        ),
      );
      return;
    }
    const message = parsed.data as { type: WSClientType; payload: Record<string, unknown>; requestId?: string };
    const payloadRecord = message.payload as { requestId?: string };
    const requestId = requestIdOf(message, payloadRecord);

    // Rate limit per connection (transport-слой, до дедупликации и команд).
    if (!state.rate.tryConsume(message.type)) {
      respond(
        state,
        errorEnvelope(state, 'RATE_LIMIT', 'превышен лимит сообщений — повторите позже', requestId ?? null, {
          retryAfterSeconds: 1,
        }),
      );
      return;
    }

    // AUTH — единственная команда неаутентифицированного соединения.
    if (state.auth === null) {
      if (message.type === 'AUTH') {
        const payload = message.payload as { token: string };
        await hooks.onAuth(state, payload.token);
        return;
      }
      respond(state, errorEnvelope(state, 'AUTH_INVALID', 'соединение не аутентифицировано', requestId ?? null));
      return;
    }

    // GM-гейт (WS_GM_ONLY — данные contracts, не хардкод).
    if ((WS_GM_ONLY as readonly string[]).includes(message.type) && !state.auth.isGM) {
      respond(state, errorEnvelope(state, 'AUTH_FORBIDDEN', 'команда доступна только ведущему', requestId ?? null));
      return;
    }

    // B-08: обязательный idempotencyKey (схемы уже требуют; здесь — защита
    // каталогом WS_REQUIRES_IDEMPOTENCY_KEY на случай расхождения схем).
    if (
      (WS_REQUIRES_IDEMPOTENCY_KEY as readonly string[]).includes(message.type) &&
      typeof (message.payload as { idempotencyKey?: unknown }).idempotencyKey !== 'string'
    ) {
      respond(state, errorEnvelope(state, 'VALIDATION', 'требуется idempotencyKey', requestId ?? null));
      return;
    }

    // Дедупликация по requestId (F-6.7) + in-flight-коалесценция повторов.
    const dedupeKey = requestId === undefined ? undefined : RequestDedupeCache.key(state.auth.playerId, requestId);
    if (dedupeKey !== undefined) {
      const cached = dedupe.get(dedupeKey);
      if (cached !== undefined) {
        respond(state, cached);
        return;
      }
      const running = inFlight.get(dedupeKey);
      if (running !== undefined) {
        const result = await running;
        for (const envelope of result.envelopes) respond(state, envelope);
        for (const sideEffect of result.sideEffects ?? []) sideEffect();
        return;
      }
    }

    const execution = (async (): Promise<CommandResult> => {
      try {
        return await execute(state, message, traceId);
      } catch (cause) {
        return { envelopes: [toErrorEnvelope(state, cause, requestId ?? null)] };
      }
    })();

    if (dedupeKey !== undefined) {
      inFlight.set(dedupeKey, execution);
    }
    try {
      const result = await execution;
      if (dedupeKey !== undefined) {
        for (const envelope of result.envelopes) dedupe.set(dedupeKey, envelope);
      }
      for (const envelope of result.envelopes) respond(state, envelope);
      for (const sideEffect of result.sideEffects ?? []) sideEffect();
    } finally {
      if (dedupeKey !== undefined) inFlight.delete(dedupeKey);
    }
  }

  function toErrorEnvelope(state: WsConnectionState, cause: unknown, requestId: string | null): ServerEnvelope {
    if (cause instanceof ZodError) {
      return errorEnvelope(state, 'VALIDATION', 'данные не прошли валидацию схемы', requestId, zodIssuesToMeta(cause));
    }
    if (cause instanceof AppError) {
      const meta = Object.keys(cause.meta).length > 0 ? (cause.meta as Record<string, unknown>) : undefined;
      return errorEnvelope(state, cause.code, cause.message, requestId, meta);
    }
    logger?.error({ err: cause, requestId, event: 'ws_command_failed' }, 'ws_command_failed');
    return errorEnvelope(state, 'INTERNAL', 'внутренняя ошибка сервера', requestId);
  }

  return { handle, dedupe };
}
