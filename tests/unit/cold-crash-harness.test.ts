import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MatchId, type SimulationTick } from '@mnemosin/contracts';
import { CrashRestartHarness } from '@mnemosin/core';
import { openColdTestDb, type ColdTestDb } from './cold-test-setup.js';
import {
  createEventProcessor,
  createRecovery,
  createRecoveryRuntime,
  insertRuntimeSnapshot,
  makeRecoveryEvent,
} from './cold-recovery-fixtures.js';

describe('P06 Crash/Restart Harness — реальные fault-injection окна', () => {
  let db: ColdTestDb;

  beforeEach(async () => {
    db = await openColdTestDb('cold-crash');
  });

  afterEach(async () => await db.close());

  function createHarness(): CrashRestartHarness {
    return new CrashRestartHarness({
      processor: createEventProcessor(db),
      // Recovery содержит НОВЫЙ processor — это и есть restart без RAM dedup.
      recovery: createRecovery(db, createRecoveryRuntime(db), createEventProcessor(db)),
      snapshotRepo: db.uow.repos().snapshots,
      // Durable-журнал нужен, чтобы ошибка recovery не обнуляла уже зафиксированный прогресс.
      journal: db.services.journal,
    });
  }

  it('(a) HOT event → crash до COLD commit: pending replay один раз, потерян 41 transient tick', async () => {
    const snapshot = await insertRuntimeSnapshot(db, createRecoveryRuntime(db), 600);
    const event = makeRecoveryEvent(db, 110, 1, 41);
    const harness = createHarness();
    harness.recordSnapshotWritten(snapshot);
    harness.recordEventCreated(event);

    const result = await harness.simulateCrashAndRestart(db.sessionId, MatchId.parse(db.sessionId), {
      afterEventCreated: true,
      afterColdCommit: false,
      afterAckSent: false,
      afterSnapshotWritten: true,
    });

    expect(result.committedBeforeCrash).toBe(0);
    expect(result.pendingEventsBeforeCrash).toBe(1);
    expect(result.replayedEvents).toBe(1);
    expect(result.committedEvents).toBe(1);
    expect(result.pendingEventsAfterRecovery).toBe(0);
    expect(result.lostTransientEventIds).toEqual([]);
    expect(result.transientTicksLost).toBe(41);
    expect(result.transientStateRollback).toBe(true);
    expect(result.recoveryError).toBeNull();
    expect((await db.services.state.get(db.sessionId)).version).toBe(1);
    expect(await db.uow.repos().outbox.countAll()).toBe(1);
  });

  it('(b) COLD commit → crash до ACK: новый processor возвращает replayed без дубля', async () => {
    const runtime = createRecoveryRuntime(db);
    for (let tick = 0; tick < 40; tick += 1) runtime.tick();
    const snapshot = await insertRuntimeSnapshot(db, runtime, 601);
    const event = makeRecoveryEvent(db, 111, 1, 41);
    const harness = createHarness();
    harness.recordSnapshotWritten(snapshot);
    harness.recordEventCreated(event);

    const result = await harness.simulateCrashAndRestart(db.sessionId, MatchId.parse(db.sessionId), {
      afterEventCreated: true,
      afterColdCommit: true,
      afterAckSent: false,
      afterSnapshotWritten: true,
    });

    expect(result.committedBeforeCrash).toBe(1);
    expect(result.acknowledgedBeforeCrash).toBe(0);
    expect(result.pendingEventsBeforeCrash).toBe(0);
    expect(result.replayedEvents).toBe(1);
    expect(result.committedEvents).toBe(0);
    expect(result.deduplicatedEvents).toBe(1);
    expect(result.pendingEventsAfterRecovery).toBe(0);
    expect(result.transientTicksLost).toBe(1);
    expect(result.transientTicksLostSource).toBe('last-durable-event-tick');
    expect((await db.services.state.get(db.sessionId)).version).toBe(1);
    expect(
      (await db.services.journal.listBySession(db.sessionId, 100)).filter(
        (entry) => entry.kind === 'hot_gameplay_committed',
      ),
    ).toHaveLength(1);
    expect(await db.uow.repos().outbox.countAll()).toBe(1);
  });

  it('(c) snapshot → последующие durable events: recovery order и rollback window явные', async () => {
    const runtime = createRecoveryRuntime(db);
    for (let tick = 0; tick < 40; tick += 1) runtime.tick();
    const snapshot = await insertRuntimeSnapshot(db, runtime, 602);
    const harness = createHarness();
    harness.recordSnapshotWritten(snapshot);
    harness.recordEventCreated(makeRecoveryEvent(db, 112, 1, 41));
    harness.recordEventCreated(makeRecoveryEvent(db, 113, 2, 42));

    const result = await harness.simulateCrashAndRestart(db.sessionId, MatchId.parse(db.sessionId), {
      afterEventCreated: true,
      afterColdCommit: false,
      afterAckSent: false,
      afterSnapshotWritten: true,
    });

    expect(result.transientTicksLost).toBe(2);
    expect(result.replayedEvents).toBe(2);
    expect(result.committedEvents).toBe(2);
    expect(result.recoveryOrder).toEqual([
      'snapshot:load',
      'hot-runtime:restore',
      'durable-events:idempotent-replay',
      'journal:reconciled-on-boot',
    ]);
    expect((await db.services.state.get(db.sessionId)).version).toBe(2);
  });

  it('без snapshot не выдумывает recovery: незакоммиченное событие явно потеряно', async () => {
    const event = makeRecoveryEvent(db, 114, 1, 41);
    const harness = createHarness();
    harness.recordEventCreated(event);

    const result = await harness.simulateCrashAndRestart(db.sessionId, MatchId.parse(db.sessionId), {
      afterEventCreated: true,
      afterColdCommit: false,
      afterAckSent: false,
      afterSnapshotWritten: false,
    });

    expect(result.recoveredSnapshot).toBeNull();
    expect(result.pendingEventsAfterRecovery).toBe(1);
    expect(result.lostTransientEventIds).toEqual([event.eventId]);
    expect(result.replayedEvents).toBe(0);
    expect((await db.services.state.get(db.sessionId)).version).toBe(0);
  });

  it('отклоняет невозможное окно ACK без commit', async () => {
    await expect(
      createHarness().simulateCrashAndRestart(db.sessionId, MatchId.parse(db.sessionId), {
        afterEventCreated: true,
        afterColdCommit: false,
        afterAckSent: true,
        afterSnapshotWritten: false,
      }),
    ).rejects.toThrow('ACK requires COLD commit');
  });

  it('явно зафиксированный crash-тик даёт точный rollback, а не оценку по событию', async () => {
    const runtime = createRecoveryRuntime(db);
    for (let tick = 0; tick < 40; tick += 1) runtime.tick();
    const snapshot = await insertRuntimeSnapshot(db, runtime, 620);
    const event = makeRecoveryEvent(db, 115, 1, 41);
    const harness = createHarness();
    harness.recordSnapshotWritten(snapshot);
    harness.recordEventCreated(event);
    // Падение произошло на тике 77 — позже последнего durable события (41).
    harness.recordCrashTick(77 as SimulationTick);

    const result = await harness.simulateCrashAndRestart(db.sessionId, MatchId.parse(db.sessionId), {
      afterEventCreated: true,
      afterColdCommit: false,
      afterAckSent: false,
      afterSnapshotWritten: true,
    });

    expect(result.transientTicksLost).toBe(37);
    expect(result.transientTicksLostSource).toBe('explicit-crash-tick');
  });

  it('ошибка recovery не обнуляет уже зафиксированный прогресс и не теряет сохранённое событие', async () => {
    const runtime = createRecoveryRuntime(db);
    await insertRuntimeSnapshot(db, runtime, 621);
    const event = makeRecoveryEvent(db, 116, 1, 41);
    // Событие уже зафиксировано в COLD (как будто commit прошёл, а recovery — нет).
    await createEventProcessor(db).process({ event, sessionId: db.sessionId });

    const failing = {
      recover: async () => {
        throw new Error('recovery unavailable');
      },
    } as unknown as ReturnType<typeof createRecovery>;
    const harness = new CrashRestartHarness({
      processor: createEventProcessor(db),
      recovery: failing,
      snapshotRepo: db.uow.repos().snapshots,
      journal: db.services.journal,
    });
    harness.recordEventCreated(event);
    harness.recordSnapshotWritten(await insertRuntimeSnapshot(db, createRecoveryRuntime(db), 622));

    const result = await harness.simulateCrashAndRestart(db.sessionId, MatchId.parse(db.sessionId), {
      afterEventCreated: true,
      afterColdCommit: false,
      afterAckSent: false,
      afterSnapshotWritten: true,
    });

    expect(result.recoveryError).toBe('recovery unavailable');
    // Уже сохранённое в COLD событие не считается потерянным.
    expect(result.lostTransientEventIds).toEqual([]);
    expect(result.pendingEventsAfterRecovery).toBe(0);
    expect(result.committedEvents).toBe(1);
  });
});
