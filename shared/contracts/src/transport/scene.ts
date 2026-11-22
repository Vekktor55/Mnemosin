import { z } from 'zod';

import {
  InputSequence,
  InputStreamId,
  MatchId,
  ObjectId,
  ParticipantId,
  ProjectionRevision,
  SceneSequence,
  SimulationTick,
  SnapshotId,
  WorldEpoch,
  WorldId,
  FloorId,
  WorldSpaceId,
} from '../ids.js';

import { WorldPositionSchema } from './spatial.js';

/** Публичная позиция сущности; скрытые игровые факты здесь отсутствуют по построению. */
export const PlayerSceneEntitySchema = z
  .object({
    participantId: ParticipantId,
    position: WorldPositionSchema.strict(),
    velocity: WorldPositionSchema.strict(),
  })
  .strict();
export type PlayerSceneEntity = z.infer<typeof PlayerSceneEntitySchema>;

/** Расширенная Observer DTO. Инфраструктурные секреты не входят в эту схему. */
export const ObserverSceneEntitySchema = PlayerSceneEntitySchema.extend({
  hiddenRole: z.string().max(64).nullable(),
  infected: z.boolean(),
}).strict();
export type ObserverSceneEntity = z.infer<typeof ObserverSceneEntitySchema>;

export const SceneObjectSchema = z
  .object({
    objectId: ObjectId,
    position: WorldPositionSchema.strict(),
    portalState: z.enum(['open', 'closed', 'locked']).optional(),
  })
  .strict();
export type SceneObject = z.infer<typeof SceneObjectSchema>;

export const SceneEnvironmentSchema = z
  .object({ worldId: WorldId, floorId: FloorId, worldSpaceId: WorldSpaceId })
  .strict();
export type SceneEnvironment = z.infer<typeof SceneEnvironmentSchema>;

export const PlayerProjectionSchema = z
  .object({
    projectionKind: z.literal('player'),
    entities: z.array(PlayerSceneEntitySchema),
    objects: z.array(SceneObjectSchema),
    environment: SceneEnvironmentSchema,
  })
  .strict();
export type PlayerProjection = z.infer<typeof PlayerProjectionSchema>;

export const ObserverProjectionSchema = z
  .object({
    projectionKind: z.literal('observer'),
    entities: z.array(ObserverSceneEntitySchema),
    objects: z.array(SceneObjectSchema),
    environment: SceneEnvironmentSchema,
  })
  .strict();
export type ObserverProjection = z.infer<typeof ObserverProjectionSchema>;

export const SceneProjectionSchema = z.discriminatedUnion('projectionKind', [
  PlayerProjectionSchema,
  ObserverProjectionSchema,
]);
export type SceneProjection = z.infer<typeof SceneProjectionSchema>;

export const OwnActorSceneStateSchema = PlayerSceneEntitySchema;
export type OwnActorSceneState = PlayerSceneEntity;

const sceneMetadata = {
  matchId: MatchId,
  worldEpoch: WorldEpoch,
  sceneSequence: SceneSequence,
  simulationTick: SimulationTick,
  serverTimeMs: z.number().int().nonnegative().safe(),
  projectionRevision: ProjectionRevision,
} as const;

export const SceneKeyframePayloadSchema = z
  .object({
    ...sceneMetadata,
    snapshotId: SnapshotId,
    worldPackVersion: z.string().min(1).max(64),
    projection: SceneProjectionSchema,
    ownActorState: OwnActorSceneStateSchema.optional(),
    lastProcessedInputSequence: InputSequence.optional(),
    inputStreamId: InputStreamId.optional(),
  })
  .strict();
export type SceneKeyframePayload = z.infer<typeof SceneKeyframePayloadSchema>;

const deltaChanges = {
  entityUpserts: z.array(z.union([ObserverSceneEntitySchema, PlayerSceneEntitySchema])),
  entityRemovals: z.array(ParticipantId),
  objectUpserts: z.array(SceneObjectSchema),
  objectRemovals: z.array(ObjectId),
  environment: SceneEnvironmentSchema.optional(),
  ownActorState: OwnActorSceneStateSchema.optional(),
  lastProcessedInputSequence: InputSequence.optional(),
  inputStreamId: InputStreamId.optional(),
} as const;

export const SceneDeltaPayloadSchema = z
  .object({
    ...sceneMetadata,
    baseSceneSequence: SceneSequence,
    projectionKind: z.enum(['player', 'observer']),
    ...deltaChanges,
  })
  .strict()
  .superRefine((delta, context) => {
    if (delta.baseSceneSequence >= delta.sceneSequence) {
      context.addIssue({ code: 'custom', message: 'baseSceneSequence must precede sceneSequence' });
    }
    for (const entity of delta.entityUpserts) {
      if (delta.projectionKind === 'player' && ('hiddenRole' in entity || 'infected' in entity)) {
        context.addIssue({ code: 'custom', message: 'player delta cannot contain observer entity fields' });
      }
      if (delta.projectionKind === 'observer' && !('hiddenRole' in entity && 'infected' in entity)) {
        context.addIssue({ code: 'custom', message: 'observer delta requires complete observer entity fields' });
      }
    }
  });
export type SceneDeltaPayload = z.infer<typeof SceneDeltaPayloadSchema>;
