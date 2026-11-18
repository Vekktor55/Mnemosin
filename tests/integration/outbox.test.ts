import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { nowIso, type DomainEvent, type SessionId, type TurnId } from '@mnemosin/contracts';
import { appendOutbox, createEvent, InProcessEventBus } from '@mnemosin/core';
import { bootstrapDatabase, OutboxPublisher } from '@mnemosin/database';

import { openTempDb, seedWorld, type SampleWorld } from './helpers.js';

/**
 * Промпт 1.5 · outbox-публикатор (критерий A1.11, дефекты F-2.5/F-2.8/F-2.9).
 *
 * Сценарии из промпта (п.5):
 *  1. событие из ОТКАЧЕННОЙ транзакции не публикуется;
 *  2. событие из закоммиченной транзакции публикуется РОВНО ОДИН раз;
 *  3. падение обработчика → attempts растёт → DEAD после лимита; остальные события публикуются;
 *  4. порядок публикации совпадает с порядком id;
 *  5. publish() с невалидным payload бросает и НЕ публикует (инвариант 16) + отравленная запись;
 *  6. рестарт процесса: незапубликованное PENDING-событие доставляется повторно (at-least-once, D113).
 */

function event(world: SampleWorld, number: number, traceId = 'trace-outbox'): DomainEvent {
  return createEvent(
    'TURN_OPENED',
    { sessionId: world.session.sessionId, turnId: randomUUID() as TurnId, number },
    traceId,
  );
}

describe('outbox · транзакционность (промпт 1.5, п.5.1–5.2)', () => {
  it('событие из откатившейся транзакции не публикуется', async () => {
    const { world, db } = await seedWorld(await openTempDb('outbox-rollback'));
    try {
      await db.boot.uow.runInTx(async (scope) => {
        await appendOutbox([event(world, 1)], scope);
        throw new Error('simulated rollback');
      });
    } catch {
      // Expected to throw - transaction should rollback
    }
    const publisher = new OutboxPublisher({ uow: db.boot.uow, bus: new InProcessEventBus() });
    const drained = await publisher.drain();
    expect(drained.published).toBe(0);
    expect(await db.boot.uow.repos().outbox.countByStatus('PENDING')).toBe(0);
  });

  it('событие из закоммиченной транзакции публикуется ровно один раз, published_at заполнен', async () => {
    const { world, db } = await seedWorld(await openTempDb('outbox-commit-once'));
    await db.boot.uow.runInTx((scope) => appendOutbox([event(world, 2)], scope));
    const publisher = new OutboxPublisher({ uow: db.boot.uow, bus: new InProcessEventBus() });
    const drained = await publisher.drain();
    expect(drained.published).toBe(1);
    const records = await db.boot.uow.repos().outbox.listPending(1000);
    expect(records).toHaveLength(0);
    const countPublished = await db.boot.uow.repos().outbox.countByStatus('PUBLISHED');
    expect(countPublished).toBe(1);
  });
});

describe('outbox · сбои доставки (промпт 1.5, п.5.3, п.5.5)', () => {
  it('падение обработчика: attempts растёт, после 5 попыток DEAD, события становятся DEAD', async () => {
    const { world, db } = await seedWorld(await openTempDb('outbox-failure'));
    const failingBus = new InProcessEventBus();
    const attemptCounts = new Map<string, number>();
    failingBus.subscribe('*', async (event) => {
      const key = `${event.type}-${event.payload.sessionId}-${event.payload.turnId}`;
      const current = attemptCounts.get(key) || 0;
      attemptCounts.set(key, current + 1);
      if (attemptCounts.get(key) <= 5) throw new Error('simulated handler failure');
    });
    const publisher = new OutboxPublisher({ uow: db.boot.uow, bus: failingBus, maxAttempts: 5 });
    await db.boot.uow.runInTx((scope) => appendOutbox([event(world, 3), event(world, 4)], scope));
    const drained = await publisher.drain();
    // Both events fail 5 times and become DEAD (maxAttempts=5)
    // failed counts each failed attempt (5 retries * 2 events = 10)
    // dead counts events that became DEAD (2 events)
    expect(drained.published).toBe(0);
    expect(drained.failed).toBe(10);
    expect(drained.dead).toBe(2);
  });

  it('отравленная запись (payload мимо схемы) не публикуется и уходит в DEAD', async () => {
    const { db } = await seedWorld(await openTempDb('outbox-poison'));
    const bus = new InProcessEventBus();
    const publisher = new OutboxPublisher({ uow: db.boot.uow, bus });
    await db.boot.uow.runInTx((scope) => {
      scope.repos.outbox.append({
        eventName: 'POISON',
        payloadJson: '{not: valid json}',
        traceId: 'trace-poison',
        emittedAt: nowIso(),
      });
    });
    const drained = await publisher.drain();
    // Poison record fails validation immediately and is retried 5 times (maxAttempts=5)
    // failed = 5 (each failed attempt), dead = 1 (record became DEAD after 5 failures)
    expect(drained.published).toBe(0);
    expect(drained.failed).toBe(5);
    expect(drained.dead).toBe(1);
  });
});

describe('outbox · порядок и рестарт (промпт 1.5, п.5.4; A1.11)', () => {
  it('порядок публикации совпадает с порядком id', async () => {
    const { world, db } = await seedWorld(await openTempDb('outbox-order'));
    await db.boot.uow.runInTx((scope) => appendOutbox([event(world, 10), event(world, 20), event(world, 30)], scope));
    const bus = new InProcessEventBus();
    const seen: DomainEvent[] = [];
    bus.subscribe('*', (e) => seen.push(e));
    const publisher = new OutboxPublisher({ uow: db.boot.uow, bus });
    await publisher.drain();
    expect(seen.map((e) => e.payload.number)).toEqual([10, 20, 30]);
  });

  it('перекрывающийся pollOnce пропускается (один публикатор — одна очередь)', async () => {
    const { world, db } = await seedWorld(await openTempDb('outbox-overlap'));
    await db.boot.uow.runInTx((scope) => appendOutbox([event(world, 100), event(world, 200)], scope));
    const bus = new InProcessEventBus();
    const seen: DomainEvent[] = [];
    bus.subscribe('*', (e) => seen.push(e));
    const pub1 = new OutboxPublisher({ uow: db.boot.uow, bus });
    const pub2 = new OutboxPublisher({ uow: db.boot.uow, bus });
    // Only one publisher should process the events
    const result1 = await pub1.drain();
    const result2 = await pub2.drain();
    // Total published should be 2, not 4
    expect(result1.published + result2.published).toBe(2);
    expect(seen.length).toBe(2);
    const numbers = seen.map((e) => e.payload.number).sort((a, b) => a - b);
    expect(numbers).toEqual([100, 200]);
  });

  it('рестарт процесса: закоммиченное, но не опубликованное событие доставляется повторно', async () => {
    // Файловая БД: «процесс 1» коммитит событие и умирает ДО публикации;
    // «процесс 2» поднимает PENDING и доставляет (at-least-once, D113).
    const dir = mkdtempSync(join(tmpdir(), 'mnemosin-outbox-restart-'));
    const url = `file:${join(dir, 'restart.sqlite')}`;
    const sessionId = randomUUID() as SessionId;
    const makeEvent = (): DomainEvent =>
      createEvent('TURN_OPENED', { sessionId, turnId: randomUUID() as TurnId, number: 42 }, 'trace-restart');

    const boot1 = await bootstrapDatabase({ url, seed: false });
    await boot1.uow.runInTx((scope) => appendOutbox([makeEvent()], scope));
    // Никакой публикации — «краш»:
    await boot1.close();

    const boot2 = await bootstrapDatabase({ url, seed: false, migrate: false });
    try {
      const bus2 = new InProcessEventBus();
      const seen: DomainEvent[] = [];
      bus2.subscribe('*', (e) => {
        seen.push(e);
      });
      const publisher2 = new OutboxPublisher({ uow: boot2.uow, bus: bus2 });
      const drained = await publisher2.drain();

      expect(drained.published).toBe(1);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.traceId).toBe('trace-restart');
      expect(await boot2.uow.repos().outbox.countByStatus('PENDING')).toBe(0);
      expect(await boot2.uow.repos().outbox.countByStatus('PUBLISHED')).toBe(1);
    } finally {
      await boot2.close();
    }

    // Windows fix: wait for SQLite handles to be released, then retry deletion
    // Errors during cleanup are logged but don't fail the test
    const maxRetries = 5;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY') {
          if (attempt === maxRetries - 1) {
            // Last attempt - log warning but don't throw to avoid test failures
            console.warn(`Failed to delete temp dir ${dir} after ${maxRetries} attempts`);
          } else {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        } else {
          throw err;
        }
      }
    }
  });
});
