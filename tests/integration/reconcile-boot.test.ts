import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseIdempotencyKey } from '@mnemosin/core';
import { reconcileOnBoot } from '@mnemosin/module-turn';

import { bootStage1World, type Stage1World } from './modules-helpers.js';
import { makeIdempotencyRecord } from './helpers.js';

/**
 * reconcileOnBoot (промпт 1.13, A1.11, D127): крах посреди PROCESSING →
 * при старте ход переводится в FAILED{RECONCILE_INTERRUPTED}, журнал получает
 * 'reconciled_on_boot', outbox — TURN_FAILED, ключ resolve:{turnId} освобождён.
 */

let world: Stage1World;

beforeAll(async () => {
  world = await bootStage1World('reconcile-boot', { players: 2, actions: 1, lock: true });
});

afterAll(async () => {
  await world.close();
});

describe('reconcileOnBoot (D127)', () => {
  it('PROCESSING на старте → FAILED{RECONCILE_INTERRUPTED} + журнал + outbox + release ключа', async () => {
    const repos = world.db.boot.uow.repos();

    // Симуляция краха: ход LOCKED → PROCESSING (как после транзакции №1
    // resolveTurn) + IN_FLIGHT ключ resolve:{turnId} (D234).
    const moved = await repos.turns.setStatus(world.turnId, 'PROCESSING', 'LOCKED');
    expect(moved).toBe(true);
    const resolveKey = parseIdempotencyKey(`resolve:${world.turnId}`);
    const acquired = await repos.idempotency.tryAcquire(makeIdempotencyRecord(resolveKey));
    expect(acquired.kind).toBe('proceed');

    // Старт сервера после краха.
    const report = await reconcileOnBoot({
      uow: world.db.boot.uow,
      turns: world.services.turns,
      journal: world.services.journal,
      idempotency: repos.idempotency,
    });
    expect(report.reconciled).toEqual([world.turnId]);
    expect(report.releasedKeys).toBe(1);

    // Ход в согласованном FAILED с кодом RECONCILE_INTERRUPTED (D127).
    const turn = await world.services.turns.getTurn(world.turnId);
    expect(turn.status).toBe('FAILED');
    expect(turn.failed?.code).toBe('RECONCILE_INTERRUPTED');

    // Журнал: запись reconciled_on_boot (kind зарезервирован контрактами 0.5.0).
    const journal = await repos.journal.listByTurn(world.turnId);
    expect(journal.some((entry) => entry.kind === 'reconciled_on_boot')).toBe(true);

    // Outbox: TURN_FAILED опубликован в шину (at-least-once, D113).
    await world.drain();
    const failedEvents = world.captured.filter(
      (event) => event.type === 'TURN_FAILED' && event.payload['turnId'] === world.turnId,
    );
    expect(failedEvents.length).toBeGreaterThanOrEqual(1);
    expect(failedEvents[0]?.payload['errorCode']).toBe('RECONCILE_INTERRUPTED');

    // Ключ resolve освобождён: повторный захват возможен (retry GM не уйдёт в IN_FLIGHT).
    const retryAcquire = await repos.idempotency.tryAcquire(makeIdempotencyRecord(resolveKey));
    expect(retryAcquire.kind).toBe('proceed');

    // Повторный reconcile идемпотентен: ничего не трогает.
    const second = await reconcileOnBoot({
      uow: world.db.boot.uow,
      turns: world.services.turns,
      journal: world.services.journal,
      idempotency: repos.idempotency,
    });
    expect(second.reconciled).toEqual([]);
  });

  it('ходы вне PROCESSING не трогаются', async () => {
    const repos = world.db.boot.uow.repos();
    const before = await world.services.turns.getTurn(world.turnId);
    const report = await reconcileOnBoot({
      uow: world.db.boot.uow,
      turns: world.services.turns,
      journal: world.services.journal,
      idempotency: repos.idempotency,
    });
    expect(report.reconciled).toEqual([]);
    const after = await world.services.turns.getTurn(world.turnId);
    expect(after.status).toBe(before.status);
  });
});
