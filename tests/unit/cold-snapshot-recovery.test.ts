import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MatchId } from '@mnemosin/contracts';
import { openColdTestDb, type ColdTestDb } from './cold-test-setup.js';
import {
  createCommandProcessor,
  createEventProcessor,
  createRecovery,
  createRecoveryRuntime,
  insertRuntimeSnapshot,
  makeRecoveryCommand,
  makeRecoveryEvent,
} from './cold-recovery-fixtures.js';

describe('P06 SnapshotRecoveryOrchestrator — real HOT restore + durable replay', () => {
  let db: ColdTestDb;

  beforeEach(async () => {
    db = await openColdTestDb('cold-snapshot');
  });

  afterEach(async () => {
    await db?.close();
  });

  it('требует HOT v1 snapshot для восстановления', async () => {
    const recovery = createRecovery(db, createRecoveryRuntime(db));
    await expect(recovery.recover({ matchId: MatchId.parse(db.sessionId), sessionId: db.sessionId })).rejects.toThrow(
      'No snapshot found',
    );
  });

  it('восстанавливает HOT snapshot и применяет post-snapshot COLD commands на границе тика', async () => {
    const commands = createCommandProcessor(db);
    const original = createRecoveryRuntime(db);
    const first = makeRecoveryCommand(db, 1);
    const second = makeRecoveryCommand(db, 2);
    await commands.process({ command: first, sessionId: db.sessionId });
    await commands.process({ command: second, sessionId: db.sessionId });
    original.receiveColdCommand(first);
    original.receiveColdCommand(second);
    original.tick();
    await insertRuntimeSnapshot(db, original, 200);

    // Эта команда уже есть в durable journal, но в snapshot её ещё нет.
    const third = makeRecoveryCommand(db, 3);
    await commands.process({ command: third, sessionId: db.sessionId });
    const coldVersion = (await db.services.state.get(db.sessionId)).version;

    const restartedRuntime = createRecoveryRuntime(db);
    const result = await createRecovery(db, restartedRuntime).recover({
      matchId: MatchId.parse(db.sessionId),
      sessionId: db.sessionId,
    });

    expect(result.appliedColdRevisions).toBe(1);
    expect(result.recoveredRuntime.recoveryPoint.coldRevision).toBe(3);
    expect(result.recoveredRuntime.runtime.simulationTick).toBe(2); // snapshot tick 1 + один recovery tick
    expect(result.recoveredRuntime.runtime.prototypeFacts[db.playerId]?.['revision-3']).toBe(3);
    expect(restartedRuntime.getColdBoundaryState().coldRevision).toBe(3);
    expect(result.recoveryOrder).toEqual([
      'snapshot:load',
      'hot-runtime:restore',
      'cold-revisions:apply-at-tick-boundary',
      'journal:reconciled-on-boot',
    ]);
    // Recovery НЕ откатывает COLD GameState к старой snapshot-копии.
    expect((await db.services.state.get(db.sessionId)).version).toBe(coldVersion);
  });

  it('crash после commit до ACK: новый processor делает replay без повторной mutation/outbox', async () => {
    const runtime = createRecoveryRuntime(db);
    await insertRuntimeSnapshot(db, runtime, 201);
    const event = makeRecoveryEvent(db, 101, 1, 41);

    await createEventProcessor(db).process({ event, sessionId: db.sessionId });
    const committedState = await db.services.state.get(db.sessionId);
    const outboxBefore = await db.uow.repos().outbox.countAll();

    const result = await createRecovery(db, createRecoveryRuntime(db), createEventProcessor(db)).recover({
      matchId: MatchId.parse(db.sessionId),
      sessionId: db.sessionId,
    });

    expect(result.replayedEvents).toBe(1);
    expect(result.committedEvents).toBe(0);
    expect(result.deduplicatedEvents).toBe(1);
    expect(result.pendingEvents).toHaveLength(0);
    expect((await db.services.state.get(db.sessionId)).version).toBe(committedState.version);
    expect(await db.uow.repos().outbox.countAll()).toBe(outboxBefore);
  });

  it('crash между HOT event и COLD commit: pending из test log фиксируется ровно один раз', async () => {
    await insertRuntimeSnapshot(db, createRecoveryRuntime(db), 202);
    const event = makeRecoveryEvent(db, 102, 1, 41);

    const result = await createRecovery(db, createRecoveryRuntime(db), createEventProcessor(db)).recover({
      matchId: MatchId.parse(db.sessionId),
      sessionId: db.sessionId,
      pendingEvents: [event],
    });

    expect(result.replayedEvents).toBe(1);
    expect(result.committedEvents).toBe(1);
    expect(result.deduplicatedEvents).toBe(0);
    expect(result.pendingEvents).toHaveLength(0);
    const state = await db.services.state.get(db.sessionId);
    expect(state.version).toBe(1);
    expect(state.objectStates['00000000-0000-4000-8000-000000000101']?.taken).toBe(true);
    expect(await db.uow.repos().outbox.countAll()).toBe(1);
  });

  it('повторный recovery не дублирует item/journal/outbox и не является narrative reset', async () => {
    await insertRuntimeSnapshot(db, createRecoveryRuntime(db), 203);
    const event = makeRecoveryEvent(db, 103, 1, 41);
    await createEventProcessor(db).process({ event, sessionId: db.sessionId });
    const before = await db.services.state.get(db.sessionId);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await createRecovery(db, createRecoveryRuntime(db), createEventProcessor(db)).recover({
        matchId: MatchId.parse(db.sessionId),
        sessionId: db.sessionId,
      });
      expect(result.deduplicatedEvents).toBe(1);
      expect(result.committedEvents).toBe(0);
    }

    const after = await db.services.state.get(db.sessionId);
    expect(after.version).toBe(before.version);
    expect(after.endingState).toBe(before.endingState);
    expect(
      (await db.services.journal.listBySession(db.sessionId, 100)).filter(
        (entry) => entry.kind === 'hot_gameplay_committed',
      ),
    ).toHaveLength(1);
    expect(await db.uow.repos().outbox.countAll()).toBe(1);
  });

  it('диагностика сохраняет явный recovery point', async () => {
    const snapshot = await insertRuntimeSnapshot(db, createRecoveryRuntime(db), 204);
    const diagnostics = createRecovery(db, createRecoveryRuntime(db)).getDiagnostics(snapshot);
    expect(diagnostics.transientStateRollback).toBe(true);
    expect(diagnostics.recoveryPoint).toEqual(snapshot.recoveryPoint);
  });
});
