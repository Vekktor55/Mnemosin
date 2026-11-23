import { z } from 'zod';

import {
  EventId,
  InputSequence,
  InputStreamId,
  MatchId,
  ParticipantId,
  Scalar,
  SimulationTick,
  SnapshotId,
  SessionId,
  TurnId,
  WorldEpoch,
} from '../ids.js';
import { IsoDateTime } from '../time.js';
import { MovementInputSchema, WorldPositionSchema } from '../transport/spatial.js';
import { GameStateSchema } from './state.js';

export const HotRecoveryPointSchema = z
  .object({
    lastAppliedEventId: EventId.nullable(),
    matchId: MatchId,
    coldRevision: z.number().int().nonnegative().safe(),
    worldEpoch: WorldEpoch,
    simulationTick: SimulationTick,
  })
  .strict();
export type HotRecoveryPoint = z.infer<typeof HotRecoveryPointSchema>;

export const HotSnapshotPlayerSchema = z
  .object({
    participantId: ParticipantId,
    position: WorldPositionSchema.strict(),
    direction: MovementInputSchema.strict(),
    velocity: WorldPositionSchema.strict(),
    activeInputStreamId: InputStreamId.nullable(),
    lastProcessedInputSequence: InputSequence.nullable(),
    lastInputTick: SimulationTick.nullable(),
  })
  .strict();
export type HotSnapshotPlayer = z.infer<typeof HotSnapshotPlayerSchema>;

export const HotRuntimeSnapshotSchema = z
  .object({
    simulationTick: SimulationTick,
    players: z.array(HotSnapshotPlayerSchema),
    prototypeFacts: z.record(ParticipantId, z.record(z.string().max(80), Scalar)),
  })
  .strict();
export type HotRuntimeSnapshot = z.infer<typeof HotRuntimeSnapshotSchema>;

/**
 * Snapshot — существующий контейнер SnapshotRepository. Legacy GameState snapshots
 * остаются валидными; HOT v1 добавляет обязательные поля через HotSnapshotSchema.
 */
export const SnapshotSchema = z.object({
  id: SnapshotId,
  sessionId: SessionId,
  label: z.string().min(1).max(120),
  /** Для HOT v1 — simulationTick; для legacy — номер хода. */
  turnNumber: z.number().int().nonnegative(),
  createdByTurnId: TurnId.nullable(),
  createdBy: z.enum(['GM', 'SYSTEM']),
  state: GameStateSchema,
  checksum: z.string().min(8).max(128),
  createdAt: IsoDateTime,
  snapshotVersion: z.literal(1).optional(),
  recoveryPoint: HotRecoveryPointSchema.optional(),
  runtime: HotRuntimeSnapshotSchema.optional(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

/** Версионированный HOT recovery point; не является narrative reset. */
export const HotSnapshotSchema = SnapshotSchema.extend({
  snapshotVersion: z.literal(1),
  recoveryPoint: HotRecoveryPointSchema,
  runtime: HotRuntimeSnapshotSchema,
})
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.state.sessionId !== snapshot.sessionId) {
      context.addIssue({ code: 'custom', message: 'snapshot sessionId must match its COLD state' });
    }
    if (
      snapshot.turnNumber !== snapshot.recoveryPoint.simulationTick ||
      snapshot.runtime.simulationTick !== snapshot.recoveryPoint.simulationTick
    ) {
      context.addIssue({ code: 'custom', message: 'HOT snapshot tick must be one consistent recovery point' });
    }
  });
export type HotSnapshot = z.infer<typeof HotSnapshotSchema>;

export const SnapshotListEntrySchema = SnapshotSchema.omit({ state: true, runtime: true });
export type SnapshotListEntry = z.infer<typeof SnapshotListEntrySchema>;
