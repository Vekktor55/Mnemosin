import { z } from 'zod';

import {
  CommandId,
  EventId,
  EventSequence,
  MatchId,
  ObjectId,
  ParticipantId,
  Scalar,
  SimulationTick,
  WorldEpoch,
} from '../ids.js';
import { IsoDateTime } from '../time.js';

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

const hotEventMetadata = {
  schemaVersion: z.literal(1),
  eventId: EventId,
  matchId: MatchId,
  worldEpoch: WorldEpoch,
  simulationTick: SimulationTick,
  serverTimeMs: z.number().int().nonnegative().safe(),
  eventSequence: EventSequence,
  actor: z.object({ participantId: ParticipantId }).strict(),
  source: z.object({ kind: z.literal('hot-runtime'), runtimeId: z.string().uuid() }).strict(),
  correlation: z.object({ correlationId: z.string().uuid(), causationId: EventId.nullable() }).strict(),
} as const;

export const HotGameplayEventPayloadSchemas = {
  'prototype.item.acquired': z.object({ itemId: ObjectId, ownerId: ParticipantId }).strict(),
  'prototype.filter.depleted': z.object({ filterId: ObjectId }).strict(),
  'prototype.capture.recorded': z.object({ capturedParticipantId: ParticipantId }).strict(),
} as const;
export type HotGameplayEventType = keyof typeof HotGameplayEventPayloadSchemas;

function hotEvent<TType extends HotGameplayEventType>(type: TType) {
  return z
    .object({ ...hotEventMetadata, type: z.literal(type), payload: HotGameplayEventPayloadSchemas[type] })
    .strict();
}

/** HOT → COLD durable gameplay events; не WebSocket scene delta и не narrative reset. */
export const HotGameplayEventEnvelopeSchema = z.discriminatedUnion('type', [
  hotEvent('prototype.item.acquired'),
  hotEvent('prototype.filter.depleted'),
  hotEvent('prototype.capture.recorded'),
]);
export type HotGameplayEventEnvelope = z.infer<typeof HotGameplayEventEnvelopeSchema>;
export type HotGameplayEventOf<TType extends HotGameplayEventType> = Extract<HotGameplayEventEnvelope, { type: TType }>;

export const HotGameplayEventAckSchema = z
  .object({
    eventId: EventId,
    matchId: MatchId,
    worldEpoch: WorldEpoch,
    eventSequence: EventSequence,
    simulationTick: SimulationTick,
    outcome: z.enum(['committed', 'replayed']),
    coldStateVersion: z.number().int().nonnegative().safe(),
    committedAt: IsoDateTime,
  })
  .strict();
export type HotGameplayEventAck = z.infer<typeof HotGameplayEventAckSchema>;

export const HotGameplayJournalPayloadSchema = z.object({ event: HotGameplayEventEnvelopeSchema }).strict();
export type HotGameplayJournalPayload = z.infer<typeof HotGameplayJournalPayloadSchema>;

const coldCommandMetadata = {
  schemaVersion: z.literal(1),
  commandId: CommandId,
  matchId: MatchId,
  revision: z.number().int().positive().safe(),
  worldEpoch: WorldEpoch,
  issuedAtEventId: EventId.optional(),
} as const;

/** P06 test-only update: проверяет ordering без введения правил дверей/света P07. */
export const ColdToHotCommandSchema = z
  .object({
    ...coldCommandMetadata,
    type: z.literal('prototype.runtime.fact'),
    target: z.object({ participantId: ParticipantId }).strict(),
    payload: z.object({ key: z.string().min(1).max(80), value: Scalar }).strict(),
  })
  .strict();
export type ColdToHotCommand = z.infer<typeof ColdToHotCommandSchema>;
/** Совместимость с P02-именем конверта. */
export const ColdToHotCommandEnvelopeSchema = ColdToHotCommandSchema;
export type ColdToHotCommandEnvelope = ColdToHotCommand;
