import { z } from 'zod';
import { IsoDateTime } from '../time.js';
import {
  ConnectionId,
  EventId,
  LocationId,
  MediaJobId,
  MessageId,
  NoteId,
  PlayerId,
  SessionId,
  TurnId,
  ActionId,
  IdempotencyKey,
} from '../ids.js';
import { ErrorCode } from '../errors.js';
import { buildEnvelopeUnion } from '../envelope.js';
import { CapabilitySchema } from '../capability.js';
import { SessionStatus } from '../domain/session.js';
import { GmActionKind, GMNoteVisibility, GMReviewDecisionKind } from '../domain/gm.js';

/**
 * Каталог доменных событий как код (v3 §II.16 + F-2.1/F-2.8/F-2.9).
 *
 * Отклонения от v3:
 *  - в каждый payload добавлен `sessionId` (F-2.9: подписчику не нужен лишний запрос);
 *  - добавлены события, которые модули эмитировали, но которых не было в каталоге
 *    (CHAT_MESSAGE_*, GM_REVIEW_DECIDED — F-2.1), и недостающие
 *    (SESSION_ENDED, PLAYER_DISCONNECTED, MEDIA_JOB_QUEUED, SNAPSHOT_TAKEN,
 *    TURN_UNLOCKED по D114, EFFECT_DEFERRED, BUDGET_*, AUDIO_*);
 *  - инвариант 16 выполнен: у каждого события есть Zod-схема payload.
 */

const s = {
  SESSION_CREATED: z.object({ sessionId: SessionId, gmPlayerId: PlayerId, title: z.string().max(120) }),
  SESSION_STATUS_CHANGED: z.object({ sessionId: SessionId, from: SessionStatus, to: SessionStatus }),
  SESSION_ENDED: z.object({ sessionId: SessionId, reason: z.string().max(200) }),
  PLAYER_JOINED: z.object({
    sessionId: SessionId,
    playerId: PlayerId,
    displayName: z.string().max(60),
    characterName: z.string().max(60),
  }),
  PLAYER_LEFT: z.object({ sessionId: SessionId, playerId: PlayerId, reason: z.enum(['LEFT', 'KICKED', 'TIMEOUT']) }),
  PLAYER_DISCONNECTED: z.object({ sessionId: SessionId, playerId: PlayerId, connectionId: ConnectionId }),
  TURN_OPENED: z.object({ sessionId: SessionId, turnId: TurnId, number: z.number().int().nonnegative() }),
  TURN_LOCKED: z.object({ sessionId: SessionId, turnId: TurnId, actionIds: z.array(ActionId) }),
  TURN_UNLOCKED: z.object({ sessionId: SessionId, turnId: TurnId }),
  TURN_PROCESSING_STARTED: z.object({ sessionId: SessionId, turnId: TurnId }),
  TURN_DRAFT_READY: z.object({ sessionId: SessionId, turnId: TurnId }),
  TURN_COMMITTED: z.object({ sessionId: SessionId, turnId: TurnId, version: z.number().int().nonnegative() }),
  TURN_FAILED: z.object({ sessionId: SessionId, turnId: TurnId, errorCode: ErrorCode, message: z.string().max(500) }),
  ACTION_SUBMITTED: z.object({
    sessionId: SessionId,
    turnId: TurnId,
    actionId: ActionId,
    playerId: PlayerId,
    sequenceId: z.number().int().positive(),
  }),
  LOCATION_CHANGED: z.object({
    sessionId: SessionId,
    fromLocationId: LocationId,
    toLocationId: LocationId,
    playerIds: z.array(PlayerId),
  }),
  EVENT_REGISTERED: z.object({ sessionId: SessionId, eventId: EventId, locationId: LocationId.nullable() }),
  WORLD_EVENT_FIRED: z.object({
    sessionId: SessionId,
    eventId: EventId,
    turnId: TurnId.nullable(),
    effectsCount: z.number().int().nonnegative(),
  }),
  EFFECT_DEFERRED: z.object({
    sessionId: SessionId,
    deferredId: z.number().int(),
    reason: z.enum(['EVENT_EFFECT_CONFLICT', 'CASCADE_DEPTH', 'MODULE_UNAVAILABLE']),
    applyAtTurnNumber: z.number().int().nonnegative(),
  }),
  STATE_COMMITTED: z.object({
    sessionId: SessionId,
    version: z.number().int().nonnegative(),
    changedKeys: z.array(z.string().max(120)),
  }),
  GM_ACTION_PERFORMED: z.object({
    sessionId: SessionId,
    gmPlayerId: PlayerId,
    action: GmActionKind,
    meta: z.record(z.string(), z.unknown()),
    idempotencyKey: IdempotencyKey.nullable(),
  }),
  GM_NOTE_ADDED: z.object({ sessionId: SessionId, noteId: NoteId, visibility: GMNoteVisibility }),
  GM_REVIEW_DECIDED: z.object({
    sessionId: SessionId,
    turnId: TurnId,
    gmPlayerId: PlayerId,
    decision: GMReviewDecisionKind,
  }),
  VISUAL_SCENE_REQUESTED: z.object({
    sessionId: SessionId,
    mediaJobId: MediaJobId,
    turnId: TurnId.nullable(),
    promptHash: z.string().length(64),
  }),
  MEDIA_JOB_QUEUED: z.object({
    sessionId: SessionId,
    mediaJobId: MediaJobId,
    queueDepth: z.number().int().nonnegative(),
  }),
  MEDIA_GENERATION_STARTED: z.object({ sessionId: SessionId, mediaJobId: MediaJobId, providerId: z.string().max(64) }),
  MEDIA_READY: z.object({
    sessionId: SessionId,
    mediaJobId: MediaJobId,
    url: z.string().max(500),
    seed: z.number().int().nullable(),
    providerId: z.string().max(64),
  }),
  MEDIA_FAILED: z.object({
    sessionId: SessionId,
    mediaJobId: MediaJobId,
    errorCode: ErrorCode,
    providerId: z.string().max(64).nullable(),
  }),
  CAPABILITY_CHANGED: z.object({
    capability: CapabilitySchema,
    available: z.boolean(),
    providers: z.array(z.string().max(64)),
    reason: z.string().max(60).nullable(),
    sessionId: SessionId.nullable(),
  }),
  AI_DRAFT_PROPOSED: z.object({ sessionId: SessionId, turnId: TurnId, proposalHash: z.string().length(64) }),
  AI_GENERATION_FAILED: z.object({
    sessionId: SessionId,
    turnId: TurnId,
    errorCode: ErrorCode,
    providerId: z.string().max(64).nullable(),
  }),
  CHAT_MESSAGE_PUBLIC: z.object({
    sessionId: SessionId,
    messageId: MessageId,
    fromPlayerId: PlayerId,
    turnId: TurnId.nullable(),
  }),
  CHAT_MESSAGE_PRIVATE: z.object({
    sessionId: SessionId,
    messageId: MessageId,
    fromPlayerId: PlayerId.nullable(),
    toPlayerId: PlayerId,
    turnId: TurnId.nullable(),
  }),
  CHAT_MESSAGE_SYSTEM: z.object({ sessionId: SessionId, messageId: MessageId, turnId: TurnId.nullable() }),
  CHAT_MESSAGE_GM: z.object({ sessionId: SessionId, messageId: MessageId, turnId: TurnId.nullable() }),
  AUDIO_REQUESTED: z.object({
    sessionId: SessionId,
    audioJobId: z.string().uuid(),
    turnId: TurnId.nullable(),
    textHash: z.string().length(64),
  }),
  AUDIO_READY: z.object({
    sessionId: SessionId,
    audioJobId: z.string().uuid(),
    url: z.string().max(500),
    providerId: z.string().max(64),
  }),
  AUDIO_FAILED: z.object({ sessionId: SessionId, audioJobId: z.string().uuid(), errorCode: ErrorCode }),
  BUDGET_WARNING: z.object({ sessionId: SessionId, spentUsd: z.number(), budgetUsd: z.number() }),
  BUDGET_EXCEEDED: z.object({
    sessionId: SessionId,
    spentUsd: z.number(),
    budgetUsd: z.number(),
    disabledCapability: CapabilitySchema.nullable(),
  }),
  SNAPSHOT_TAKEN: z.object({ sessionId: SessionId, turnId: TurnId, version: z.number().int().nonnegative() }),
};

export const EventPayloadSchemas = s;

export type EventName = keyof typeof s;

export const EventNameSchema = z.enum(Object.keys(s) as [EventName, ...EventName[]]);

export type EventPayload<T extends EventName> = z.infer<(typeof s)[T]>;

/** Конверт доменного события: payload проходит Zod при публикации (инвариант 16). */
export const DomainEventSchema = buildEnvelopeUnion(s, {
  emittedAt: IsoDateTime,
  traceId: z.string().max(64),
});
export type DomainEvent = z.infer<typeof DomainEventSchema>;

/** Все имена событий — для проверки `emits`/`subscribes` в контрактах модулей. */
export const EVENT_NAMES: readonly EventName[] = Object.freeze(Object.keys(s) as EventName[]);
