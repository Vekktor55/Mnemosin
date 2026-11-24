import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import type { SnapshotId, EventId as EventIdType, HotSnapshot, JournalKind } from '@mnemosin/contracts';
import { SnapshotRecoveryOrchestrator, ColdGameplayEventProcessor } from '@mnemosin/core';
import { openColdTestDb, type ColdTestDb } from './cold-test-setup.js';

/**
 * P06: дополнительные ветви SnapshotRecoveryOrchestrator.
 *
 *  - legacy snapshot (без snapshotVersion) отклоняется как неподдерживаемый;
 *  - journal-записи без payload и без toVersion не ломают подсчёт ревизий;
 *  - явный targetSnapshot выбирается по id, а не «последний по дате».
 */
describe('P06 SnapshotRecoveryOrchestrator — ветви форматов и журнала', () => {
  let db: ColdTestDb;
  let orchestrator: SnapshotRecoveryOrchestrator;

  beforeEach(async () => {
    db = await openColdTestDb('cold-snapshot-branches');
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

  async function insertHotSnapshot(
    idSuffix: string,
    coldRevision: number,
    lastAppliedEventId: EventIdType | null = null,
  ): Promise<HotSnapshot> {
    const snapshot: HotSnapshot = {
      id: `00000000-0000-4000-8000-${idSuffix}` as SnapshotId,
      sessionId: db.sessionId,
      label: `hot-snapshot-${idSuffix}`,
      turnNumber: 40,
      createdByTurnId: null,
      createdBy: 'SYSTEM',
      state: await db.services.state.get(db.sessionId),
      checksum: 'd'.repeat(64),
      createdAt: new Date().toISOString(),
      snapshotVersion: 1,
      recoveryPoint: {
        lastAppliedEventId,
        matchId: db.sessionId,
        coldRevision,
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
    return snapshot;
  }

  it('legacy snapshot без snapshotVersion отклоняется как неподдерживаемый формат', async () => {
    const state = await db.services.state.get(db.sessionId);
    await db.uow.runInTx(async (scope) => {
      await scope.repos.snapshots.insert({
        id: '00000000-0000-4000-8000-000000000400' as SnapshotId,
        sessionId: db.sessionId,
        label: 'legacy-snapshot',
        turnNumber: 3,
        createdByTurnId: null,
        createdBy: 'SYSTEM',
        state,
        checksum: 'e'.repeat(64),
        createdAt: new Date().toISOString(),
      });
    });

    await expect(orchestrator.recover({ matchId: db.sessionId, sessionId: db.sessionId })).rejects.toThrow(
      'Only HOT v1 snapshots supported',
    );
  });

  it('явный targetSnapshot выбирается по id, а не по свежести', async () => {
    const older = await insertHotSnapshot('000000000401', 1);
    await insertHotSnapshot('000000000402', 7);

    const result = await orchestrator.recover({
      matchId: db.sessionId,
      sessionId: db.sessionId,
      targetSnapshot: older.id,
    });

    expect(result.recoveredSnapshot.id).toBe(older.id);
    expect(result.recoveredSnapshot.recoveryPoint.coldRevision).toBe(1);
  });

  it('journal-записи без payload и без toVersion не ломают подсчёт COLD-ревизий', async () => {
    await insertHotSnapshot('000000000403', 2);

    await db.services.journal.append({
      sessionId: db.sessionId,
      turnId: null,
      kind: 'state_applied' satisfies JournalKind,
      payload: {},
      traceId: 'empty-payload',
    });

    const result = await orchestrator.recover({
      matchId: db.sessionId,
      sessionId: db.sessionId,
    });

    expect(result.appliedColdRevisions).toBe(0);
    expect(result.replayedEvents).toBe(0);
  });

  it('recovery применяет COLD-ревизии строго после recovery point', async () => {
    await insertHotSnapshot('000000000404', 2);

    await db.services.journal.append({
      sessionId: db.sessionId,
      turnId: null,
      kind: 'state_applied' satisfies JournalKind,
      payload: { toVersion: 5 },
      traceId: 'revision-after-snapshot',
    });

    const result = await orchestrator.recover({
      matchId: db.sessionId,
      sessionId: db.sessionId,
    });

    expect(result.appliedColdRevisions).toBe(1);
  });

  it('replay отслеживает lastAppliedEventId и не повторяет уже применённое событие', async () => {
    const appliedEventId = '00000000-0000-4000-8000-000000000410' as EventIdType;
    await insertHotSnapshot('000000000405', 2, appliedEventId);

    await db.services.journal.append({
      sessionId: db.sessionId,
      turnId: null,
      kind: 'hot_gameplay_committed' satisfies JournalKind,
      payload: {
        event: {
          schemaVersion: 1,
          eventId: appliedEventId,
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
      traceId: 'already-applied',
    });

    const result = await orchestrator.recover({
      matchId: db.sessionId,
      sessionId: db.sessionId,
    });

    expect(result.replayedEvents).toBe(0);
    expect(result.pendingEvents).toHaveLength(0);
  });
});
