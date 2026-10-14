import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { nowIso, type DomainEvent, type SessionId, type TurnId } from '@mnemosin/contracts';
import { appendOutbox, createEvent, InMemoryMetricsSink, InProcessEventBus } from '@mnemosin/core';
import { bootstrapDatabase, eventOutbox, OutboxPublisher } from '@mnemosin/database';

import { openTempDb, seedWorld, type SampleWorld, type TempDb } from './helpers.js';

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

/** Все строки outbox по порядку id — через drizzle (порт listPending видит только PENDING). */
async function allOutboxRows(db: TempDb): Promise<Array<typeof eventOutbox.$inferSelect>> {
  return db.boot.handle.db.select().from(eventOutbox).all();
}

describe('outbox · транзакционность (промпт 1.5, п.5.1–5.2)', () => {
  it('событие из откатившейся транзакции не публикуется', async () => {
    const db = await openTempDb('outbox-rollback', { seed: false });
    const world = await seedWorld(db);
    const bus = new InProcessEventBus();
    const seen: DomainEvent[] = [];
    bus.subscribe('*', (e) => {
      seen.push(e);
    });
    const publisher = new OutboxPublisher({ uow: db.boot.uow, bus });

    await expect(
      db.boot.uow.runInTx(async (scope) => {
        await appendOutbox([event(world, 1)], scope);
        throw new Error('намеренный откат');
      }),
    ).rejects.toThrow('намеренный откат');

    const report = await publisher.pollOnce();
    expect(report.scanned).toBe(0);
    expect(seen).toEqual([]);
    expect(await db.boot.uow.repos().outbox.countByStatus('PENDING')).toBe(0);
    expect(await allOutboxRows(db)).toEqual([]);
    await db.close();
  });

  it('событие из закоммиченной транзакции публикуется ровно один раз, published_at заполнен', async () => {
    const db = await openTempDb('outbox-commit-once', { seed: false });
    const world = await seedWorld(db);
    const bus = new InProcessEventBus();
    const seen: DomainEvent[] = [];
    bus.subscribe('TURN_OPENED', (e) => {
      seen.push(e);
    });
    const publisher = new OutboxPublisher({ uow: db.boot.uow, bus });

    await db.boot.uow.runInTx((scope) => appendOutbox([event(world, 1, 'trace-committed')], scope));

    const first = await publisher.pollOnce();
    expect(first).toMatchObject({ scanned: 1, published: 1, failed: 0, dead: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.traceId).toBe('trace-committed');
    expect(seen[0]?.payload).toMatchObject({ number: 1, sessionId: world.session.sessionId });

    // Повторный прогон ничего не доставляет — ровно один раз.
    const second = await publisher.pollOnce();
    expect(second.scanned).toBe(0);
    expect(seen).toHaveLength(1);

    const rows = await allOutboxRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('PUBLISHED');
    expect(rows[0]?.publishedAt).not.toBeNull();
    expect(await db.boot.uow.repos().outbox.countByStatus('PENDING')).toBe(0);
    await db.close();
  });
});

describe('outbox · сбои доставки (промпт 1.5, п.5.3, п.5.5)', () => {
  it('падение обработчика: attempts растёт, после 5 попыток DEAD, остальные события публикуются', async () => {
    const db = await openTempDb('outbox-dead', { seed: false });
    const world = await seedWorld(db);
    const bus = new InProcessEventBus();
    const delivered: number[] = [];
    bus.subscribe('TURN_OPENED', (e) => {
      if (e.payload.number === 666) throw new Error('обработчик упал');
      delivered.push(e.payload.number);
    });
    const metrics = new InMemoryMetricsSink();
    const publisher = new OutboxPublisher({ uow: db.boot.uow, bus, maxAttempts: 5, metrics });

    await db.boot.uow.runInTx((scope) => appendOutbox([event(world, 666), event(world, 1)], scope));

    for (let pass = 0; pass < 5; pass += 1) {
      await publisher.pollOnce();
      const rows = await allOutboxRows(db);
      // attempts растёт: 1, 2, 3, 4, затем DEAD на пятой неудаче (D210: attempts >= maxAttempts).
      const expectedAttempts = pass + 1;
      expect(rows[0]?.attempts).toBe(expectedAttempts);
      expect(rows[0]?.status).toBe(pass < 4 ? 'PENDING' : 'DEAD');
      expect(rows[0]?.lastError).toContain('обработчик упал');
      expect(rows[0]?.publishedAt).toBeNull();
    }

    // «Хорошее» событие опубликовано несмотря на сбой соседа по батчу.
    expect(delivered).toEqual([1]);
    const rows = await allOutboxRows(db);
    expect(rows[1]?.status).toBe('PUBLISHED');
    expect(metrics.counterOf('outbox.dead', { eventName: 'TURN_OPENED' })).toBe(1);
    expect(metrics.counterOf('outbox.retry', { eventName: 'TURN_OPENED' })).toBe(4);

    // После DEAD очередь продолжает работать: новое событие публикуется.
    await db.boot.uow.runInTx((scope) => appendOutbox([event(world, 2)], scope));
    await publisher.pollOnce();
    expect(delivered).toEqual([1, 2]);
    // Мёртвая запись больше не доставляется.
    expect((await allOutboxRows(db)).filter((r) => r.status === 'DEAD')).toHaveLength(1);
    await db.close();
  });

  it('отравленная запись (payload мимо схемы) не публикуется и уходит в DEAD', async () => {
    const db = await openTempDb('outbox-poison', { seed: false });
    const world = await seedWorld(db);
    const bus = new InProcessEventBus();
    const seen: DomainEvent[] = [];
    bus.subscribe('*', (e) => {
      seen.push(e);
    });
    const publisher = new OutboxPublisher({ uow: db.boot.uow, bus, maxAttempts: 5 });

    // Прямая вставка невалидного payloadJson — имитация порчи (invariant 16 на чтении).
    await db.boot.uow.runInTx(async (scope) => {
      await scope.repos.outbox.append({
        eventName: 'TURN_OPENED',
        payloadJson: '{"oops":true}',
        traceId: 'trace-poison',
        emittedAt: nowIso(),
      });
      await appendOutbox([event(world, 3)], scope);
    });

    for (let pass = 0; pass < 5; pass += 1) await publisher.pollOnce();

    const rows = await allOutboxRows(db);
    const poison = rows.find((r) => r.traceId === 'trace-poison');
    expect(poison?.status).toBe('DEAD');
    expect(poison?.attempts).toBe(5);
    expect(poison?.lastError).toContain('DomainEventSchema');
    // Соседняя валидная запись опубликована.
    expect(seen).toHaveLength(1);
    expect(rows.find((r) => r.traceId === 'trace-outbox')?.status).toBe('PUBLISHED');
    await db.close();
  });
});

describe('outbox · порядок и рестарт (промпт 1.5, п.5.4; A1.11)', () => {
  it('порядок публикации совпадает с порядком id', async () => {
    const db = await openTempDb('outbox-order', { seed: false });
    const world = await seedWorld(db);
    const bus = new InProcessEventBus();
    const numbers: number[] = [];
    bus.subscribe('TURN_OPENED', (e) => {
      numbers.push(e.payload.number);
    });
    const publisher = new OutboxPublisher({ uow: db.boot.uow, bus });

    await db.boot.uow.runInTx((scope) =>
      appendOutbox([event(world, 1), event(world, 2), event(world, 3), event(world, 4)], scope),
    );
    await publisher.pollOnce();
    expect(numbers).toEqual([1, 2, 3, 4]);
    await db.close();
  });

  it('перекрывающийся pollOnce пропускается (один публикатор — одна очередь)', async () => {
    const db = await openTempDb('outbox-overlap', { seed: false });
    const world = await seedWorld(db);
    const bus = new InProcessEventBus();
    let delivered = 0;
    bus.subscribe('TURN_OPENED', async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      delivered += 1;
    });
    const publisher = new OutboxPublisher({ uow: db.boot.uow, bus });
    await db.boot.uow.runInTx((scope) => appendOutbox([event(world, 1)], scope));

    const [first, second] = await Promise.all([publisher.pollOnce(), publisher.pollOnce()]);
    expect(second.skipped).toBe(true);
    expect(first.scanned).toBe(1);
    expect(delivered).toBe(1);
    await db.close();
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
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
