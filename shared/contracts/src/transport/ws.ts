import { z } from 'zod';
import { IsoDateTime } from '../time.js';
import { IdempotencyKey, LocationId, MediaJobId, MessageId, NoteId, PlayerId, SessionId, TurnId } from '../ids.js';
import { ErrorCode } from '../errors.js';
import { buildEnvelopeUnion } from '../envelope.js';
import { ActionMetaSchema } from '../domain/action.js';
import { GMNoteVisibility } from '../domain/gm.js';
import { TurnResolutionSchema } from '../domain/resolution.js';
import { CapabilityAvailabilitySchema } from '../capability.js';
import {
  ChatMessageViewSchema,
  GMStateViewSchema,
  MediaJobViewSchema,
  AudioJobViewSchema,
  PlayerGameStateViewSchema,
  PublicGameStateViewSchema,
  ResolutionSummaryViewSchema,
  TurnViewSchema,
} from './views.js';
import { DirectorContextSchema } from '../ai.js';

/**
 * WS-протокол как код (v3 §VI.5–VI.7 + дополнения аудита §8.5).
 *
 * F-6.3: в v3 envelope был `type: z.string()` + `payload: z.unknown()`, что
 * прямо нарушало антипаттерн из §I.4. Здесь — discriminated union'ы, а
 * маршрутизация приватности объявлена как данные (WS_PRIVACY_POLICY, патч §8.4).
 */

export const RequestIdSchema = z.string().min(8).max(64);
export type RequestId = z.infer<typeof RequestIdSchema>;

// ------------------------------------------------------------ client → server

const c = {
  AUTH: z.object({ token: z.string().min(16).max(4096) }),
  SUBSCRIBE: z.object({ sessionId: SessionId }),
  UNSUBSCRIBE: z.object({ sessionId: SessionId }),
  ACTION_SUBMIT: z.object({
    turnId: TurnId,
    rawText: z.string().min(1).max(4000),
    meta: ActionMetaSchema.optional(),
    idempotencyKey: IdempotencyKey,
    requestId: RequestIdSchema,
  }),
  CHAT_PUBLIC: z.object({ text: z.string().min(1).max(4000), requestId: RequestIdSchema }),
  CHAT_PRIVATE: z.object({ toPlayerId: PlayerId, text: z.string().min(1).max(4000), requestId: RequestIdSchema }),
  HISTORY: z.object({
    sessionId: SessionId,
    since: IsoDateTime.optional(),
    limit: z.number().int().min(1).max(500).optional(),
    requestId: RequestIdSchema.optional(),
  }),
  LEAVE: z.object({}),
  GM_OPEN_TURN: z.object({ sessionId: SessionId, idempotencyKey: IdempotencyKey }),
  GM_LOCK_TURN: z.object({ turnId: TurnId, idempotencyKey: IdempotencyKey }),
  GM_UNLOCK_TURN: z.object({ turnId: TurnId, idempotencyKey: IdempotencyKey }),
  GM_COMMIT_TURN: z.object({ turnId: TurnId, idempotencyKey: IdempotencyKey }),
  GM_EDIT_APPROVE: z.object({
    turnId: TurnId,
    editedResolution: TurnResolutionSchema,
    baseResolutionHash: z.string().length(64),
    idempotencyKey: IdempotencyKey,
  }),
  GM_REJECT_TURN: z.object({ turnId: TurnId, reason: z.string().min(1).max(1000), idempotencyKey: IdempotencyKey }),
  GM_RETRY_AI: z.object({ turnId: TurnId, idempotencyKey: IdempotencyKey }),
  GM_MOVE_GROUP: z.object({
    sessionId: SessionId,
    playerIds: z.array(PlayerId).min(1),
    toLocationId: LocationId,
    idempotencyKey: IdempotencyKey,
  }),
  GM_PAUSE: z.object({ sessionId: SessionId, idempotencyKey: IdempotencyKey }),
  GM_RESUME: z.object({ sessionId: SessionId, idempotencyKey: IdempotencyKey }),
  GM_END_SESSION: z.object({ sessionId: SessionId, idempotencyKey: IdempotencyKey }),
  GM_SYSTEM_MESSAGE: z.object({
    sessionId: SessionId,
    text: z.string().min(1).max(4000),
    requestId: RequestIdSchema.optional(),
  }),
  GM_ADD_NOTE: z.object({
    sessionId: SessionId,
    turnId: TurnId.nullable().optional(),
    visibility: GMNoteVisibility,
    text: z.string().min(1).max(4000),
    requestId: RequestIdSchema.optional(),
  }),
  GM_KICK_PLAYER: z.object({ sessionId: SessionId, playerId: PlayerId }),
  GM_ACTIVATE_EVENT: z.object({ eventId: z.string().uuid(), turnId: TurnId, idempotencyKey: IdempotencyKey }),
  GM_SET_FLAG: z.object({
    sessionId: SessionId,
    key: z.string().max(80),
    value: z.union([z.boolean(), z.number(), z.string().max(500)]),
    idempotencyKey: IdempotencyKey,
  }),
  GM_SET_NAME_REMEMBERED: z.object({
    sessionId: SessionId,
    playerId: PlayerId,
    remembered: z.boolean(),
    idempotencyKey: IdempotencyKey,
  }),
  GM_REQUEST_SCENE: z.object({
    sessionId: SessionId,
    turnId: TurnId.nullable(),
    sceneHint: z.string().min(1).max(500),
    idempotencyKey: IdempotencyKey,
  }),
  GM_CANCEL_MEDIA_JOB: z.object({ mediaJobId: MediaJobId }),
  PING: z.object({}),
};

export const WSClientPayloadSchemas = c;
export type WSClientType = keyof typeof c;
export const WS_CLIENT_TYPES: readonly WSClientType[] = Object.freeze(Object.keys(c) as WSClientType[]);

const envelopeExtra = {
  requestId: RequestIdSchema.optional(),
  sessionId: SessionId.optional(),
  ts: IsoDateTime,
};

export const WSClientMessageSchema = buildEnvelopeUnion(c, envelopeExtra);
export type WSClientMessage = z.infer<typeof WSClientMessageSchema>;

/** Команды, для которых idempotencyKey обязателен (B-08: сервер ключ не додумывает). */
export const WS_REQUIRES_IDEMPOTENCY_KEY: readonly WSClientType[] = Object.freeze([
  'ACTION_SUBMIT',
  'GM_OPEN_TURN',
  'GM_LOCK_TURN',
  'GM_UNLOCK_TURN',
  'GM_COMMIT_TURN',
  'GM_EDIT_APPROVE',
  'GM_REJECT_TURN',
  'GM_RETRY_AI',
  'GM_MOVE_GROUP',
  'GM_PAUSE',
  'GM_RESUME',
  'GM_END_SESSION',
  'GM_ACTIVATE_EVENT',
  'GM_SET_FLAG',
  'GM_SET_NAME_REMEMBERED',
  'GM_REQUEST_SCENE',
]);

/** Сообщения, доступные только GM (проверяется до вызова команды). */
export const WS_GM_ONLY: readonly WSClientType[] = Object.freeze(
  (Object.keys(c) as WSClientType[]).filter((t) => t.startsWith('GM_')),
);

// ------------------------------------------------------------ server → client

const sv = {
  HELLO: z.object({
    serverVersion: z.string().max(40),
    contractsVersion: z.string().max(40),
    capabilities: z.array(CapabilityAvailabilitySchema),
  }),
  AUTH_OK: z.object({ playerId: PlayerId, sessionId: SessionId, isGM: z.boolean() }),
  SUBSCRIBED: z.object({ sessionId: SessionId }),
  SESSION_STATUS: z.object({ sessionId: SessionId, from: z.string(), to: z.string() }),
  PLAYER_PRESENCE: z.object({
    sessionId: SessionId,
    playerId: PlayerId,
    status: z.enum(['ACTIVE', 'DISCONNECTED', 'LEFT', 'SPECTATOR']),
    connections: z.number().int().nonnegative(),
  }),
  STATE_PROJECTION: PublicGameStateViewSchema,
  STATE_PROJECTION_PRIVATE: PlayerGameStateViewSchema,
  TURN_UPDATE: TurnViewSchema,
  TURN_DRAFT_READY: z.object({ turnId: TurnId, summary: ResolutionSummaryViewSchema }),
  TURN_RESOLUTION_GM: TurnResolutionSchema,
  TURN_COMMITTED: z.object({
    turnId: TurnId,
    version: z.number().int().nonnegative(),
    publicSegments: z.array(z.object({ segmentId: z.string().uuid(), text: z.string().max(2000) })),
  }),
  TURN_PRIVATE_RESOLUTION: z.object({ turnId: TurnId, text: z.string().max(1500) }),
  TURN_FAILED: z.object({ turnId: TurnId, errorCode: ErrorCode, message: z.string().max(500) }),
  CHAT_PUBLIC: ChatMessageViewSchema,
  CHAT_PRIVATE: ChatMessageViewSchema,
  CHAT_SYSTEM: ChatMessageViewSchema,
  CHAT_GM: ChatMessageViewSchema,
  CHAT_ACK: z.object({
    requestId: RequestIdSchema.nullable(),
    messageId: MessageId,
    sequenceHint: z.number().int().nonnegative().nullable(),
  }),
  ACTION_ACK: z.object({
    requestId: RequestIdSchema,
    actionId: z.string().uuid(),
    sequenceId: z.number().int().positive(),
    turnId: TurnId,
  }),
  HISTORY_RESULT: z.object({ sessionId: SessionId, messages: z.array(ChatMessageViewSchema), hasMore: z.boolean() }),
  GM_ACTION_ACK: z.object({ action: z.string().max(60), ok: z.boolean(), meta: z.record(z.string(), z.unknown()) }),
  GM_NOTE_ACK: z.object({ noteId: NoteId }),
  GM_STATE: GMStateViewSchema,
  GM_AI_CONTEXT: DirectorContextSchema,
  CAPABILITY_CHANGED: CapabilityAvailabilitySchema,
  BUDGET_WARNING: z.object({ spentUsd: z.number(), budgetUsd: z.number() }),
  BUDGET_EXCEEDED: z.object({ spentUsd: z.number(), budgetUsd: z.number(), disabledCapability: z.string().nullable() }),
  MEDIA_STARTED: z.object({ mediaJobId: MediaJobId, providerId: z.string().max(64) }),
  MEDIA_READY: MediaJobViewSchema,
  MEDIA_FAILED: MediaJobViewSchema,
  AUDIO_STARTED: z.object({ audioJobId: z.string().uuid() }),
  AUDIO_READY: AudioJobViewSchema,
  AUDIO_FAILED: AudioJobViewSchema,
  ERROR: z.object({
    code: ErrorCode,
    message: z.string().max(500),
    meta: z.record(z.string(), z.unknown()).optional(),
    requestId: RequestIdSchema.nullable(),
  }),
  PONG: z.object({}),
};

export const WSServerPayloadSchemas = sv;
export type WSServerType = keyof typeof sv;
export const WS_SERVER_TYPES: readonly WSServerType[] = Object.freeze(Object.keys(sv) as WSServerType[]);

export const WSServerMessageSchema = buildEnvelopeUnion(sv, envelopeExtra);
export type WSServerMessage = z.infer<typeof WSServerMessageSchema>;

/**
 * Матрица приватности (патч аудита §8.4, блокер B-10).
 *
 * ЖЁСТКОЕ ПРАВИЛО: BROADCAST-payload не содержит per-player полей. Приватное
 * уходит отдельным TARGETED-сообщением; полный черновик — только GM_ONLY.
 * Реализуется исключительно в gateways/ws/src/projections.ts.
 */
export const WsPrivacyPolicy = z.enum(['BROADCAST', 'GM_ONLY', 'TARGETED', 'SENDER_ONLY']);
export type WsPrivacyPolicy = z.infer<typeof WsPrivacyPolicy>;

export const WS_PRIVACY_POLICY: Readonly<Record<WSServerType, WsPrivacyPolicy>> = Object.freeze({
  HELLO: 'SENDER_ONLY',
  AUTH_OK: 'SENDER_ONLY',
  SUBSCRIBED: 'SENDER_ONLY',
  SESSION_STATUS: 'BROADCAST',
  PLAYER_PRESENCE: 'BROADCAST',
  STATE_PROJECTION: 'BROADCAST',
  STATE_PROJECTION_PRIVATE: 'TARGETED',
  TURN_UPDATE: 'BROADCAST',
  TURN_DRAFT_READY: 'GM_ONLY',
  TURN_RESOLUTION_GM: 'GM_ONLY',
  TURN_COMMITTED: 'BROADCAST',
  TURN_PRIVATE_RESOLUTION: 'TARGETED',
  TURN_FAILED: 'BROADCAST',
  CHAT_PUBLIC: 'BROADCAST',
  CHAT_PRIVATE: 'TARGETED',
  CHAT_SYSTEM: 'BROADCAST',
  CHAT_GM: 'GM_ONLY',
  CHAT_ACK: 'SENDER_ONLY',
  ACTION_ACK: 'SENDER_ONLY',
  HISTORY_RESULT: 'SENDER_ONLY',
  GM_ACTION_ACK: 'GM_ONLY',
  GM_NOTE_ACK: 'SENDER_ONLY',
  GM_STATE: 'GM_ONLY',
  GM_AI_CONTEXT: 'GM_ONLY',
  CAPABILITY_CHANGED: 'BROADCAST',
  BUDGET_WARNING: 'GM_ONLY',
  BUDGET_EXCEEDED: 'GM_ONLY',
  MEDIA_STARTED: 'BROADCAST',
  MEDIA_READY: 'BROADCAST',
  MEDIA_FAILED: 'BROADCAST',
  AUDIO_STARTED: 'BROADCAST',
  AUDIO_READY: 'BROADCAST',
  AUDIO_FAILED: 'BROADCAST',
  ERROR: 'SENDER_ONLY',
  PONG: 'SENDER_ONLY',
});

/**
 * Поля, которых не должно быть в BROADCAST-payload (property-based тест A1.7
 * проверяет их отсутствие в перехваченных envelope'ах).
 */
export const FORBIDDEN_IN_BROADCAST: readonly string[] = Object.freeze([
  'privateMessages',
  'gmSecret',
  'knowledge',
  'knowledgeByPlayer',
  'notes',
  'gmNotesForAI',
  'secretRestrictions',
  'diagnostics',
  'proposedEvents',
  'proposedObjectChanges',
]);

/** Коды закрытия WS-соединения (docs/SPEC_STAGE1.md §6.1). */
export const WS_CLOSE_CODE = {
  AUTH_INVALID: 4401,
  AUTH_FORBIDDEN: 4403,
  IDLE_TIMEOUT: 4408,
  RATE_LIMIT: 4429,
  BACKPRESSURE: 4429,
  INTERNAL: 4500,
} as const;
export type WsCloseCode = (typeof WS_CLOSE_CODE)[keyof typeof WS_CLOSE_CODE];
