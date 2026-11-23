import { z } from 'zod';

import {
  EventId,
  EventSequence,
  InputStreamId,
  MatchId,
  MessageId,
  ParticipantId,
  SimulationTick,
  WorldEpoch,
} from '../ids.js';

import {
  ConnectionClientReadyMessageSchema,
  ConnectionPingMessageSchema,
  ConnectionPongMessageSchema,
  ConnectionReadyMessageSchema,
  ConnectionWelcomeMessageSchema,
  SceneInputAckMessageSchema,
  SceneInputMessageSchema,
  SceneResyncMessageSchema,
  SceneResyncRequiredMessageSchema,
  MovementInputSchema,
  WorldPositionSchema,
} from './spatial.js';
import { SceneDeltaPayloadSchema, SceneKeyframePayloadSchema } from './scene.js';

export const WsErrorCodeSchema = z.enum([
  'AUTH_INVALID',
  'AUTH_EXPIRED',
  'AUTH_FORBIDDEN',
  'PROTOCOL_INVALID_JSON',
  'PROTOCOL_INVALID_MESSAGE',
  'PROTOCOL_UNSUPPORTED_VERSION',
  'CONNECTION_NOT_READY',
  'CONNECTION_SUPERSEDED',
  'MATCH_MEMBERSHIP_REQUIRED',
  'INPUT_INVALID',
  'INPUT_STALE',
  'INPUT_INACTIVE_STREAM',
  'INPUT_NOT_CONTROLLING_ACTOR',
  'RATE_LIMITED',
  'RESYNC_REQUIRED',
  'SERVER_BUSY',
  'INTERNAL_ERROR',
]);
export type WsErrorCode = z.infer<typeof WsErrorCodeSchema>;

export const WsErrorPayloadSchema = z
  .object({
    code: WsErrorCodeSchema,
    messageKey: z.string().min(1).max(128),
    retryable: z.boolean(),
    correlationId: z.string().uuid().optional(),
    relatedMessageId: MessageId.optional(),
    relatedCommandId: z.string().uuid().optional(),
    details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  })
  .strict();
export type WsErrorPayload = z.infer<typeof WsErrorPayloadSchema>;

export const ConnectionErrorMessageSchema = WsErrorPayloadSchema;
export type ConnectionErrorMessage = WsErrorPayload;

export const RealtimeConnectionWelcomeMessageSchema = ConnectionWelcomeMessageSchema.extend({
  actorId: ParticipantId,
  inputStreamId: InputStreamId,
  projectionKind: z.enum(['player', 'observer']),
}).strict();

/** Network-only strict form; standalone P04 schemas deliberately retain Zod stripping tests. */
export const StrictSceneInputMessageSchema = SceneInputMessageSchema.extend({
  input: MovementInputSchema.strict(),
}).strict();

export const StrictSceneInputAckMessageSchema = SceneInputAckMessageSchema.extend({
  authoritativePosition: WorldPositionSchema.strict(),
  authoritativeVelocity: WorldPositionSchema.strict().optional(),
}).strict();

export const WsClientPayloadSchemas = {
  'connection:client-ready': ConnectionClientReadyMessageSchema.strict(),
  'connection:ping': ConnectionPingMessageSchema.strict(),
  'scene:input': StrictSceneInputMessageSchema,
  'scene:resync': SceneResyncMessageSchema.strict(),
} as const;

export const WsServerPayloadSchemas = {
  'connection:welcome': RealtimeConnectionWelcomeMessageSchema,
  'connection:ready': ConnectionReadyMessageSchema.strict(),
  'connection:pong': ConnectionPongMessageSchema.strict(),
  'connection:error': ConnectionErrorMessageSchema,
  'scene:keyframe': SceneKeyframePayloadSchema,
  'scene:delta': SceneDeltaPayloadSchema,
  'scene:input-ack': StrictSceneInputAckMessageSchema,
  'scene:resync-required': SceneResyncRequiredMessageSchema.strict(),
  /** Reliable durable gameplay event; не пересылается через scene:delta coalescing. */
  'scene:durable-event': z
    .object({
      eventId: EventId,
      eventSequence: EventSequence,
      matchId: MatchId,
      worldEpoch: WorldEpoch,
      simulationTick: SimulationTick,
      payload: z.unknown(),
    })
    .strict(),
} as const;

export type WsClientMessageType = keyof typeof WsClientPayloadSchemas;
export type WsServerMessageType = keyof typeof WsServerPayloadSchemas;
export const WS_CLIENT_MESSAGE_TYPES = Object.freeze(Object.keys(WsClientPayloadSchemas) as WsClientMessageType[]);
export const WS_SERVER_MESSAGE_TYPES = Object.freeze(Object.keys(WsServerPayloadSchemas) as WsServerMessageType[]);

/**
 * WS v4 metadata intentionally lives in typed payloads/envelope fields rather
 * than a shared bag: commandId/eventSequence are reserved for later COLD and
 * durable-event catalogs, while scene/input metadata is scoped by its schema.
 */
const envelopeMetadata = {
  protocolVersion: z.literal('v1'),
  schemaVersion: z.literal(1),
  messageId: MessageId,
  matchId: MatchId.optional(),
} as const;

function envelope<TType extends string, TPayload extends z.ZodTypeAny>(type: TType, payload: TPayload) {
  return z.object({ ...envelopeMetadata, type: z.literal(type), payload }).strict();
}

export const WsClientEnvelopeSchema = z.discriminatedUnion('type', [
  envelope('connection:client-ready', WsClientPayloadSchemas['connection:client-ready']),
  envelope('connection:ping', WsClientPayloadSchemas['connection:ping']),
  envelope('scene:input', WsClientPayloadSchemas['scene:input']),
  envelope('scene:resync', WsClientPayloadSchemas['scene:resync']),
]);
export type WsClientEnvelope = z.infer<typeof WsClientEnvelopeSchema>;

export const WsServerEnvelopeSchema = z.discriminatedUnion('type', [
  envelope('connection:welcome', WsServerPayloadSchemas['connection:welcome']),
  envelope('connection:ready', WsServerPayloadSchemas['connection:ready']),
  envelope('connection:pong', WsServerPayloadSchemas['connection:pong']),
  envelope('connection:error', WsServerPayloadSchemas['connection:error']),
  envelope('scene:keyframe', WsServerPayloadSchemas['scene:keyframe']),
  envelope('scene:delta', WsServerPayloadSchemas['scene:delta']),
  envelope('scene:input-ack', WsServerPayloadSchemas['scene:input-ack']),
  envelope('scene:resync-required', WsServerPayloadSchemas['scene:resync-required']),
  envelope('scene:durable-event', WsServerPayloadSchemas['scene:durable-event']),
]);
export type WsServerEnvelope = z.infer<typeof WsServerEnvelopeSchema>;

export const WsEnvelopeSchema = z.discriminatedUnion('type', [
  ...WsClientEnvelopeSchema.options,
  ...WsServerEnvelopeSchema.options,
]);
export type WsEnvelope = z.infer<typeof WsEnvelopeSchema>;

export type WsEnvelopeOf<TType extends WsEnvelope['type']> = Extract<WsEnvelope, { type: TType }>;
export type WsEnvelopePayload<TType extends WsEnvelope['type']> = WsEnvelopeOf<TType>['payload'];

export const WS_ERROR_CODES = WsErrorCodeSchema.options;
export type WsErrorDetails = NonNullable<WsErrorPayload['details']>;

/**
 * Полный WS envelope type; metadata распределены по семантическим payload scopes.
 */
export type WsRealtimeEnvelope = WsEnvelope;

/** Коды закрытия WS-соединения (NETWORK_PROTOCOL.md §19). */
export const WS_CLOSE_CODE = {
  AUTH_INVALID: 4401,
  AUTH_FORBIDDEN: 4403,
  IDLE_TIMEOUT: 4408,
  RATE_LIMIT: 4429,
  BACKPRESSURE: 4429,
  INTERNAL: 4500,
} as const;
export type WsCloseCode = (typeof WS_CLOSE_CODE)[keyof typeof WS_CLOSE_CODE];
