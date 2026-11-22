import { z } from 'zod';

import { CommandId, EventId, EventSequence, MatchId, SimulationTick, WorldEpoch } from '../ids.js';

export {
  WsClientEnvelopeSchema as WSClientMessageSchema,
  WsServerEnvelopeSchema as WSServerMessageSchema,
  WS_CLIENT_MESSAGE_TYPES as WS_CLIENT_TYPES,
  WS_SERVER_MESSAGE_TYPES as WS_SERVER_TYPES,
  WsClientPayloadSchemas as WSClientPayloadSchemas,
  WsServerPayloadSchemas as WSServerPayloadSchemas,
  type WsClientMessageType as WSClientMessageType,
  type WsServerMessageType as WSServerMessageType,
} from './realtime.js';
export {
  SceneDeltaPayloadSchema,
  SceneKeyframePayloadSchema,
  type SceneDeltaPayload,
  type SceneKeyframePayload,
} from './scene.js';

/** HOT → COLD durable gameplay event envelope; не является WebSocket payload. */
export const HotGameplayEventEnvelopeSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    eventId: EventId,
    matchId: MatchId,
    worldEpoch: WorldEpoch,
    simulationTick: SimulationTick,
    simulationTimeMs: z.number().int().nonnegative().safe(),
    eventSequence: EventSequence,
    type: z.string().min(1).max(64),
    entityIds: z.array(z.string().uuid()).min(1),
    correlationId: z.string().uuid().optional(),
    causationId: z.string().uuid().optional(),
    payload: z.unknown(),
  })
  .strict();
export type HotGameplayEventEnvelope = z.infer<typeof HotGameplayEventEnvelopeSchema>;

/** COLD → HOT command envelope; конкретные payload задаются доменными этапами. */
export const ColdToHotCommandEnvelopeSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    commandId: CommandId,
    matchId: MatchId,
    coldRevision: z.number().int().nonnegative().safe(),
    issuedAtEventId: EventId.optional(),
    type: z.string().min(1).max(64),
    payload: z.unknown(),
  })
  .strict();
export type ColdToHotCommandEnvelope = z.infer<typeof ColdToHotCommandEnvelopeSchema>;
