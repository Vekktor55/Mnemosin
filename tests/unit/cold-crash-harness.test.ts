import { describe, expect, it, beforeEach } from 'vitest';

import { type MatchId, type SessionId, type HotGameplayEventEnvelope, type HotSnapshot } from '@mnemosin/contracts';
import { CrashRestartHarness } from '@mnemosin/core';
import { type SnapshotRecoveryOrchestrator } from '@mnemosin/core';

const uuid = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const at = '2026-11-22T12:00:00.000Z';

function makeHotSnapshot(overrides: Partial<HotSnapshot> = {}): HotSnapshot {
  return {
    id: uuid(20),
    sessionId: uuid(1),
    label: 'hot:v1',
    turnNumber: 40,
    createdByTurnId: null,
    createdBy: 'SYSTEM',
    state: {
      sessionId: uuid(1),
      worldState: { currentLocationId: uuid(6), timeOfDay: 'NIGHT', weather: null, ambientFlags: {} },
      storyFlags: {},
      objectStates: {},
      playerKnowledge: {},
      endingState: null,
      version: 1,
      updatedAt: at,
    },
    checksum: 'a'.repeat(64),
    createdAt: at,
    snapshotVersion: 1,
    recoveryPoint: {
      lastAppliedEventId: uuid(10),
      matchId: uuid(1),
      coldRevision: 2,
      worldEpoch: 1,
      simulationTick: 40,
    },
    runtime: {
      simulationTick: 40,
      players: [
        {
          participantId: uuid(2),
          position: { x: 1.5, y: 0.5 },
          direction: { directionX: 0, directionY: 0 },
          velocity: { x: 0, y: 0 },
          activeInputStreamId: null,
          lastProcessedInputSequence: null,
          lastInputTick: null,
        },
      ],
      prototypeFacts: {},
    },
    ...overrides,
  };
}

function makeEvent(overrides: Partial<HotGameplayEventEnvelope> = {}): HotGameplayEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: uuid(10),
    matchId: uuid(1),
    worldEpoch: 1,
    simulationTick: 40,
    serverTimeMs: 2_000,
    eventSequence: 1,
    actor: { participantId: uuid(2) },
    source: { kind: 'hot-runtime', runtimeId: uuid(3) },
    correlation: { correlationId: uuid(4), causationId: null },
    type: 'prototype.item.acquired',
    payload: { itemId: uuid(5), ownerId: uuid(2) },
    ...overrides,
  };
}

describe('P06 Crash/Restart Harness', () => {
  let harness: CrashRestartHarness;
  let mockRecovery: SnapshotRecoveryOrchestrator;

  beforeEach(() => {
    mockRecovery = {
      recover: async () => ({
        recoveredSnapshot: makeHotSnapshot(),
        replayedEvents: 2,
        appliedColdRevisions: 1,
      }),
    } as unknown as SnapshotRecoveryOrchestrator;

    harness = new CrashRestartHarness({ recovery: mockRecovery });
  });

  it('records created events; without snapshot, replay is 0 (transient state lost)', async () => {
    harness.recordEventCreated(makeEvent({ eventId: uuid(10) }));
    harness.recordEventCreated(makeEvent({ eventId: uuid(11) }));

    const result = await harness.simulateCrashAndRestart(uuid(1) as SessionId, uuid(1) as MatchId, {
      afterEventCreated: true,
      afterColdCommit: false,
      afterAckSent: false,
      afterSnapshotWritten: false,
    });

    expect(result.window.afterEventCreated).toBe(true);
    expect(result.window.afterColdCommit).toBe(false);
    expect(result.pendingEventsBeforeCrash).toBe(2);
    expect(result.replayedEvents).toBe(0); // no snapshot → no recovery replay
    expect(result.transientStateRollback).toBe(false); // no v1 snapshot to rollback from
    expect(result.recoveredSnapshot).toBeNull();
  });

  it('records cold commits; diagnostics available via getDiagnostics()', async () => {
    harness.recordEventCreated(makeEvent({ eventId: uuid(10) }));
    harness.recordColdCommit();

    const result = await harness.simulateCrashAndRestart(uuid(1) as SessionId, uuid(1) as MatchId, {
      afterEventCreated: true,
      afterColdCommit: true,
      afterAckSent: false,
      afterSnapshotWritten: false,
    });

    expect(result.window.afterColdCommit).toBe(true);
    const diag = harness.getDiagnostics();
    expect(diag.coldCommits).toBe(1);
  });

  it('records snapshots and shows transient state rollback when recovery from v1 snapshot', async () => {
    harness.recordEventCreated(makeEvent({ eventId: uuid(10) }));
    harness.recordSnapshotWritten(makeHotSnapshot());

    const result = await harness.simulateCrashAndRestart(uuid(1) as SessionId, uuid(1) as MatchId, {
      afterEventCreated: true,
      afterColdCommit: true,
      afterAckSent: true,
      afterSnapshotWritten: true,
    });

    expect(result.window.afterSnapshotWritten).toBe(true);
    expect(result.recoveredSnapshot).not.toBeNull();
    expect(result.recoveredSnapshot!.snapshotVersion).toBe(1);
    expect(result.replayedEvents).toBe(2); // mock recovery returns 2
    expect(result.transientStateRollback).toBe(true);
  });

  it('returns null recoveredSnapshot when no snapshot exists', async () => {
    harness.recordEventCreated(makeEvent({ eventId: uuid(10) }));

    const noSnapshotRecovery = {
      recover: async () => ({
        recoveredSnapshot: null as unknown as HotSnapshot,
        replayedEvents: 0,
        appliedColdRevisions: 0,
      }),
    } as unknown as SnapshotRecoveryOrchestrator;

    const noSnapshotHarness = new CrashRestartHarness({ recovery: noSnapshotRecovery });
    const result = await noSnapshotHarness.simulateCrashAndRestart(uuid(1) as SessionId, uuid(1) as MatchId, {
      afterEventCreated: true,
      afterColdCommit: false,
      afterAckSent: false,
      afterSnapshotWritten: false,
    });

    expect(result.recoveredSnapshot).toBeNull();
  });

  it('diagnostics reflect recorded events/commits/snapshots before crash', () => {
    harness.recordEventCreated(makeEvent({ eventId: uuid(10) }));
    harness.recordEventCreated(makeEvent({ eventId: uuid(11) }));
    harness.recordColdCommit();
    harness.recordColdCommit();
    harness.recordSnapshotWritten(makeHotSnapshot());

    const diag = harness.getDiagnostics();
    expect(diag.eventsCreated).toBe(2);
    expect(diag.coldCommits).toBe(2);
    expect(diag.snapshotsWritten).toBe(1);
  });
});
