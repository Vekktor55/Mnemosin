import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MatchId,
  WorldEpoch,
  type ColdToHotCommand,
  type CommandId,
  type EventId,
  type HotGameplayEventEnvelope,
  type HotSnapshot,
  type Scalar,
  type SnapshotId,
} from '@mnemosin/contracts';
import {
  ColdCommandProcessor,
  ColdGameplayEventProcessor,
  HotRuntime,
  parseWorldPack,
  SnapshotRecoveryOrchestrator,
  type HotRuntimeConfig,
} from '@mnemosin/core';
import type { ColdTestDb } from './cold-test-setup.js';

const pack = parseWorldPack(readFileSync(join(process.cwd(), 'tests/fixtures/worldpack.v4.test.json'), 'utf8'));
export const RECOVERY_CONFIG: HotRuntimeConfig = {
  movementSpeedCellsPerSecond: 2,
  entityRadius: 0.2,
  collisionEpsilon: 1e-9,
  inputLeaseTicks: 100,
};

export function createRecoveryRuntime(db: ColdTestDb): HotRuntime {
  return new HotRuntime({
    pack,
    players: [{ participantId: db.playerId, spawnPointId: 'player-1' }],
    config: RECOVERY_CONFIG,
    matchId: MatchId.parse(db.sessionId),
    worldEpoch: WorldEpoch.parse(1),
  });
}

export function makeRecoveryCommand(
  db: ColdTestDb,
  revision: number,
  suffix = revision,
  key = `revision-${revision}`,
  value: Scalar = revision,
): ColdToHotCommand {
  return {
    schemaVersion: 1,
    commandId: `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}` as CommandId,
    matchId: MatchId.parse(db.sessionId),
    revision,
    worldEpoch: WorldEpoch.parse(1),
    type: 'prototype.runtime.fact',
    target: { participantId: db.playerId },
    payload: { key, value },
  };
}

export function makeRecoveryEvent(
  db: ColdTestDb,
  suffix: number,
  eventSequence = suffix,
  simulationTick = 40,
): HotGameplayEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}` as EventId,
    matchId: MatchId.parse(db.sessionId),
    worldEpoch: WorldEpoch.parse(1),
    simulationTick,
    serverTimeMs: simulationTick * 50,
    eventSequence,
    actor: { participantId: db.playerId },
    source: { kind: 'hot-runtime', runtimeId: '00000000-0000-4000-8000-000000000002' },
    correlation: { correlationId: '00000000-0000-4000-8000-000000000003', causationId: null },
    type: 'prototype.item.acquired',
    payload: { itemId: '00000000-0000-4000-8000-000000000101', ownerId: db.playerId },
  };
}

/**
 * COLD-процессор привязан к match, которому принадлежит сессия.
 * По умолчанию одна сессия = один match (PROTOTYPE-ONLY); в интеграции match
 * приходит из wiring и может отличаться по значению от sessionId.
 */
export function createEventProcessor(
  db: ColdTestDb,
  matchId = MatchId.parse(db.sessionId),
): ColdGameplayEventProcessor {
  return new ColdGameplayEventProcessor({
    commandRunner: db.idempotency,
    journal: db.services.journal,
    state: db.services.state,
    matchId,
    retry: { sleep: async () => undefined },
  });
}

export function createCommandProcessor(db: ColdTestDb, matchId = MatchId.parse(db.sessionId)): ColdCommandProcessor {
  return new ColdCommandProcessor({
    commandRunner: db.idempotency,
    journal: db.services.journal,
    state: db.services.state,
    matchId,
  });
}

export function createRecovery(
  db: ColdTestDb,
  runtime: HotRuntime,
  eventProcessor = createEventProcessor(db),
): SnapshotRecoveryOrchestrator {
  return new SnapshotRecoveryOrchestrator({
    snapshotRepo: db.uow.repos().snapshots,
    journal: db.services.journal,
    eventProcessor,
    runtime,
  });
}

export async function insertRuntimeSnapshot(
  db: ColdTestDb,
  runtime: HotRuntime,
  suffix: number,
  lastAppliedEventId: EventId | null = null,
): Promise<HotSnapshot> {
  const captured = runtime.captureSnapshot(lastAppliedEventId);
  const snapshot: HotSnapshot = {
    id: `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}` as SnapshotId,
    sessionId: db.sessionId,
    label: `hot-recovery-${suffix}`,
    turnNumber: captured.runtime.simulationTick,
    createdByTurnId: null,
    createdBy: 'SYSTEM',
    state: await db.services.state.get(db.sessionId),
    checksum: 'a'.repeat(64),
    createdAt: new Date().toISOString(),
    snapshotVersion: 1,
    recoveryPoint: captured.recoveryPoint,
    runtime: captured.runtime,
  };
  await db.uow.runInTx(async (scope) => scope.repos.snapshots.insert(snapshot));
  return snapshot;
}
