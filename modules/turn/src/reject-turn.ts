import { randomUUID } from 'node:crypto';

import { CoreError, TurnSchema, nowIso, type Turn, type TurnFailure } from '@mnemosin/contracts';
import { appendOutbox, createEvent, newTraceId, parseIdempotencyKey, runCommand, type TxScope } from '@mnemosin/core';

import {
  RejectTurnInputSchema,
  RejectTurnOutputSchema,
  RetryTurnInputSchema,
  RetryTurnOutputSchema,
  type RejectTurnInput,
  type RejectTurnOutput,
  type RetryTurnInput,
  type RetryTurnOutput,
} from './contract.js';
import type { TurnEngineDeps } from './deps.js';

/**
 * rejectTurn — REVIEW → FAILED (промпт 1.8, п.5): failed{code, message:reason},
 * journal 'failed', outbox TURN_FAILED{errorCode}. Владелец вызова — gm-review
 * (D119), код отказа — параметр (D223, default CONFLICT).
 */
export async function rejectTurn(deps: TurnEngineDeps, rawInput: RejectTurnInput): Promise<RejectTurnOutput> {
  const input = RejectTurnInputSchema.parse(rawInput);
  const traceId = input.traceId ?? newTraceId();
  const key = parseIdempotencyKey(String(input.idempotencyKey));
  const code = input.code ?? 'CONFLICT';

  const result = await runCommand(
    deps.guard,
    { key, command: 'rejectTurn', sessionId: null, turnId: input.turnId, traceId },
    async (scope) => {
      const turn = await turnIn(scope, input.turnId);
      if (turn.status !== 'REVIEW') {
        throw new CoreError(
          'CORE_INVALID_STATE_TRANSITION',
          `rejectTurn применим только к REVIEW (статус ${turn.status})`,
          {
            entity: 'turn',
            from: turn.status,
            to: 'FAILED',
            reason: 'reject_requires_review',
          },
        );
      }
      const failed: Omit<TurnFailure, 'at'> = { code, message: input.reason, meta: {} };
      // transition: REVIEW→FAILED (CAS) + failed + journal 'failed' (D223).
      await deps.services.turns.transition({ turnId: input.turnId, trigger: 'rejectTurn', failed, traceId });

      if (input.gmDecision !== undefined) {
        await deps.services.journal.append(
          {
            sessionId: turn.sessionId,
            turnId: input.turnId,
            kind: 'gm_decision',
            payload: { decision: 'REJECT', gmPlayerId: input.gmDecision.gmPlayerId, reason: input.reason },
            traceId,
          },
          scope,
        );
      }

      const events = [
        createEvent(
          'TURN_FAILED',
          { sessionId: turn.sessionId, turnId: input.turnId, errorCode: code, message: input.reason },
          traceId,
        ),
      ];
      if (input.gmDecision !== undefined) {
        events.push(
          createEvent(
            'GM_REVIEW_DECIDED',
            {
              sessionId: turn.sessionId,
              turnId: input.turnId,
              gmPlayerId: input.gmDecision.gmPlayerId,
              decision: 'REJECT',
            },
            traceId,
          ),
        );
      }
      await appendOutbox(events, scope);
      return { turnId: input.turnId, sessionId: turn.sessionId, status: 'FAILED' as const };
    },
  );
  return RejectTurnOutputSchema.parse({ ...result.value, replayed: result.replayed });
}

/**
 * retryTurn (промпт 1.8, п.5):
 *  - из REVIEW: переход REVIEW→OPEN (триггер 'retry' таблицы 1.2) с ОЧИСТКОЙ
 *    resolution — повторный resolveTurn соберёт черновик заново;
 *  - из FAILED: создаётся НОВЫЙ ход (номер+1, OPEN). Действия прежнего хода
 *    НЕ копируются — они остаются в прежнем ходе, GM решает (D118).
 *    Игнорировать FAILED и открыть следующий ход может и openTurn (D220), но
 *    retryTurn из GM-ревью делает это одним идемпотентным вызовом.
 */
export async function retryTurn(deps: TurnEngineDeps, rawInput: RetryTurnInput): Promise<RetryTurnOutput> {
  const input = RetryTurnInputSchema.parse(rawInput);
  const traceId = input.traceId ?? newTraceId();
  const key = parseIdempotencyKey(String(input.idempotencyKey));

  const result = await runCommand(
    deps.guard,
    { key, command: 'retryTurn', sessionId: null, turnId: input.turnId, traceId },
    async (scope) => {
      const turn = await turnIn(scope, input.turnId);

      if (input.gmDecision !== undefined) {
        await deps.services.journal.append(
          {
            sessionId: turn.sessionId,
            turnId: input.turnId,
            kind: 'gm_decision',
            payload: { decision: 'RETRY_AI', gmPlayerId: input.gmDecision.gmPlayerId },
            traceId,
          },
          scope,
        );
      }
      const decisionEvents =
        input.gmDecision !== undefined
          ? [
              createEvent(
                'GM_REVIEW_DECIDED',
                {
                  sessionId: turn.sessionId,
                  turnId: input.turnId,
                  gmPlayerId: input.gmDecision.gmPlayerId,
                  decision: 'RETRY_AI',
                },
                traceId,
              ),
            ]
          : [];

      if (turn.status === 'REVIEW') {
        await deps.services.turns.transition({ turnId: input.turnId, trigger: 'retry', traceId });
        const reopened = await turnIn(scope, input.turnId);
        // Очистка черновика: повторный resolveTurn не должен видеть старый.
        await scope.repos.turns.update({ ...reopened, resolution: null, updatedAt: nowIso() });
        // D235: инвалидация кэша идемпотентности `resolve:{turnId}` — retry означает
        // «перегенерировать»: прежний DONE-результат недействителен, следующий
        // resolveTurn обязан выполнить генерацию заново (а не отдать replay).
        await scope.repos.idempotency.release(parseIdempotencyKey(`resolve:${input.turnId}`));
        await appendOutbox(decisionEvents, scope);
        return {
          turnId: input.turnId,
          sessionId: turn.sessionId,
          number: turn.number,
          status: 'OPEN' as const,
          createdNewTurn: false,
        };
      }

      if (turn.status === 'FAILED') {
        const session = await scope.repos.sessions.findById(turn.sessionId);
        if (session === null) {
          throw new CoreError('CORE_NOT_FOUND', `сессия ${turn.sessionId} не найдена`, { entity: 'session' });
        }
        if (session.status !== 'ACTIVE') {
          throw new CoreError('CORE_INVALID_STATE_TRANSITION', 'новый ход открывается только в ACTIVE-сессии', {
            entity: 'session',
            from: session.status,
            to: 'ACTIVE',
            reason: 'session_not_active',
          });
        }
        // D118: новый ход номер+1; действия прежнего хода НЕ копируются.
        const latest = await scope.repos.turns.findLatestBySession(turn.sessionId);
        const number = (latest?.number ?? 0) + 1;
        const at = nowIso();
        const created: Turn = TurnSchema.parse({
          turnId: randomUUID(),
          sessionId: turn.sessionId,
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
        });
        await scope.repos.turns.insert(created);
        await scope.repos.sessions.patchPhase(turn.sessionId, { currentTurnId: created.turnId, updatedAt: at });
        await deps.services.journal.append(
          {
            sessionId: turn.sessionId,
            turnId: created.turnId,
            kind: 'turn_opened',
            payload: { number, retriedFrom: turn.turnId },
            traceId,
          },
          scope,
        );
        await appendOutbox(
          [
            ...decisionEvents,
            createEvent('TURN_OPENED', { sessionId: turn.sessionId, turnId: created.turnId, number }, traceId),
          ],
          scope,
        );
        return {
          turnId: created.turnId,
          sessionId: turn.sessionId,
          number: created.number,
          status: 'OPEN' as const,
          createdNewTurn: true,
        };
      }

      throw new CoreError('CORE_INVALID_STATE_TRANSITION', `retryTurn не поддерживается из статуса ${turn.status}`, {
        entity: 'turn',
        from: turn.status,
        reason: 'retry_requires_review_or_failed',
      });
    },
  );
  return RetryTurnOutputSchema.parse({ ...result.value, replayed: result.replayed });
}

async function turnIn(scope: TxScope, turnId: RejectTurnInput['turnId']) {
  const turn = await scope.repos.turns.findById(turnId);
  if (turn === null) {
    throw new CoreError('CORE_NOT_FOUND', `ход ${turnId} не найден`, { entity: 'turn', turnId });
  }
  return turn;
}
