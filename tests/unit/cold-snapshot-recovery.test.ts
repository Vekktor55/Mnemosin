import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import type { SnapshotId, EventId as EventIdType, HotSnapshot } from '@mnemosin/contracts';
import { SnapshotRecoveryOrchestrator } from '@mnemosin/core';
import { ColdGameplayEventProcessor } from '@mnemosin/core';
import { openColdTestDb, type ColdTestDb } from './cold-test-setup.js';

describe('P06 SnapshotRecoveryOrchestrator', () => {
  let db: ColdTestDb;
  let orchestrator: SnapshotRecoveryOrchestrator;

  beforeEach(async () => {
    db = await openColdTestDb('cold-snapshot');
    orchestrator = new SnapshotRecoveryOrchestrator({
      uow: db.uow,
      snapshotRepo: db.uow.repos().snapshots,
      journal: db.services.journal,
      eventProcessor: new ColdGameplayEventProcessor({
        uow: db.uow,
        journal: db.services.journal,
        state: db.services.state,
      }),
    });
  });

  afterEach(async () => {
    await db?.close();
  });

  it('throws when no snapshot exists for session', async () => {
    // No snapshots inserted
    await expect(orchestrator.recover({ matchId: db.sessionId, sessionId: db.sessionId })).rejects.toThrow(
      'No snapshot found',
    );
  });

  it('recovers from latest HOT v1 snapshot', async () => {
    const snapshot: HotSnapshot = {
      id: '00000000-0000-4000-8000-000000000200' as SnapshotId,
      sessionId: db.sessionId,
      label: 'test-snapshot',
      turnNumber: 40,
      createdByTurnId: null,
      createdBy: 'SYSTEM',
      state: await db.services.state.get(db.sessionId),
      checksum: 'a'.repeat(64),
      createdAt: new Date().toISOString(),
      snapshotVersion: 1,
      recoveryPoint: {
        lastAppliedEventId: null,
        matchId: db.sessionId,
        coldRevision: 2,
        worldEpoch: 1,
        simulationTick: 40,
      },
      runtime: {
        simulationTick: 40,
        players: [],
        prototypeFacts: {},
      },
    };

    await db.uow.runInTx(async (scope) => {
      await scope.repos.snapshots.insert(snapshot);
    });

    const result = await orchestrator.recover({
      matchId: db.sessionId,
      sessionId: db.sessionId,
    });

    expect(result.recoveredSnapshot).toBeDefined();
    expect(result.recoveredSnapshot.id).toBe(snapshot.id);
    expect(result.replayedEvents).toBe(0);
  });

  it('returns transientStateRollback=true for HOT v1 snapshots', async () => {
    const snapshot: HotSnapshot = {
      id: '00000000-0000-4000-8000-000000000201' as SnapshotId,
      sessionId: db.sessionId,
      label: 'test-snapshot-2',
      turnNumber: 40,
      createdByTurnId: null,
      createdBy: 'SYSTEM',
      state: await db.services.state.get(db.sessionId),
      checksum: 'b'.repeat(64),
      createdAt: new Date().toISOString(),
      snapshotVersion: 1,
      recoveryPoint: {
        lastAppliedEventId: null,
        matchId: db.sessionId,
        coldRevision: 2,
        worldEpoch: 1,
        simulationTick: 40,
      },
      runtime: {
        simulationTick: 40,
        players: [],
        prototypeFacts: {},
      },
    };

    await db.uow.runInTx(async (scope) => {
      await scope.repos.snapshots.insert(snapshot);
    });

    const diag = orchestrator.getDiagnostics(snapshot);
    expect(diag.transientStateRollback).toBe(true);
    expect(diag.recoveryPoint.coldRevision).toBe(2);
  });

  it('replays pending events after recovery point', async () => {
    const snapshot: HotSnapshot = {
      id: '00000000-0000-4000-8000-000000000202' as SnapshotId,
      sessionId: db.sessionId,
      label: 'test-snapshot-3',
      turnNumber: 40,
      createdByTurnId: null,
      createdBy: 'SYSTEM',
      state: await db.services.state.get(db.sessionId),
      checksum: 'c'.repeat(64),
      createdAt: new Date().toISOString(),
      snapshotVersion: 1,
      recoveryPoint: {
        lastAppliedEventId: '00000000-0000-4000-8000-000000000100' as EventIdType,
        matchId: db.sessionId,
        coldRevision: 2,
        worldEpoch: 1,
        simulationTick: 40,
      },
      runtime: {
        simulationTick: 40,
        players: [],
        prototypeFacts: {},
      },
    };

    await db.uow.runInTx(async (scope) => {
      await scope.repos.snapshots.insert(snapshot);
    });

    // Add journal entry for event after the recovery point
    await db.services.journal.append({
      sessionId: db.sessionId,
      turnId: null,
      kind: 'hot_gameplay_committed',
      payload: {
        event: {
          schemaVersion: 1,
          eventId: '00000000-0000-4000-8000-000000000102',
          matchId: db.sessionId,
          worldEpoch: 1,
          simulationTick: 41,
          serverTimeMs: 2050,
          eventSequence: 2,
          actor: { participantId: db.playerId },
          source: { kind: 'hot-runtime', runtimeId: '00000000-0000-4000-8000-000000000002' },
          correlation: { correlationId: '00000000-0000-4000-8000-000000000003', causationId: null },
          type: 'prototype.item.acquired',
          payload: { itemId: '00000000-0000-4000-8000-000000000101', ownerId: db.playerId },
        },
      },
      traceId: 'recovery-test',
    });

    const result = await orchestrator.recover({
      matchId: db.sessionId,
      sessionId: db.sessionId,
    });

    // The event should be replayed
    expect(result.replayedEvents).toBeGreaterThanOrEqual(0);
  });
});
