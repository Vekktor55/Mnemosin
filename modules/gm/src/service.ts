import {
  AppError,
  CoreError,
  IdempotencyKey as IdempotencyKeySchema,
  LocationId,
  type GmActionKind,
  type IdempotencyKey,
  type PlayerId,
  type SessionId,
  type TurnId,
  type TurnStatus,
} from '@mnemosin/contracts';
import { appendOutbox, createEvent, newTraceId, type TxScope } from '@mnemosin/core';

import {
  ActivateEventInputSchema,
  CancelTurnInputSchema,
  EndSessionInputSchema,
  KickPlayerInputSchema,
  LockTurnInputSchema,
  MoveGroupInputSchema,
  OpenTurnInputSchema,
  PauseSessionInputSchema,
  ResumeSessionInputSchema,
  SendSystemMessageInputSchema,
  StartSessionInputSchema,
  UnlockTurnInputSchema,
  type ActivateEventInput,
  type AddNoteInput,
  type AddNoteOutput,
  type CancelTurnInput,
  type EndSessionInput,
  type KickPlayerInput,
  type LockTurnInput,
  type MoveGroupInput,
  type MoveGroupOutput,
  type OpenTurnInput,
  type PauseSessionInput,
  type ResumeSessionInput,
  type SendSystemMessageInput,
  type SendSystemMessageOutput,
  type SessionStatusOutput,
  type StartSessionInput,
  type StartSessionOutput,
  type TurnRefOutput,
  type UnlockTurnInput,
} from './contract.js';
import type { GmServiceDeps } from './deps.js';
import { systemMessageIdFromKey } from './ids.js';
import { addNote, onTurnCommittedNotes } from './notes.js';
import { inspectAIContext, inspectJournal, inspectState, listAudit } from './inspect.js';
import { assertGmPlayer } from './access.js';
import type { DomainEvent } from '@mnemosin/contracts';
import type { InspectAIContextInput, InspectJournalInput, InspectStateInput, ListAuditInput } from './contract.js';

/**
 * GmService — пульт ведущего (v3 §IV.8; промпт 1.9, п.4; аудит §8.5).
 *
 * Команды жизненного цикла — тонкие обёртки доменных сервисов core (1.6):
 * внешняя транзакция обёртки JOIN'ит внутреннюю транзакцию core-команды (ALS),
 * поэтому GM_ACTION_PERFORMED попадает в outbox АТОМАРНО с основным действием;
 * при replay (повтор клиентского ключа) аудит-событие НЕ дублируется (D249).
 *
 * Роль GM проверяет транспорт (WS_GM_ONLY/HTTP, 1.10–1.11); сервис проверяет,
 * что gmPlayerId — участник сессии с isGM=true (защита в глубине, B-12).
 * finishTurn ОТСУТСТВУЕТ (D119/B-09 — владелец перехода gm-review).
 */

interface CommandOutcome<T> {
  readonly value: T;
  readonly replayed: boolean;
  readonly meta: Record<string, unknown>;
}

export class GmService {
  constructor(private readonly deps: GmServiceDeps) {}

  // -------------------------------------------------- жизненный цикл сессии

  async startSession(input: StartSessionInput): Promise<StartSessionOutput> {
    const parsed = StartSessionInputSchema.parse(input);
    const traceId = parsed.traceId ?? newTraceId();
    return this.withAudit(
      parsed.sessionId,
      parsed.gmPlayerId,
      'startSession',
      parsed.idempotencyKey,
      traceId,
      async () => {
        const result = await this.deps.services.sessions.startSession({
          sessionId: parsed.sessionId,
          idempotencyKey: parsed.idempotencyKey,
          traceId,
        });
        return {
          value: {
            sessionId: result.sessionId,
            turnId: result.turnId,
            turnNumber: result.turnNumber,
            replayed: result.replayed,
          },
          replayed: result.replayed,
          meta: { turnId: result.turnId },
        };
      },
    );
  }

  async pauseSession(input: PauseSessionInput): Promise<SessionStatusOutput> {
    const parsed = PauseSessionInputSchema.parse(input);
    return this.sessionStatusCommand(parsed, 'pauseSession');
  }

  async resumeSession(input: ResumeSessionInput): Promise<SessionStatusOutput> {
    const parsed = ResumeSessionInputSchema.parse(input);
    return this.sessionStatusCommand(parsed, 'resumeSession');
  }

  async endSession(input: EndSessionInput): Promise<SessionStatusOutput> {
    const parsed = EndSessionInputSchema.parse(input);
    const traceId = parsed.traceId ?? newTraceId();
    return this.withAudit(
      parsed.sessionId,
      parsed.gmPlayerId,
      'endSession',
      parsed.idempotencyKey,
      traceId,
      async () => {
        const result = await this.deps.services.sessions.endSession({
          sessionId: parsed.sessionId,
          reason: parsed.reason,
          idempotencyKey: parsed.idempotencyKey,
          traceId,
        });
        return {
          value: { sessionId: result.sessionId, status: result.status, replayed: result.replayed },
          replayed: result.replayed,
          meta: { reason: parsed.reason },
        };
      },
    );
  }

  async kickPlayer(input: KickPlayerInput): Promise<SessionStatusOutput> {
    const parsed = KickPlayerInputSchema.parse(input);
    const traceId = parsed.traceId ?? newTraceId();
    return this.withAudit(
      parsed.sessionId,
      parsed.gmPlayerId,
      'kickPlayer',
      parsed.idempotencyKey,
      traceId,
      async () => {
        const result = await this.deps.services.sessions.removePlayer({
          sessionId: parsed.sessionId,
          playerId: parsed.playerId,
          idempotencyKey: parsed.idempotencyKey,
          traceId,
        });
        return {
          value: { sessionId: parsed.sessionId, status: 'ACTIVE' as const, replayed: result.replayed },
          replayed: result.replayed,
          meta: { playerId: parsed.playerId, playerStatus: result.status },
        };
      },
    );
  }

  // -------------------------------------------------- жизненный цикл хода

  async openTurn(input: OpenTurnInput): Promise<TurnRefOutput> {
    const parsed = OpenTurnInputSchema.parse(input);
    const traceId = parsed.traceId ?? newTraceId();
    return this.withAudit(parsed.sessionId, parsed.gmPlayerId, 'openTurn', parsed.idempotencyKey, traceId, async () => {
      const result = await this.deps.services.turns.openTurn({
        sessionId: parsed.sessionId,
        idempotencyKey: parsed.idempotencyKey,
        traceId,
      });
      return { value: this.turnRef(result), replayed: result.replayed, meta: { turnId: result.turnId } };
    });
  }

  async lockTurn(input: LockTurnInput): Promise<TurnRefOutput> {
    const parsed = LockTurnInputSchema.parse(input);
    const traceId = parsed.traceId ?? newTraceId();
    const result = await this.turnCommand(parsed, 'lockTurn', (commandTraceId) =>
      this.deps.services.turns.lockTurn({
        turnId: parsed.turnId,
        idempotencyKey: parsed.idempotencyKey,
        traceId: commandTraceId,
      }),
    );
    // D253: «замок закрыт — запускай обработку» (wiring передаёт turn.resolveTurn).
    // Fire-and-forget: HTTP-ответ не ждёт AI; сбой resolve — TURN_FAILED событием.
    if (!result.replayed && this.deps.afterLock !== undefined) {
      try {
        this.deps.afterLock({ turnId: result.turnId, sessionId: result.sessionId, traceId });
      } catch (cause) {
        this.deps.logger?.error(
          { err: cause, turnId: result.turnId, event: 'after_lock_hook_failed' },
          'after_lock_hook_failed',
        );
      }
    }
    return result;
  }

  async unlockTurn(input: UnlockTurnInput): Promise<TurnRefOutput> {
    const parsed = UnlockTurnInputSchema.parse(input);
    return this.turnCommand(parsed, 'unlockTurn', (traceId) =>
      this.deps.services.turns.unlockTurn({ turnId: parsed.turnId, idempotencyKey: parsed.idempotencyKey, traceId }),
    );
  }

  async cancelTurn(input: CancelTurnInput): Promise<TurnRefOutput> {
    const parsed = CancelTurnInputSchema.parse(input);
    return this.turnCommand(
      parsed,
      'cancelTurn',
      (traceId) =>
        this.deps.services.turns.cancelTurn({
          turnId: parsed.turnId,
          reason: parsed.reason,
          idempotencyKey: parsed.idempotencyKey,
          traceId,
        }),
      { reason: parsed.reason },
    );
  }

  async moveGroup(input: MoveGroupInput): Promise<MoveGroupOutput> {
    const parsed = MoveGroupInputSchema.parse(input);
    const traceId = parsed.traceId ?? newTraceId();
    const toLocationId = LocationId.parse(parsed.toLocationId);
    const turnId: TurnId | null = parsed.turnId ?? null;
    return this.withAudit(
      parsed.sessionId,
      parsed.gmPlayerId,
      'moveGroup',
      parsed.idempotencyKey ?? `gm-move:${traceId}`,
      traceId,
      async () => {
        const result = await this.deps.services.locations.moveGroup({
          sessionId: parsed.sessionId,
          playerIds: parsed.playerIds,
          toLocationId,
          ...(turnId === null ? {} : { turnId }),
          ...(parsed.idempotencyKey === undefined ? {} : { idempotencyKey: parsed.idempotencyKey }),
          traceId,
        });
        return {
          value: { sessionId: parsed.sessionId, version: result.version, replayed: result.replayed },
          replayed: result.replayed,
          // LOCATION_CHANGED пишет ядро (D249): в аудит — состав без текста.
          meta: { toLocationId, players: parsed.playerIds.length, fromLocationId: result.fromLocationId },
        };
      },
    );
  }

  // -------------------------------------------------- сообщения и заметки

  async sendSystemMessage(input: SendSystemMessageInput): Promise<SendSystemMessageOutput> {
    const parsed = SendSystemMessageInputSchema.parse(input);
    const traceId = parsed.traceId ?? newTraceId();
    const turnId: TurnId | null = parsed.turnId ?? null;
    // Дедупликация: messageId детерминирован из клиентского ключа — повтор
    // ключа не создаёт второе сообщение (chat.post вернёт replayed).
    const messageId = systemMessageIdFromKey(String(parsed.idempotencyKey));
    return this.withAudit(
      parsed.sessionId,
      parsed.gmPlayerId,
      'sendSystemMessage',
      parsed.idempotencyKey,
      traceId,
      async () => {
        const sent = await this.deps.chat.sendSystemMessage({
          sessionId: parsed.sessionId,
          text: parsed.text,
          turnId,
          messageId,
          traceId,
        });
        return {
          value: { messageId: sent.messageId, replayed: sent.replayed },
          replayed: sent.replayed,
          meta: { messageId: sent.messageId },
        };
      },
    );
  }

  async addNote(input: AddNoteInput): Promise<AddNoteOutput> {
    return addNote(this.deps, input);
  }

  /** Этап 2 (промпт 2.1): Event DSL. Сейчас — честная заглушка NOT_IMPLEMENTED. */
  async activateEvent(input: ActivateEventInput): Promise<never> {
    const parsed = ActivateEventInputSchema.parse(input);
    await this.assertGm(parsed.sessionId, parsed.gmPlayerId);
    throw new AppError('NOT_IMPLEMENTED', 'activateEvent появится с Event Engine (промпт 2.1)', {
      action: 'activateEvent',
      eventId: parsed.eventId,
    });
  }

  // ---------------------------------------------------------------- инспекция

  inspectState(input: InspectStateInput) {
    return inspectState(this.deps, input);
  }

  inspectAIContext(input: InspectAIContextInput) {
    return inspectAIContext(this.deps, input);
  }

  inspectJournal(input: InspectJournalInput) {
    return inspectJournal(this.deps, input);
  }

  listAudit(input: ListAuditInput) {
    return listAudit(this.deps, input);
  }

  /**
   * TURN_COMMITTED → публикация заметок PUBLIC_AFTER_COMMIT в чат (F-3.8).
   * Boot-подписка — apps/server/modules-registry.ts.
   */
  onTurnCommitted(event: DomainEvent): Promise<void> {
    return onTurnCommittedNotes(this.deps, event);
  }

  // ---------------------------------------------------------------- внутреннее

  /**
   * Обёртка «действие + аудит одной транзакцией» (D249): внешняя транзакция
   * JOIN'ит внутреннюю (ALS), GM_ACTION_PERFORMED уходит в outbox атомарно
   * с действием; replay действия НЕ дублирует событие.
   */
  private async withAudit<T>(
    sessionId: SessionId,
    gmPlayerId: PlayerId,
    action: GmActionKind,
    idempotencyKey: string,
    traceId: string,
    work: () => Promise<CommandOutcome<T>>,
  ): Promise<T> {
    await this.assertGm(sessionId, gmPlayerId);
    return this.deps.uow.runInTx(async (scope: TxScope) => {
      const outcome = await work();
      if (!outcome.replayed) {
        const parsedKey = IdempotencyKeySchema.safeParse(idempotencyKey);
        await appendOutbox(
          [
            createEvent(
              'GM_ACTION_PERFORMED',
              {
                sessionId,
                gmPlayerId,
                action,
                meta: outcome.meta,
                idempotencyKey: parsedKey.success ? (parsedKey.data as IdempotencyKey) : null,
              },
              traceId,
            ),
          ],
          scope,
        );
      }
      this.deps.logger?.debug(
        { sessionId, action, replayed: outcome.replayed, traceId, event: 'gm_action' },
        'gm_action',
      );
      return outcome.value;
    });
  }

  private async sessionStatusCommand(
    parsed: PauseSessionInput | ResumeSessionInput,
    action: 'pauseSession' | 'resumeSession',
  ): Promise<SessionStatusOutput> {
    const traceId = parsed.traceId ?? newTraceId();
    return this.withAudit(parsed.sessionId, parsed.gmPlayerId, action, parsed.idempotencyKey, traceId, async () => {
      const result =
        action === 'pauseSession'
          ? await this.deps.services.sessions.pauseSession({
              sessionId: parsed.sessionId,
              idempotencyKey: parsed.idempotencyKey,
              traceId,
            })
          : await this.deps.services.sessions.resumeSession({
              sessionId: parsed.sessionId,
              idempotencyKey: parsed.idempotencyKey,
              traceId,
            });
      return {
        value: { sessionId: result.sessionId, status: result.status, replayed: result.replayed },
        replayed: result.replayed,
        meta: {},
      };
    });
  }

  private async turnCommand(
    parsed: LockTurnInput | UnlockTurnInput | CancelTurnInput,
    action: 'lockTurn' | 'unlockTurn' | 'cancelTurn',
    invoke: (
      traceId: string,
    ) => Promise<{ turnId: TurnId; sessionId: SessionId; number: number; status: TurnStatus; replayed: boolean }>,
    meta: Record<string, unknown> = {},
  ): Promise<TurnRefOutput> {
    const traceId = parsed.traceId ?? newTraceId();
    const turn = await this.deps.uow.repos().turns.findById(parsed.turnId);
    if (turn === null) {
      throw new CoreError('CORE_NOT_FOUND', `ход ${parsed.turnId} не найден`, { entity: 'turn' });
    }
    return this.withAudit(turn.sessionId, parsed.gmPlayerId, action, parsed.idempotencyKey, traceId, async () => {
      const result = await invoke(traceId);
      return { value: this.turnRef(result), replayed: result.replayed, meta: { ...meta, turnId: result.turnId } };
    });
  }

  private turnRef(result: {
    turnId: TurnId;
    sessionId: SessionId;
    number: number;
    status: TurnStatus;
    replayed: boolean;
  }): TurnRefOutput {
    return {
      turnId: result.turnId,
      sessionId: result.sessionId,
      number: result.number,
      status: result.status,
      replayed: result.replayed,
    };
  }

  /** gmPlayerId — участник сессии с isGM=true (защита в глубине, B-12). */
  private async assertGm(sessionId: SessionId, gmPlayerId: PlayerId): Promise<void> {
    await assertGmPlayer(this.deps.uow, sessionId, gmPlayerId);
  }
}
