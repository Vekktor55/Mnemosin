import { describe, expect, it } from 'vitest';

import { JournalService } from '@mnemosin/core';

import { makeTurn, openTempDb, seedWorld } from './helpers.js';

/**
 * Промпт 1.5 · JournalService (core/turns/journal.ts, п.3).
 *
 * Журнал хода — append-only: append (+ в транзакции, и вне), list(turnId) c
 * парсингом через JournalEntrySchema, tail(sessionId, limit), lastId.
 * traceId сохраняется в каждой записи (v3 §VIII.4).
 */

describe('JournalService · round-trip', () => {
  it('append + list: записи возвращаются по порядку id, payload и traceId сохраняются', async () => {
    const db = await openTempDb('journal-roundtrip', { seed: false });
    const world = await seedWorld(db);
    const turn = makeTurn(world.session.sessionId, 1);
    await db.boot.uow.runInTx((scope) => scope.repos.turns.insert(turn));

    const journal = new JournalService(db.boot.uow);

    // Вне транзакции:
    const first = await journal.append({
      sessionId: world.session.sessionId,
      turnId: turn.turnId,
      kind: 'turn_opened',
      payload: { number: 1 },
      traceId: 'trace-open',
    });
    expect(first.id).toBeGreaterThan(0);
    expect(first.kind).toBe('turn_opened');

    // Внутри транзакции (как будет делать Turn Engine в 1.8):
    await db.boot.uow.runInTx((scope) =>
      journal.append(
        {
          sessionId: world.session.sessionId,
          turnId: turn.turnId,
          kind: 'state_applied',
          payload: { fromVersion: 0, toVersion: 1 },
          traceId: 'trace-commit',
        },
        scope,
      ),
    );

    const list = await journal.list(turn.turnId);
    expect(list.map((e) => e.kind)).toEqual(['turn_opened', 'state_applied']);
    expect(list.map((e) => e.traceId)).toEqual(['trace-open', 'trace-commit']);
    expect(list[0]?.payload).toEqual({ number: 1 });
    expect(list[1]?.payload).toEqual({ fromVersion: 0, toVersion: 1 });
    expect(list[0]?.sessionId).toBe(world.session.sessionId);
    expect(list[0]?.turnId).toBe(turn.turnId);
    // id монотонны:
    expect(list[1]!.id).toBeGreaterThan(list[0]!.id);

    await db.close();
  });

  it('запись из откатившейся транзакции в журнале не появляется', async () => {
    const db = await openTempDb('journal-rollback', { seed: false });
    const world = await seedWorld(db);
    const turn = makeTurn(world.session.sessionId, 1);
    await db.boot.uow.runInTx((scope) => scope.repos.turns.insert(turn));
    const journal = new JournalService(db.boot.uow);

    await expect(
      db.boot.uow.runInTx(async (scope) => {
        await journal.append(
          {
            sessionId: world.session.sessionId,
            turnId: turn.turnId,
            kind: 'failed',
            payload: { reason: 'откат' },
            traceId: 'trace-rollback',
          },
          scope,
        );
        throw new Error('намеренный откат');
      }),
    ).rejects.toThrow('намеренный откат');

    expect(await journal.list(turn.turnId)).toEqual([]);
    expect(await journal.lastId(world.session.sessionId)).toBe(0);
    await db.close();
  });

  it('tail(sessionId, limit) — последние записи в хронологическом порядке; lastId — максимум', async () => {
    const db = await openTempDb('journal-tail', { seed: false });
    const world = await seedWorld(db);
    const turn = makeTurn(world.session.sessionId, 1);
    await db.boot.uow.runInTx((scope) => scope.repos.turns.insert(turn));
    const journal = new JournalService(db.boot.uow);

    for (const kind of ['turn_opened', 'processing_started', 'draft_ready', 'committed'] as const) {
      await journal.append({
        sessionId: world.session.sessionId,
        turnId: turn.turnId,
        kind,
        payload: {},
        traceId: `trace-${kind}`,
      });
    }

    const tail = await journal.tail(world.session.sessionId, 2);
    expect(tail.map((e) => e.kind)).toEqual(['draft_ready', 'committed']);
    expect(await journal.lastId(world.session.sessionId)).toBe(tail[1]!.id);
    await db.close();
  });

  it('payload без ключей и длинный traceId: нормализация до схемы (traceId ≤ 64)', async () => {
    const db = await openTempDb('journal-normalize', { seed: false });
    const world = await seedWorld(db);
    const turn = makeTurn(world.session.sessionId, 1);
    await db.boot.uow.runInTx((scope) => scope.repos.turns.insert(turn));
    const journal = new JournalService(db.boot.uow);

    const entry = await journal.append({
      sessionId: world.session.sessionId,
      turnId: turn.turnId,
      kind: 'snapshot_taken',
      // payload не передан — JournalEntrySchema требует record: сервис подставляет {}
      traceId: 'x'.repeat(100),
    });
    expect(entry.payload).toEqual({});
    expect(entry.traceId).toHaveLength(64);
    await db.close();
  });
});
