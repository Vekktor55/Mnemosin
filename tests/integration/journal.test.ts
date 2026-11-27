import { describe, expect, it } from 'vitest';

import { JournalService } from '@mnemosin/core';

import { openTempDb, seedWorld } from './helpers.js';

/**
 * Промпт 1.5 · JournalService (core/turns/journal.ts, п.3).
 *
 * Журнал сессии — append-only: append (+ в транзакции, и вне), listBySession(sessionId) c
 * парсингом через JournalEntrySchema, tail(sessionId, limit), lastId.
 * traceId сохраняется в каждой записи (v3 §VIII.4).
 */

describe('JournalService · round-trip', () => {
  it('append + listBySession: записи возвращаются по порядку id, payload и traceId сохраняются', async () => {
    const db = await openTempDb('journal-roundtrip', { seed: false });
    const { world } = await seedWorld(db);

    const journal = new JournalService(db.boot.uow);

    // Вне транзакции:
    const first = await journal.append({
      sessionId: world.session.sessionId,
      turnId: null,
      kind: 'turn_opened',
      payload: { number: 1 },
      traceId: 'trace-open',
    });
    expect(first.id).toBeGreaterThan(0);
    expect(first.kind).toBe('turn_opened');

    // Внутри транзакции:
    await db.boot.uow.runInTx((scope) =>
      journal.append(
        {
          sessionId: world.session.sessionId,
          turnId: null,
          kind: 'state_applied',
          payload: { fromVersion: 0, toVersion: 1 },
          traceId: 'trace-commit',
        },
        scope,
      ),
    );

    const list = await journal.listBySession(world.session.sessionId);
    expect(list.map((e) => e.kind)).toEqual(['turn_opened', 'state_applied']);
    expect(list.map((e) => e.traceId)).toEqual(['trace-open', 'trace-commit']);
    expect(list[0]?.payload).toEqual({ number: 1 });
    expect(list[1]?.payload).toEqual({ fromVersion: 0, toVersion: 1 });
    expect(list[0]?.sessionId).toBe(world.session.sessionId);

    await db.close();
  });

  it('запись из откатившейся транзакции в журнале не появляется', async () => {
    const db = await openTempDb('journal-rollback', { seed: false });
    const { world } = await seedWorld(db);

    const journal = new JournalService(db.boot.uow);

    await expect(
      db.boot.uow.runInTx(async (scope) => {
        await journal.append(
          {
            sessionId: world.session.sessionId,
            turnId: null,
            kind: 'failed',
            payload: { reason: 'откат' },
            traceId: 'trace-rollback',
          },
          scope,
        );
        throw new Error('simulated rollback');
      }),
    ).rejects.toThrow('simulated rollback');

    const list = await journal.listBySession(world.session.sessionId);
    expect(list).toHaveLength(0);
    await db.close();
  });

  it('tail(sessionId, limit) — последние записи в хронологическом порядке; lastId — максимум', async () => {
    const db = await openTempDb('journal-tail', { seed: false });
    const { world } = await seedWorld(db);

    const journal = new JournalService(db.boot.uow);
    const kinds = ['turn_opened', 'state_applied', 'action_submitted', 'committed'];
    for (let i = 0; i < kinds.length; i++) {
      await journal.append({
        sessionId: world.session.sessionId,
        turnId: null,
        kind: kinds[i],
        payload: { step: i },
        traceId: `trace-${i}`,
      });
    }

    const tail = await journal.tail(world.session.sessionId, 2);
    expect(tail).toHaveLength(2);
    expect(tail[0].kind).toBe('action_submitted');
    expect(tail[1].kind).toBe('committed');

    const maxId = await journal.lastId(world.session.sessionId);
    expect(maxId).toBe(4);
    await db.close();
  });

  it('payload без ключей и длинный traceId: нормализация до схемы (traceId ≤ 64)', async () => {
    const db = await openTempDb('journal-normalize', { seed: false });
    const { world } = await seedWorld(db);

    const journal = new JournalService(db.boot.uow);

    const longTrace = 'a'.repeat(100);
    const entry = await journal.append({
      sessionId: world.session.sessionId,
      turnId: null,
      kind: 'turn_opened',
      payload: {},
      traceId: longTrace,
    });
    expect(entry.traceId).toHaveLength(64);

    await db.close();
  });

  it('append сохраняет явно переданный createdAt вместо текущего времени', async () => {
    const db = await openTempDb('journal-created-at', { seed: false });
    const { world } = await seedWorld(db);
    const journal = new JournalService(db.boot.uow);
    const createdAt = '2026-01-02T03:04:05.000Z';

    const entry = await journal.append({
      sessionId: world.session.sessionId,
      turnId: null,
      kind: 'turn_opened',
      payload: {},
      traceId: 'trace-created-at',
      createdAt,
    });

    expect(entry.createdAt).toBe(createdAt);
    await db.close();
  });
});
