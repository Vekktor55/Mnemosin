import { z } from 'zod';
import {
  MatchId,
  SessionId,
  CommandId,
  InputStreamId,
  InputSequence,
  SceneSequence,
  SimulationTick,
  EventId,
  EventSequence,
  WorldEpoch,
  ProjectionRevision,
  ConnectionEpoch,
} from '../ids.js';

/**
 * Общий message envelope для WebSocket v4 (P02).
 *
 * Все WS-сообщения должны иметь этот формат.
 * protocolVersion — major версия транспортного контракта (несовместимые изменения).
 * schemaVersion — версия конкретной payload-схемы (для эволюции данных).
 */
export const WSEnvelopeSchema = z.object({
  protocolVersion: z.literal('v1'),
  schemaVersion: z.number().int().positive().default(1),
  type: z.string().min(1).max(64),
  messageId: z.string().min(8).max(64), // уникальная транспортная отправка
  matchId: MatchId.optional(),
  sessionId: SessionId.optional(),
  // domain-specific metadata (внутри payload могут дублироваться с уточнением):
  commandId: CommandId.optional(),
  inputStreamId: InputStreamId.optional(),
  inputSequence: InputSequence.optional(),
  sceneSequence: SceneSequence.optional(),
  simulationTick: SimulationTick.optional(),
  eventId: EventId.optional(),
  eventSequence: EventSequence.optional(),
  worldEpoch: WorldEpoch.optional(),
  projectionRevision: ProjectionRevision.optional(),
  connectionEpoch: ConnectionEpoch.optional(),
  clientSentAt: z.number().int().nonnegative().optional(), // только для диагностики
  payload: z.unknown(),
});
export type WSEnvelope = z.infer<typeof WSEnvelopeSchema>;

/**
 * Client → Server message types (P02 minimal catalog per NETWORK_PROTOCOL.md §6.1).
 * Состав union отражает реальные реализованные команды. Не добавлять несуществующие функции.
 */
export const WSClientMessageType = z.enum([
  'connection:client-ready',
  'connection:ping',
  'scene:input',
  'scene:resync',
  'interaction:command',
  'chat:send',
  'andrew:ask',
  'domain:command',
  'observer:command',
]);
export type WSClientMessageType = z.infer<typeof WSClientMessageType>;

/**
 * Server → Client message types (P02 minimal catalog per NETWORK_PROTOCOL.md §6.2).
 */
export const WSServerMessageType = z.enum([
  'connection:welcome',
  'connection:ready',
  'connection:pong',
  'connection:error',
  'scene:keyframe',
  'scene:delta',
  'scene:input-ack',
  'scene:resync-required',
  'command:result',
  'domain:event',
  'chat:message',
  'chat:delivery',
  'andrew:status',
  'andrew:reply',
  'match:projection',
  'observer:projection',
  'developer:diagnostic',
]);
export type WSServerMessageType = z.infer<typeof WSServerMessageType>;

/**
 * HOT → COLD durable gameplay event envelope (P02, per HOT_COLD_DESIGN.md §7.2).
 */
export const HotGameplayEventEnvelopeSchema = z.object({
  schemaVersion: z.number().int().positive(),
  eventId: EventId,
  matchId: MatchId,
  worldEpoch: WorldEpoch,
  simulationTick: SimulationTick,
  simulationTimeMs: z.number().int().nonnegative(),
  eventSequence: EventSequence,
  type: z.string().min(1).max(64),
  entityIds: z.array(z.string().uuid()).min(1),
  correlationId: z.string().max(64).optional(),
  causationId: z.string().max(64).optional(),
  payload: z.unknown(),
});
export type HotGameplayEventEnvelope = z.infer<typeof HotGameplayEventEnvelopeSchema>;

/**
 * COLD → HOT command envelope (P02, per HOT_COLD_DESIGN.md §7.3).
 */
export const ColdToHotCommandEnvelopeSchema = z.object({
  schemaVersion: z.number().int().positive(),
  commandId: CommandId,
  matchId: MatchId,
  coldRevision: z.number().int().nonnegative(),
  issuedAtEventId: EventId.optional(),
  type: z.string().min(1).max(64),
  payload: z.unknown(),
});
export type ColdToHotCommandEnvelope = z.infer<typeof ColdToHotCommandEnvelopeSchema>;

/**
 * Scene keyframe payload (P02, per NETWORK_PROTOCOL.md §9.2).
 */
export const SceneKeyframePayloadSchema = z.object({
  matchId: MatchId,
  worldEpoch: WorldEpoch,
  snapshotId: z.string().uuid(),
  sceneSequence: SceneSequence,
  simulationTick: SimulationTick,
  serverTimeMs: z.number().int().nonnegative(),
  projectionRevision: ProjectionRevision,
  worldPackVersion: z.string().max(20),
  ownActorState: z.unknown().optional(), // OwnActorSceneState — определяется в scene.ts
  entities: z.array(z.unknown()), // ProjectedSceneEntity[]
  objects: z.array(z.unknown()), // ProjectedSceneObject[]
  environment: z.unknown(), // ProjectedEnvironmentState
  lastProcessedInputSequence: InputSequence.optional(),
  inputStreamId: InputStreamId.optional(),
});
export type SceneKeyframePayload = z.infer<typeof SceneKeyframePayloadSchema>;

/**
 * Scene delta payload (P02, per NETWORK_PROTOCOL.md §9.3).
 */
export const SceneDeltaPayloadSchema = z.object({
  matchId: MatchId,
  worldEpoch: WorldEpoch,
  sceneSequence: SceneSequence,
  baseSceneSequence: SceneSequence,
  simulationTick: SimulationTick,
  serverTimeMs: z.number().int().nonnegative(),
  projectionRevision: ProjectionRevision,
  entityUpserts: z.array(z.unknown()), // ProjectedSceneEntity[]
  entityRemovals: z.array(z.string().uuid()),
  objectUpserts: z.array(z.unknown()), // ProjectedSceneObject[]
  objectRemovals: z.array(z.string().uuid()),
  environmentPatch: z.record(z.string(), z.unknown()).optional(),
  ownActorState: z.unknown().optional(),
  lastProcessedInputSequence: InputSequence.optional(),
  inputStreamId: InputStreamId.optional(),
});
export type SceneDeltaPayload = z.infer<typeof SceneDeltaPayloadSchema>;

/**
 * Interaction command payload (P02, per NETWORK_PROTOCOL.md §11.1).
 */
export const InteractionCommandPayloadSchema = z.object({
  commandId: CommandId,
  targetId: z.string().uuid(),
  action: z.string().min(1).max(64),
  expectedObjectRevision: z.number().int().nonnegative().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});
export type InteractionCommandPayload = z.infer<typeof InteractionCommandPayloadSchema>;

/**
 * Chat send payload (P02, per NETWORK_PROTOCOL.md §12.2).
 */
export const ChatSendPayloadSchema = z.object({
  commandId: CommandId,
  mode: z.enum(['public', 'whisper', 'private']),
  recipientId: z.string().uuid().optional(),
  content: z.string().min(1).max(4000),
  clientMessageId: z.string().uuid().optional(),
});
export type ChatSendPayload = z.infer<typeof ChatSendPayloadSchema>;

/**
 * Andrew ask payload (P02, per NETWORK_PROTOCOL.md §14.1).
 */
export const AndrewAskPayloadSchema = z.object({
  commandId: CommandId,
  text: z.string().min(1).max(4000),
  interactionType: z.string().max(64).optional(),
});
export type AndrewAskPayload = z.infer<typeof AndrewAskPayloadSchema>;

/**
 * Domain command payload wrapper (P02, per NETWORK_PROTOCOL.md §13.1).
 * Конкретные commands добавляются через discriminated union в domain/commands.ts.
 */
export const DomainCommandPayloadSchema = z.object({
  commandId: CommandId,
  commandType: z.string().min(1).max(64),
  payload: z.unknown(),
});
export type DomainCommandPayload = z.infer<typeof DomainCommandPayloadSchema>;

/**
 * Observer command payload (P02, per NETWORK_PROTOCOL.md §15.3).
 */
export const ObserverCommandPayloadSchema = z.object({
  commandId: CommandId,
  action: z.string().min(1).max(64),
  target: z.string().uuid().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});
export type ObserverCommandPayload = z.infer<typeof ObserverCommandPayloadSchema>;
