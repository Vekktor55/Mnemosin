import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InputStreamId, MatchId, WorldEpoch } from '@mnemosin/contracts';
import { openColdTestDb, type ColdTestDb } from './cold-test-setup.js';
import {
  createCommandProcessor,
  createRecoveryRuntime,
  insertRuntimeSnapshot,
  makeRecoveryCommand,
} from './cold-recovery-fixtures.js';

describe('P06 HotRuntime snapshot capture/restore', () => {
  let db: ColdTestDb;

  beforeEach(async () => {
    db = await openColdTestDb('hot-runtime-recovery');
  });

  afterEach(async () => await db.close());

  it('восстанавливает позицию/tick/facts, но очищает старые input streams и held direction', async () => {
    const original = createRecoveryRuntime(db);
    const command = makeRecoveryCommand(db, 1, 10, 'restored-fact', 'yes');
    original.receiveColdCommand(command);
    original.tick();
    original.receiveInput(db.playerId, {
      inputStreamId: InputStreamId.parse('00000000-0000-4000-8000-000000000201'),
      inputSequence: 1,
      input: { directionX: 1, directionY: 0 },
    });
    original.tick();
    original.tick();
    const captured = original.captureSnapshot(null);
    const expectedPosition = original.getState().players[0]?.position;

    const restored = createRecoveryRuntime(db);
    restored.restoreFromSnapshot(captured.runtime, captured.recoveryPoint);
    const player = restored.getState().players[0];

    expect(restored.getState().simulationTick).toBe(captured.runtime.simulationTick);
    expect(player?.position).toEqual(expectedPosition);
    expect(player?.activeInputStreamId).toBeNull();
    expect(player?.lastProcessedInputSequence).toBeNull();
    expect(player?.direction).toEqual({ directionX: 0, directionY: 0 });
    expect(player?.velocity).toEqual({ x: 0, y: 0 });
    expect(restored.getColdBoundaryState().prototypeFacts[db.playerId]?.['restored-fact']).toBe('yes');
  });

  it('не принимает snapshot с другим worldEpoch', async () => {
    const snapshot = await insertRuntimeSnapshot(db, createRecoveryRuntime(db), 500);
    const restored = createRecoveryRuntime(db);

    expect(() =>
      restored.restoreFromSnapshot(snapshot.runtime, {
        ...snapshot.recoveryPoint,
        worldEpoch: WorldEpoch.parse(2),
      }),
    ).toThrow('matchId/worldEpoch');
  });

  it('не принимает runtime/recovery point с разными simulationTick', async () => {
    const snapshot = await insertRuntimeSnapshot(db, createRecoveryRuntime(db), 501);
    const restored = createRecoveryRuntime(db);

    expect(() =>
      restored.restoreFromSnapshot(snapshot.runtime, {
        ...snapshot.recoveryPoint,
        simulationTick: snapshot.recoveryPoint.simulationTick + 1,
      }),
    ).toThrow('tick');
  });

  it('применяет восстановленную COLD revision только на следующей границе тика', async () => {
    const original = createRecoveryRuntime(db);
    const commands = createCommandProcessor(db);
    const first = makeRecoveryCommand(db, 1);
    await commands.process({ command: first, sessionId: db.sessionId });
    original.receiveColdCommand(first);
    original.tick();
    const captured = original.captureSnapshot(null);

    const restored = createRecoveryRuntime(db);
    restored.restoreFromSnapshot(captured.runtime, captured.recoveryPoint);
    const second = makeRecoveryCommand(db, 2);
    restored.receiveColdCommand(second);
    expect(restored.getColdBoundaryState().coldRevision).toBe(1);
    restored.tick();
    expect(restored.getColdBoundaryState().coldRevision).toBe(2);
  });

  it('captureSnapshot сохраняет явный match/world/tick recovery context', () => {
    const runtime = createRecoveryRuntime(db);
    const captured = runtime.captureSnapshot(null);
    expect(captured.recoveryPoint).toEqual({
      lastAppliedEventId: null,
      matchId: MatchId.parse(db.sessionId),
      coldRevision: 0,
      worldEpoch: 1,
      simulationTick: 0,
    });
  });
});
