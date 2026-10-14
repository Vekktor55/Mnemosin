import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

import type { DomainEvent, SessionId, TurnId } from '@mnemosin/contracts';
import { appendOutbox, createEvent, InProcessEventBus } from '@mnemosin/core';
import { bootstrapDatabase, eventOutbox, OutboxPublisher } from '@mnemosin/database';

/**
 * tools/verify/outbox-probe.ts — проба для приёмки A1.11b (промпт 1.5).
 *
 * Проверяет на ЖИВОМ процессе с настоящей БД на диске:
 *  A. событие из ОТКАЧЕННОЙ транзакции не публикуется (outbox пуст);
 *  B. событие из ЗАКОММИЧЕННОЙ транзакции публикуется ровно один раз,
 *     status=PUBLISHED, published_at заполнен;
 *  C. «рестарт»: закоммиченное, но не опубликованное событие переживает
 *     закрытие процесса и публикуется новым публикатором (at-least-once, D113).
 *
 * Печатает одну JSON-строку — verify:stage1 разбирает её и ставит PASS/FAIL.
 *
 * Запуск: npx tsx --conditions=development tools/verify/outbox-probe.ts
 */

const dir = mkdtempSync(join(tmpdir(), 'mnemosin-outbox-verify-'));
const url = `file:${join(dir, 'probe.sqlite')}`;
const sessionId = randomUUID() as SessionId;

function makeEvent(number: number, traceId: string): DomainEvent {
  return createEvent('TURN_OPENED', { sessionId, turnId: randomUUID() as TurnId, number }, traceId);
}

// ── «Процесс 1» ────────────────────────────────────────────────────────────
const boot = await bootstrapDatabase({ url, seed: false });
const bus = new InProcessEventBus();
const delivered: string[] = [];
bus.subscribe('TURN_OPENED', (event) => {
  delivered.push(event.traceId);
});
const publisher = new OutboxPublisher({ uow: boot.uow, bus });

// A. Откат: событие записано в outbox, но транзакция откатилась.
try {
  await boot.uow.runInTx(async (scope) => {
    await appendOutbox([makeEvent(1, 'trace-rollback')], scope);
    throw new Error('намеренный откат');
  });
} catch {
  /* ожидаемо */
}
const rollbackPoll = await publisher.pollOnce();
const rollback = {
  scanned: rollbackPoll.scanned,
  delivered: delivered.length,
  pending: await boot.uow.repos().outbox.countByStatus('PENDING'),
};

// B. Commit: событие публикуется ровно один раз, published_at заполнен.
await boot.uow.runInTx((scope) => appendOutbox([makeEvent(2, 'trace-commit')], scope));
const commitPoll = await publisher.pollOnce();
const rows = await boot.handle.db.select().from(eventOutbox).all();
const committedRow = rows.find((row) => row.traceId === 'trace-commit');
const committed = {
  delivered: delivered.length,
  published: commitPoll.published,
  status: committedRow?.status ?? null,
  publishedAtSet: (committedRow?.publishedAt ?? null) !== null,
};

// C. Событие остаётся PENDING — «процесс умирает» до публикации.
await boot.uow.runInTx((scope) => appendOutbox([makeEvent(3, 'trace-restart')], scope));
await boot.close();

// ── «Процесс 2» (рестарт) ─────────────────────────────────────────────────
const boot2 = await bootstrapDatabase({ url, seed: false, migrate: false });
const bus2 = new InProcessEventBus();
const delivered2: string[] = [];
bus2.subscribe('TURN_OPENED', (event) => {
  delivered2.push(event.traceId);
});
const publisher2 = new OutboxPublisher({ uow: boot2.uow, bus: bus2 });
const drained = await publisher2.drain();
const restart = {
  delivered: delivered2.length,
  traceIds: delivered2,
  drainedPublished: drained.published,
  pendingAfter: await boot2.uow.repos().outbox.countByStatus('PENDING'),
};
await boot2.close();

rmSync(dir, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ rollback, committed, restart })}\n`);
