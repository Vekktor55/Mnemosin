/**
 * reconcileOnBoot (промпт 1.13, A1.11; решение D127).
 *
 * Крах процесса посреди AI-вызова оставляет ход в PROCESSING и запись
 * идемпотентности `resolve:{turnId}` в IN_FLIGHT (D234). При старте сервера:
 *   1) все ходы в PROCESSING переводятся в FAILED{RECONCILE_INTERRUPTED}
 *      (триггер processingFailed — строка таблицы переходов CONTRACTS,
 *      CAS по expectedStatus страхует от гонки с живым движком);
 *   2) журнал получает запись 'reconciled_on_boot' (kind зарезервирован
 *      контрактами 0.5.0 под этот промпт) + outbox — событие TURN_FAILED,
 *      чтобы подписчики шины увидели финал хода (at-least-once, D113);
 *   3) ключ `resolve:{turnId}` освобождается (release), иначе повторный
 *      resolve ушёл бы в IN_FLIGHT навсегда.
 *
 * D127 (фиксация default SPEC §13): PROCESSING → FAILED{RECONCILE_INTERRUPTED},
 * GM восстанавливает игру кнопкой Retry (retry из FAILED создаёт НОВЫЙ ход,
 * D118). Альтернатива «вернуть в OPEN» отклонена: действия хода могли быть
 * учтены частично (AI-выов прерван между попытками) — повторная обработка
 * того же набора действий скрыла бы от GM факт сбоя.
 *
 * Ход вызывается из apps/server/src/main.ts ПОСЛЕ buildCoreServices и ДО
 * listen: клиенты не могут увидеть несогласованный PROCESSING (fail-fast).
 */
import { nowIso, type SessionId, type TurnId } from '@mnemosin/contracts';
import {
  appendOutbox,
  createEvent,
  newTraceId,
  parseIdempotencyKey,
  type JournalService,
  type TurnService,
  type UnitOfWork,
} from '@mnemosin/core';

export interface ReconcileOnBootDeps {
  readonly uow: UnitOfWork;
  readonly turns: TurnService;
  readonly journal: JournalService;
  /** IdempotencyRepository.release (D234) — снятие IN_FLIGHT ключа resolve. */
  readonly idempotency: { release(key: ReturnType<typeof parseIdempotencyKey>): Promise<void> };
  readonly logger?: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

export interface ReconcileOnBootReport {
  /** Ходов в PROCESSING просмотрено (и переведено). */
  readonly reconciled: readonly TurnId[];
  /** Ключей идемпотентности освобождено. */
  readonly releasedKeys: number;
}

const RECONCILE_MESSAGE = 'ход прерван рестартом сервера во время обработки; повторите ход (Retry)';

export async function reconcileOnBoot(deps: ReconcileOnBootDeps): Promise<ReconcileOnBootReport> {
  const traceId = newTraceId();
  const sessions = await deps.uow.repos().sessions.listAll();
  const reconciled: TurnId[] = [];
  let releasedKeys = 0;

  for (const session of sessions) {
    const turns = await deps.uow.repos().turns.listBySession(session.sessionId, 500);
    for (const turn of turns) {
      if (turn.status !== 'PROCESSING') continue;

      // 1) PROCESSING → FAILED{RECONCILE_INTERRUPTED} через доменный переход.
      await deps.turns.transition({
        turnId: turn.turnId,
        trigger: 'processingFailed',
        failed: {
          code: 'RECONCILE_INTERRUPTED',
          message: RECONCILE_MESSAGE,
          meta: { reason: 'reconcile_on_boot' },
        },
        traceId,
      });

      // 2) журнал + outbox TURN_FAILED одной транзакцией.
      await deps.uow.runInTx(async (scope) => {
        await deps.journal.append(
          {
            sessionId: session.sessionId as SessionId,
            turnId: turn.turnId,
            kind: 'reconciled_on_boot',
            payload: { from: 'PROCESSING', to: 'FAILED', code: 'RECONCILE_INTERRUPTED' },
            traceId,
            createdAt: nowIso(),
          },
          scope,
        );
        await appendOutbox(
          [
            createEvent(
              'TURN_FAILED',
              {
                sessionId: session.sessionId,
                turnId: turn.turnId,
                errorCode: 'RECONCILE_INTERRUPTED',
                message: RECONCILE_MESSAGE,
              },
              traceId,
            ),
          ],
          scope,
        );
      });

      // 3) release ключа resolve:{turnId} (вне транзакции хода: идемпотентность
      //    — отдельный агрегат; отказ release логируется, старт не прерывает).
      try {
        await deps.idempotency.release(parseIdempotencyKey(`resolve:${turn.turnId}`));
        releasedKeys += 1;
      } catch (cause) {
        deps.logger?.warn(
          { err: cause, turnId: turn.turnId, event: 'reconcile_release_failed' },
          'reconcile_release_failed',
        );
      }

      reconciled.push(turn.turnId);
      deps.logger?.info(
        { turnId: turn.turnId, sessionId: session.sessionId, traceId, event: 'reconciled_on_boot' },
        'reconciled_on_boot',
      );
    }
  }

  return { reconciled, releasedKeys };
}
