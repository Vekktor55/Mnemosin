import { randomUUID } from 'node:crypto';

import {
  AppError,
  CoreError,
  PlayerActionSchema,
  TurnFailureSchema,
  TurnSchema,
  TurnViewSchema,
  nowIso,
  TURN_TRANSITION_TABLE,
  type ActionId,
  type ActionMeta,
  type IdempotencyKey,
  type PlayerId,
  type SessionId,
  type Turn,
  type TurnFailure,
  type TurnId,
  type TurnStatus,
  type TurnView,
} from '@mnemosin/contracts';
import { newTraceId, parseIdempotencyKey, runCommand } from '../domain/command.js';
import type { CommandRunner, TxScope, UnitOfWork } from '../domain/ports/index.js';
import { assertTransition, turnTransitionRow } from '../domain/transition.js';
import { appendOutbox, createEvent } from '../events/outbox.js';
import type { JournalService } from './journal.js';

/**
 * TurnService — команды хода (промпт 1.6; v3 §II.5, §III.1 шаги 1–6; критерий A1.6).
 *
 * Правила:
 *  - каждая мутирующая команда принимает idempotencyKey и оборачивается в
 *    `runCommand` (порт CommandRunner → IdempotencyService из 1.4, D216);
 *  - доменная мутация + журнал + appendOutbox — ОДНА транзакция (D113):
 *    откат ⇒ нет ни записей, ни событий;
 *  - статусы меняются только по `TURN_TRANSITIONS` (assertTransition); нарушение —
 *    `CoreError('CORE_INVALID_STATE_TRANSITION')` (B-07);
 *  - переход, у которого есть фазовый timestamp (lockedAt, …), пишет CAS
 *    `TurnRepository.setStatus(turnId, to, expectedFrom)`: второй движок,
 *    пришедший одновременно, получит false и ошибку, а не затёртый статус (D202);
 *  - один ход на сессию: openTurn отклоняется, пока текущий ход не завершён
 *    (COMMITTED/FAILED) — D220;
 *  - `actionIds` нигде не хранятся: источник истины — таблица actions (F-1.17);
 *    TURN_LOCKED собирает их списком действий хода.
 *
 * `transition()` — низкоуровневый механизм для движка хода (модуль turn, промпт 1.8):
 * переход по триггеру из `TURN_TRANSITION_TABLE` + фазовый timestamp + журнал.
 * Доменные события движка (TURN_PROCESSING_STARTED, TURN_DRAFT_READY, TURN_COMMITTED)
 * эмитируют команды модуля — механизм их не дублирует.
 */

/** Статусы «ход ещё идёт»: пока текущий ход в одном из них, новый не открывается (D220). */
export const ACTIVE_TURN_STATUSES: ReadonlySet<TurnStatus> = new Set<TurnStatus>([
  'OPEN',
  'LOCKED',
  'PROCESSING',
  'REVIEW',
]);

/** Триггер перехода → шаг журнала хода (JournalKind из contracts). */
const TRIGGER_JOURNAL_KIND = {
  openTurn: 'turn_opened',
  lockTurn: 'turn_locked',
  unlockTurn: 'turn_unlocked',
  cancelTurn: 'turn_cancelled',
  startProcessing: 'processing_started',
  draftReady: 'draft_ready',
  processingFailed: 'failed',
  commitTurn: 'committed',
  rejectTurn: 'failed',
  retry: 'turn_opened',
} as const satisfies Record<(typeof TURN_TRANSITION_TABLE)[number]['trigger'], string>;

export interface TurnServiceDeps {
  readonly uow: UnitOfWork;
  readonly guard: CommandRunner;
  readonly journal: JournalService;
  readonly limits: { readonly actionsPerPlayerPerTurn: number };
}

export interface TurnCommandResult {
  readonly turnId: TurnId;
  readonly sessionId: SessionId;
  readonly number: number;
  readonly status: TurnStatus;
  /** true — результат взят из кэша идемпотентности (повтор команды). */
  readonly replayed: boolean;
}

export interface LockTurnResult extends TurnCommandResult {
  readonly actionIds: readonly ActionId[];
}

export interface CancelTurnResult extends TurnCommandResult {
  readonly failed: TurnFailure;
}

export interface SubmitActionResult {
  readonly actionId: ActionId;
  readonly turnId: TurnId;
  readonly sequenceId: number;
  /** true — действие с таким idempotencyKey уже было (повтор вернул прежний actionId). */
  readonly duplicate: boolean;
  readonly replayed: boolean;
}

export interface SubmitActionInput {
  readonly turnId: TurnId;
  readonly playerId: PlayerId;
  readonly rawText: string;
  readonly meta?: Partial<ActionMeta>;
  readonly idempotencyKey: IdempotencyKey | string;
  readonly traceId?: string;
}

export interface CancelTurnInput {
  readonly turnId: TurnId;
  readonly reason: string;
  /** Код отказа (Error Taxonomy). По умолчанию 'CONFLICT' — отмена хода GM без внешнего сбоя. */
  readonly code?: TurnFailure['code'];
  readonly idempotencyKey: IdempotencyKey | string;
  readonly traceId?: string;
}

export interface TransitionInput {
  readonly turnId: TurnId;
  readonly trigger: (typeof TURN_TRANSITION_TABLE)[number]['trigger'];
  /** Для переходов в FAILED: структурированная причина (контракт TurnFailure). */
  readonly failed?: Omit<TurnFailure, 'at'> | null;
  readonly traceId?: string;
}

export class TurnService {
  private readonly uow: UnitOfWork;
  private readonly guard: CommandRunner;
  private readonly journal: JournalService;
  private readonly actionsPerPlayerPerTurn: number;

  constructor(deps: TurnServiceDeps) {
    this.uow = deps.uow;
    this.guard = deps.guard;
    this.journal = deps.journal;
    this.actionsPerPlayerPerTurn = deps.limits.actionsPerPlayerPerTurn;
  }

  // ----------------------------------------------------------------── чтение

  async getTurn(turnId: TurnId): Promise<Turn> {
    const turn = await this.uow.repos().turns.findById(turnId);
    if (!turn) {
      throw new CoreError('CORE_NOT_FOUND', `ход ${turnId} не найден`, { entity: 'turn', turnId });
    }
    return turn;
  }

  /** Проекция хода для транспорта (TurnView из contracts; приватность — myActions viewer'а). */
  async getTurnView(turnId: TurnId, viewerPlayerId?: PlayerId | null): Promise<TurnView> {
    const turn = await this.getTurn(turnId);
    const actions = await this.uow.repos().actions.listByTurn(turnId);
    const mine = viewerPlayerId ? actions.filter((action) => action.playerId === viewerPlayerId) : [];
    return TurnViewSchema.parse({
      turnId: turn.turnId,
      number: turn.number,
      status: turn.status,
      actionCount: actions.length,
      myActions: mine.map((action) => ({
        actionId: action.actionId,
        sequenceId: action.sequenceId,
        rawText: action.rawText,
        createdAt: action.createdAt,
      })),
      lockedAt: turn.lockedAt,
      committedAt: turn.committedAt,
      failed: turn.failed ? { code: turn.failed.code, message: turn.failed.message } : null,
    });
  }

  async listTurns(sessionId: SessionId, limit = 100): Promise<Turn[]> {
    return this.uow.repos().turns.listBySession(sessionId, limit);
  }

  // ------------------------------------------------------------------ команды

  /**
   * openTurn — GM открывает ход (v3 §III.1 шаг 1).
   * Сессия обязана быть ACTIVE; предыдущий ход — завершён (D220).
   * number = max(number)+1 в транзакции; UNIQUE(session_id, number) страхует от гонки.
   */
  async openTurn(input: {
    sessionId: SessionId;
    idempotencyKey: IdempotencyKey | string;
    traceId?: string;
  }): Promise<TurnCommandResult> {
    const traceId = input.traceId ?? newTraceId();
    const key = parseIdempotencyKey(String(input.idempotencyKey));
    const result = await runCommand(
      this.guard,
      { key, command: 'openTurn', sessionId: input.sessionId, turnId: null, traceId },
      async (scope) => {
        const session = await scope.repos.sessions.findById(input.sessionId);
        if (!session) {
          throw new CoreError('CORE_NOT_FOUND', `сессия ${input.sessionId} не найдена`, {
            entity: 'session',
          });
        }
        if (session.status !== 'ACTIVE') {
          throw new CoreError('CORE_INVALID_STATE_TRANSITION', 'ход открывается только в ACTIVE-сессии', {
            entity: 'session',
            from: session.status,
            to: 'ACTIVE',
            reason: 'session_not_active',
          });
        }
        if (session.currentTurnId) {
          const current = await scope.repos.turns.findById(session.currentTurnId);
          if (current && ACTIVE_TURN_STATUSES.has(current.status)) {
            throw new CoreError(
              'CORE_INVALID_STATE_TRANSITION',
              `ход ${current.number} ещё не завершён (статус ${current.status}); новый ход не открывается`,
              {
                entity: 'turn',
                from: current.status,
                to: 'OPEN',
                reason: 'turn_already_active',
                turnId: current.turnId,
              },
            );
          }
        }

        const latest = await scope.repos.turns.findLatestBySession(input.sessionId);
        const number = (latest?.number ?? 0) + 1;
        const at = nowIso();
        const turn = TurnSchema.parse({
          turnId: randomUUID() as TurnId,
          sessionId: input.sessionId,
          number,
          status: 'OPEN',
          resolution: null,
          lockedAt: null,
          processingStartedAt: null,
          reviewReadyAt: null,
          committedAt: null,
          failed: null,
          createdAt: at,
          updatedAt: at,
        } satisfies Turn);

        await scope.repos.turns.insert(turn);
        await scope.repos.sessions.patchPhase(input.sessionId, { currentTurnId: turn.turnId, updatedAt: at });
        await this.journal.append(
          { sessionId: turn.sessionId, turnId: turn.turnId, kind: 'turn_opened', payload: { number }, traceId },
          scope,
        );
        await appendOutbox(
          [createEvent('TURN_OPENED', { sessionId: turn.sessionId, turnId: turn.turnId, number }, traceId)],
          scope,
        );
        return {
          turnId: turn.turnId,
          sessionId: turn.sessionId,
          number: turn.number,
          status: 'OPEN' as const,
        };
      },
    );
    return { ...result.value, replayed: result.replayed };
  }

  /**
   * lockTurn — GM закрывает подачу действий (OPEN→LOCKED).
   * Роль GM проверяет транспорт (WS_GM_ONLY); сервис проверяет статус и собирает
   * actionIds из таблицы actions (F-1.17: в Turn их нет).
   */
  async lockTurn(input: {
    turnId: TurnId;
    idempotencyKey: IdempotencyKey | string;
    traceId?: string;
  }): Promise<LockTurnResult> {
    const traceId = input.traceId ?? newTraceId();
    const key = parseIdempotencyKey(String(input.idempotencyKey));
    const sessionId = await this.sessionIdOf(input.turnId);
    const result = await runCommand(
      this.guard,
      { key, command: 'lockTurn', sessionId, turnId: input.turnId, traceId },
      async (scope) => {
        const turn = await this.turnIn(scope, input.turnId);
        assertTransition('turn', turn.status, 'LOCKED');
        const ok = await scope.repos.turns.setStatus(turn.turnId, 'LOCKED', turn.status);
        if (!ok) {
          throw raceError(turn.status, 'LOCKED');
        }
        const actions = await scope.repos.actions.listByTurn(turn.turnId);
        const actionIds = actions.map((action) => action.actionId);
        await this.journal.append(
          {
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            kind: 'turn_locked',
            payload: { actionCount: actionIds.length },
            traceId,
          },
          scope,
        );
        await appendOutbox(
          [createEvent('TURN_LOCKED', { sessionId: turn.sessionId, turnId: turn.turnId, actionIds }, traceId)],
          scope,
        );
        return {
          turnId: turn.turnId,
          sessionId: turn.sessionId,
          number: turn.number,
          status: 'LOCKED' as const,
          actionIds,
        };
      },
    );
    return { ...result.value, replayed: result.replayed };
  }

  /** unlockTurn — GM возвращает ход в OPEN (LOCKED→OPEN); событие TURN_UNLOCKED (D114). */
  async unlockTurn(input: {
    turnId: TurnId;
    idempotencyKey: IdempotencyKey | string;
    traceId?: string;
  }): Promise<TurnCommandResult> {
    const traceId = input.traceId ?? newTraceId();
    const key = parseIdempotencyKey(String(input.idempotencyKey));
    const sessionId = await this.sessionIdOf(input.turnId);
    const result = await runCommand(
      this.guard,
      { key, command: 'unlockTurn', sessionId, turnId: input.turnId, traceId },
      async (scope) => {
        const turn = await this.turnIn(scope, input.turnId);
        assertTransition('turn', turn.status, 'OPEN');
        const at = nowIso();
        const next = TurnSchema.parse({ ...turn, status: 'OPEN', lockedAt: null, updatedAt: at } satisfies Turn);
        await scope.repos.turns.update(next);
        await this.journal.append(
          { sessionId: turn.sessionId, turnId: turn.turnId, kind: 'turn_unlocked', payload: {}, traceId },
          scope,
        );
        await appendOutbox(
          [createEvent('TURN_UNLOCKED', { sessionId: turn.sessionId, turnId: turn.turnId }, traceId)],
          scope,
        );
        return {
          turnId: turn.turnId,
          sessionId: turn.sessionId,
          number: turn.number,
          status: 'OPEN' as const,
        };
      },
    );
    return { ...result.value, replayed: result.replayed };
  }

  /**
   * cancelTurn — GM отменяет ход (OPEN→FAILED, v3 §II.5 trigger=cancelTurn).
   * `failed.code` — из Error Taxonomy (по умолчанию 'CONFLICT'); сообщение — reason.
   * PROCESSING→FAILED и REVIEW→FAILED — триггеры processingFailed/rejectTurn (1.8),
   * не cancelTurn: GM-отмена доступна только для ещё не обрабатываемого хода.
   */
  async cancelTurn(input: CancelTurnInput): Promise<CancelTurnResult> {
    const traceId = input.traceId ?? newTraceId();
    const key = parseIdempotencyKey(String(input.idempotencyKey));
    const sessionId = await this.sessionIdOf(input.turnId);
    const result = await runCommand(
      this.guard,
      { key, command: 'cancelTurn', sessionId, turnId: input.turnId, traceId },
      async (scope) => {
        const turn = await this.turnIn(scope, input.turnId);
        assertTransition('turn', turn.status, 'FAILED');
        if (turn.status !== 'OPEN') {
          throw new CoreError(
            'CORE_INVALID_STATE_TRANSITION',
            `cancelTurn применим только к OPEN-ходу (текущий статус ${turn.status})`,
            { entity: 'turn', from: turn.status, to: 'FAILED', trigger: 'cancelTurn' },
          );
        }
        const failed = TurnFailureSchema.parse({
          code: input.code ?? 'CONFLICT',
          message: input.reason.slice(0, 500),
          meta: { trigger: 'cancelTurn' },
          at: nowIso(),
        } satisfies TurnFailure);
        const next = TurnSchema.parse({ ...turn, status: 'FAILED', failed, updatedAt: failed.at } satisfies Turn);
        await scope.repos.turns.update(next);
        await this.journal.append(
          {
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            kind: 'turn_cancelled',
            payload: { reason: failed.message, code: failed.code },
            traceId,
          },
          scope,
        );
        await appendOutbox(
          [
            createEvent(
              'TURN_FAILED',
              { sessionId: turn.sessionId, turnId: turn.turnId, errorCode: failed.code, message: failed.message },
              traceId,
            ),
          ],
          scope,
        );
        return {
          turnId: turn.turnId,
          sessionId: turn.sessionId,
          number: turn.number,
          status: 'FAILED' as const,
          failed,
        };
      },
    );
    return { ...result.value, replayed: result.replayed };
  }

  /**
   * submitAction — действие игрока в OPEN-ход (v3 §III.1 шаг 2).
   *  - sequenceId = max(sequence_id)+1 ВНУТРИ транзакции; UNIQUE(turn_id, sequence_id)
   *    из 1.4 страхует от гонки двух подач;
   *  - повтор того же idempotencyKey → прежний actionId, duplicate=true (B-08);
   *  - лимит действий игрока на ход — limits.actionsPerPlayerPerTurn → RATE_LIMIT;
   *  - ход не OPEN → TURN_NOT_OPEN (409, REFRESH_PROJECTION).
   */
  async submitAction(input: SubmitActionInput): Promise<SubmitActionResult> {
    const traceId = input.traceId ?? newTraceId();
    const key = parseIdempotencyKey(String(input.idempotencyKey));
    const turn = await this.getTurn(input.turnId);
    if (turn.status !== 'OPEN') {
      throw new AppError('TURN_NOT_OPEN', `ход в статусе ${turn.status}: действия не принимаются`, {
        status: turn.status,
      });
    }
    const result = await runCommand(
      this.guard,
      { key, command: 'submitAction', sessionId: turn.sessionId, turnId: turn.turnId, traceId },
      async (scope) => {
        const turnInTx = await this.turnIn(scope, input.turnId);
        if (turnInTx.status !== 'OPEN') {
          throw new AppError('TURN_NOT_OPEN', `ход в статусе ${turnInTx.status}: действия не принимаются`, {
            status: turnInTx.status,
          });
        }
        const existing = await scope.repos.actions.findByIdempotencyKey(key);
        if (existing) {
          return {
            actionId: existing.actionId,
            turnId: existing.turnId,
            sequenceId: existing.sequenceId,
            duplicate: true,
          };
        }

        const player = await scope.repos.players.findById(input.playerId);
        if (!player || player.sessionId !== turnInTx.sessionId) {
          throw new CoreError('CORE_NOT_FOUND', `игрок ${input.playerId} не принадлежит сессии хода`, {
            entity: 'player',
            playerId: input.playerId,
          });
        }
        if (player.status === 'LEFT') {
          throw new AppError('CONFLICT', 'игрок покинул сессию', { reason: 'player_left' });
        }

        const turnActions = await scope.repos.actions.listByTurn(turnInTx.turnId);
        const ownCount = turnActions.filter((action) => action.playerId === input.playerId).length;
        if (ownCount >= this.actionsPerPlayerPerTurn) {
          throw new AppError(
            'RATE_LIMIT',
            `превышен лимит действий на игрока за ход (${this.actionsPerPlayerPerTurn})`,
            { limit: this.actionsPerPlayerPerTurn, submitted: ownCount },
          );
        }

        const sequenceId = await scope.repos.actions.nextSequenceId(turnInTx.turnId);
        const parseResult = PlayerActionSchema.safeParse({
          actionId: randomUUID(),
          turnId: turnInTx.turnId,
          playerId: input.playerId,
          sequenceId,
          rawText: input.rawText,
          meta: input.meta ?? {},
          idempotencyKey: key,
          createdAt: nowIso(),
        });
        if (!parseResult.success) {
          throw new AppError('VALIDATION', 'действие не прошло PlayerActionSchema', {
            issues: parseResult.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`),
          });
        }
        const action = parseResult.data;

        await scope.repos.actions.insert(action);
        await this.journal.append(
          {
            sessionId: turnInTx.sessionId,
            turnId: turnInTx.turnId,
            kind: 'action_submitted',
            payload: { playerId: action.playerId, sequenceId: action.sequenceId, actionId: action.actionId },
            traceId,
          },
          scope,
        );
        await appendOutbox(
          [
            createEvent(
              'ACTION_SUBMITTED',
              {
                sessionId: turnInTx.sessionId,
                turnId: turnInTx.turnId,
                actionId: action.actionId,
                playerId: action.playerId,
                sequenceId: action.sequenceId,
              },
              traceId,
            ),
          ],
          scope,
        );
        return {
          actionId: action.actionId,
          turnId: action.turnId,
          sequenceId: action.sequenceId,
          duplicate: false,
        };
      },
    );
    return { ...result.value, replayed: result.replayed };
  }

  /**
   * transition — механизм перехода по триггеру из TURN_TRANSITION_TABLE (A1.6:
   * «полный путь OPEN→LOCKED→PROCESSING→REVIEW→COMMITTED проходит»).
   *
   * Для команд GM (lock/unlock/cancel) есть отдельные методы с событиями; этим
   * пользуются движок хода и GM-ревью (промпт 1.8) ВНУТРИ своих идемпотентных
   * команд — поэтому здесь нет ни guard, ни outbox: статус + фазовый timestamp
   * (CAS) + журнал. События эмитирует команда-владелец (TURN_PROCESSING_STARTED,
   * TURN_DRAFT_READY, TURN_COMMITTED, TURN_FAILED).
   */
  async transition(input: TransitionInput): Promise<{ turnId: TurnId; status: TurnStatus; number: number }> {
    const traceId = input.traceId ?? newTraceId();
    return this.uow.runInTx(async (scope) => {
      const turn = await this.turnIn(scope, input.turnId);
      const row = turnTransitionRow(turn.status, input.trigger);
      if (!row) {
        const allowed = TURN_TRANSITION_TABLE.filter((r) => r.from === turn.status).map((r) => r.trigger);
        throw new CoreError(
          'CORE_INVALID_STATE_TRANSITION',
          `триггер ${input.trigger} не применим к статусу ${turn.status}`,
          { entity: 'turn', from: turn.status, trigger: input.trigger, allowed },
        );
      }
      assertTransition('turn', turn.status, row.to);
      const ok = await scope.repos.turns.setStatus(turn.turnId, row.to, turn.status);
      if (!ok) {
        throw raceError(turn.status, row.to);
      }
      if (row.to === 'FAILED' && input.failed) {
        const stamped = await this.turnIn(scope, input.turnId);
        const failed = TurnFailureSchema.parse({ ...input.failed, at: nowIso() } satisfies TurnFailure);
        await scope.repos.turns.update(TurnSchema.parse({ ...stamped, failed, updatedAt: failed.at } satisfies Turn));
      }
      await this.journal.append(
        {
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          kind: TRIGGER_JOURNAL_KIND[input.trigger],
          payload: { trigger: input.trigger, from: turn.status, to: row.to },
          traceId,
        },
        scope,
      );
      return { turnId: turn.turnId, status: row.to, number: turn.number };
    });
  }

  // ------------------------------------------------------------------ хелперы

  private async sessionIdOf(turnId: TurnId): Promise<SessionId> {
    const turn = await this.uow.repos().turns.findById(turnId);
    if (!turn) {
      throw new CoreError('CORE_NOT_FOUND', `ход ${turnId} не найден`, { entity: 'turn', turnId });
    }
    return turn.sessionId;
  }

  private async turnIn(scope: TxScope, turnId: TurnId): Promise<Turn> {
    const turn = await scope.repos.turns.findById(turnId);
    if (!turn) {
      throw new CoreError('CORE_NOT_FOUND', `ход ${turnId} не найден`, { entity: 'turn', turnId });
    }
    return turn;
  }
}

function raceError(from: TurnStatus, to: TurnStatus): CoreError {
  return new CoreError('CORE_INVALID_STATE_TRANSITION', `статус хода изменился конкурентно (${from} → ${to})`, {
    entity: 'turn',
    from,
    to,
    race: true,
  });
}
