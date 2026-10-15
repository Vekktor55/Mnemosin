import {
  AppError,
  ConflictError,
  CoreError,
  TurnResolutionSchema,
  nowIso,
  type DomainEvent,
  type TurnResolution,
} from '@mnemosin/contracts';
import { appendOutbox, createEvent, newTraceId, parseIdempotencyKey, runCommand, type TxScope } from '@mnemosin/core';

import {
  CommitTurnInputSchema,
  CommitTurnOutputSchema,
  type CommitTurnInput,
  type CommitTurnOutput,
} from './contract.js';
import type { TurnEngineDeps } from './deps.js';
import { approveAllItems, buildCommitPlan, markResolutionApplied } from './apply-resolution.js';

/**
 * commitTurn — REVIEW → COMMITTED + применение черновика (промпт 1.8, п.3; v3 §III.2).
 *
 * withIdempotency(key, 'commitTurn', …):
 *  - проверка status === REVIEW (иначе CORE_INVALID_STATE_TRANSITION);
 *  - expectedVersion = resolution.baseVersion (сохранён при draftReady) —
 *    расхождение с GameState.version → VERSION_CONFLICT (optimistic lock, F-3.2);
 *  - ОДНОЙ транзакцией: gmDecision (PROPOSED→APPROVED + journal 'gm_decision' +
 *    outbox GM_REVIEW_DECIDED) → applyResolution (только APPROVED/EDITED item'ы,
 *    allowlist aiMutableObjectKeys) → state-service.apply(expectedVersion, scope)
 *    (version+1, history, journal 'state_applied', outbox STATE_COMMITTED) →
 *    transition 'commitTurn' (COMMITTED + committedAt + journal 'committed') →
 *    сохранение финального resolution (статусы APPLIED/SKIPPED) → журнал
 *    effects_applied/effects_deferred/ending_reached → outbox TURN_COMMITTED →
 *    finish idempotency c resultJson {version, turnId, sessionId};
 *  - возврат клиенту — {version} (при повторе с тем же ключом — тот же результат
 *    из resultJson, B-08.4: без второй записи в journal);
 *  - следующий ход АВТОМАТИЧЕСКИ не открывается — его открывает GM (D117).
 *
 * STATE_COMMITTED эмитит StateService.apply (единственный эмитент, D219) —
 * движок событие не дублирует; в контракте модуля оно задекларировано как
 * принадлежащее turn (EVENT_EMITTERS).
 */

export async function commitTurn(deps: TurnEngineDeps, rawInput: CommitTurnInput): Promise<CommitTurnOutput> {
  const input = CommitTurnInputSchema.parse(rawInput);
  const traceId = input.traceId ?? newTraceId();
  const key = parseIdempotencyKey(String(input.idempotencyKey));

  const result = await runCommand(
    deps.guard,
    { key, command: 'commitTurn', sessionId: null, turnId: input.turnId, traceId },
    async (scope) => {
      const turn = await turnIn(scope, input.turnId);
      if (turn.status !== 'REVIEW') {
        throw new CoreError(
          'CORE_INVALID_STATE_TRANSITION',
          `commitTurn применим только к REVIEW-ходу (фактический статус ${turn.status})`,
          { entity: 'turn', from: turn.status, to: 'COMMITTED', reason: 'commit_requires_review' },
        );
      }
      const draft = turn.resolution;
      if (draft === null) {
        throw new AppError('CONFLICT', `ход ${turn.turnId} в REVIEW без черновика — коммитить нечего`, {
          reason: 'no_resolution',
        });
      }
      const sessionId = turn.sessionId;

      const state = await scope.repos.state.findBySession(sessionId);
      if (state === null) {
        throw new CoreError('CORE_NOT_FOUND', `состояние сессии ${sessionId} не найдено`, { entity: 'game_state' });
      }
      // Optimistic lock: версия из черновика (baseVersion, сохранён при draftReady).
      if (state.version !== draft.baseVersion) {
        throw new ConflictError(
          'VERSION_CONFLICT',
          `состояние ушло вперёд: черновик собран на версии ${draft.baseVersion}, фактическая ${state.version}`,
          { expectedVersion: draft.baseVersion, actualVersion: state.version, turnId: input.turnId },
        );
      }

      // Решение GM (вызов из gm-review): PROPOSED → APPROVED + аудит решения.
      let effective: TurnResolution = draft;
      const outbox: DomainEvent[] = [];
      if (input.gmDecision !== undefined) {
        effective = approveAllItems(draft);
        await deps.services.journal.append(
          {
            sessionId,
            turnId: input.turnId,
            kind: 'gm_decision',
            payload: { decision: input.gmDecision.kind, gmPlayerId: input.gmDecision.gmPlayerId },
            traceId,
          },
          scope,
        );
        outbox.push(
          createEvent(
            'GM_REVIEW_DECIDED',
            {
              sessionId,
              turnId: input.turnId,
              gmPlayerId: input.gmDecision.gmPlayerId,
              decision: input.gmDecision.kind,
            },
            traceId,
          ),
        );
      }

      // applyResolution: план мутаций (только APPROVED/EDITED item'ы).
      const players = await scope.repos.players.listBySession(sessionId);
      const activePlayerIds = players
        .filter((player) => player.status === 'ACTIVE' || player.status === 'DISCONNECTED')
        .map((player) => player.playerId);
      const plan = buildCommitPlan(effective, {
        allowlist: deps.limits.aiMutableObjectKeys,
        activePlayerIds,
      });

      // StateService.apply — в той же транзакции (scope): version+1, history,
      // journal 'state_applied', outbox STATE_COMMITTED (единственный эмитент).
      const applied = await deps.services.state.apply({
        sessionId,
        mutations: plan.mutations,
        expectedVersion: draft.baseVersion,
        turnId: input.turnId,
        traceId,
        scope,
      });

      // Переход REVIEW → COMMITTED (+committedAt, journal 'committed', CAS).
      await deps.services.turns.transition({ turnId: input.turnId, trigger: 'commitTurn', traceId });

      // Финальные статусы item'ов (APPLIED/SKIPPED) — сохраняются с ходом.
      const finalResolution = TurnResolutionSchema.parse(markResolutionApplied(effective, plan));
      const committed = await turnIn(scope, input.turnId);
      await scope.repos.turns.update({ ...committed, resolution: finalResolution, updatedAt: nowIso() });

      // Журнал применения эффектов/финала/визуальной сцены (этап 1).
      if (plan.appliedEventCount > 0 || plan.deferred.length > 0) {
        await deps.services.journal.append(
          {
            sessionId,
            turnId: input.turnId,
            kind: 'effects_applied',
            payload: {
              events: plan.appliedEventCount,
              effects: plan.appliedEffectCount,
              deferred: plan.deferred.length,
            },
            traceId,
          },
          scope,
        );
      }
      if (plan.deferred.length > 0) {
        await deps.services.journal.append(
          {
            sessionId,
            turnId: input.turnId,
            kind: 'effects_deferred',
            payload: { notes: plan.deferred.slice(0, 20) },
            traceId,
          },
          scope,
        );
      }
      if (plan.endingReached !== null) {
        // Промпт 1.8 п.4: REACH_ENDING → endingState + журнал; endSession — этап 3.
        await deps.services.journal.append(
          {
            sessionId,
            turnId: input.turnId,
            kind: 'ending_reached',
            payload: { endingId: plan.endingReached },
            traceId,
          },
          scope,
        );
      }
      if (plan.hasVisualScene) {
        // Этап 1: media-модуля нет — только журнал (заявка появится в этапе 2).
        await deps.services.journal.append(
          {
            sessionId,
            turnId: input.turnId,
            kind: 'effects_deferred',
            payload: { notes: [{ kind: 'VISUAL_SCENE', reason: 'media_director_stage2', subject: null }] },
            traceId,
          },
          scope,
        );
      }
      if (plan.skippedObjectKeys.length > 0) {
        await deps.services.journal.append(
          {
            sessionId,
            turnId: input.turnId,
            kind: 'ai_violations',
            payload: {
              violations: plan.skippedObjectKeys.slice(0, 10).map((entry) => ({
                kind: 'OBJECT_KEY_NOT_ALLOWED',
                objectId: entry.objectId,
                keys: entry.keys.slice(0, 10),
              })),
            },
            traceId,
          },
          scope,
        );
      }

      outbox.push(
        createEvent('TURN_COMMITTED', { sessionId, turnId: input.turnId, version: applied.version }, traceId),
      );
      await appendOutbox(outbox, scope);

      deps.metrics?.counter('turn.committed_total', 1);
      return { turnId: input.turnId, sessionId, version: applied.version };
    },
  );

  const output = CommitTurnOutputSchema.parse({ ...result.value, replayed: result.replayed });
  deps.logger?.info(
    { turnId: output.turnId, version: output.version, replayed: output.replayed, traceId, event: 'turn_committed' },
    'turn_committed',
  );
  return output;
}

async function turnIn(scope: TxScope, turnId: CommitTurnInput['turnId']) {
  const turn = await scope.repos.turns.findById(turnId);
  if (turn === null) {
    throw new CoreError('CORE_NOT_FOUND', `ход ${turnId} не найден`, { entity: 'turn', turnId });
  }
  return turn;
}
