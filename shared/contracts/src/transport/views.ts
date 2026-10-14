import { z } from 'zod';
import { IsoDateTime } from '../time.js';
import { LocationId, MessageId, ObjectId, PlayerId, SessionId, TurnId } from '../ids.js';
import { ExitSchema, HazardSchema } from '../domain/location.js';
import { LocationAiGuidanceSchema, LocationGmSecretSchema } from '../domain/guidance.js';
import { KnowledgeEntrySchema, TimeOfDay } from '../domain/state.js';
import { TurnStatus } from '../domain/turn.js';
import { ChatVisibility } from '../domain/chat.js';
import { MediaJobStatus, AudioJobStatus } from '../domain/jobs.js';
import { ItemStatus } from '../domain/resolution.js';
import { RuleResultSchema } from '../dsl/rules.js';

/**
 * Проекции (блокер B-02: в v3 девять view-типов использовались в HTTP/WS/сторах,
 * но не были определены; v2 §21 «Data Projections» был утерян при переносе).
 *
 * Правило (K11): три уровня видимости контента — Player / AI / GM.
 * Проекции — единственное место, где доменные данные превращаются в клиентские;
 * транспорт их только применяет (инвариант 14).
 */

// ---------------------------------------------------------------- локации

/** Объект, видимый игроку: только если visible=true (скрытые — в AI/GM видах). */
export const PublicObjectViewSchema = z.object({
  objectId: ObjectId,
  name: z.string().max(80),
  description: z.string().max(500),
  interactive: z.boolean(),
  takeable: z.boolean(),
});
export type PublicObjectView = z.infer<typeof PublicObjectViewSchema>;

/** Выход для игрока: скрытые excluded, `requiresFlag` не раскрывается (K11). */
export const PublicExitViewSchema = z.object({
  kind: z.enum(['LOCATION', 'DESCRIPTIVE']),
  toLocationId: LocationId.nullable(),
  label: z.string().max(60),
  description: z.string().max(200).nullable(),
  via: z.string().max(20).nullable(),
  locked: z.boolean(),
  lockReason: z.string().max(200).nullable(),
  oneWay: z.boolean(),
});
export type PublicExitView = z.infer<typeof PublicExitViewSchema>;

export const PublicLocationViewSchema = z.object({
  locationId: LocationId,
  name: z.string().max(80),
  description: z.string().max(2000),
  atmosphere: z.string().max(1000),
  objects: z.array(PublicObjectViewSchema),
  exits: z.array(PublicExitViewSchema),
  hazards: z.array(HazardSchema),
  tags: z.array(z.string().max(40)),
});
export type PublicLocationView = z.infer<typeof PublicLocationViewSchema>;

/** AI-вид: публичное + указания модели + скрытые выходы + narrativeNotes. */
export const AiLocationViewSchema = PublicLocationViewSchema.extend({
  hiddenExits: z.array(ExitSchema),
  narrativeNotes: z.string().max(6000),
  aiGuidance: LocationAiGuidanceSchema.nullable(),
  /** Ограничения из v1 `lore.secret_truth.restrictions` — для модели. */
  secretRestrictions: z.array(z.string().max(400)),
  floorTruth: z.string().max(1000).nullable(),
  allObjects: z.array(PublicObjectViewSchema.extend({ visible: z.boolean() })),
});
export type AiLocationView = z.infer<typeof AiLocationViewSchema>;

/** GM-вид: AI-вид + GM-only блок (K7). Никогда не уходит модели. */
export const GmLocationViewSchema = AiLocationViewSchema.extend({
  gmSecret: LocationGmSecretSchema.nullable(),
  registeredEventIds: z.array(z.string().uuid()),
  templateSlug: z.string().max(60).nullable(),
});
export type GmLocationView = z.infer<typeof GmLocationViewSchema>;

// ---------------------------------------------------------------- состояние

export const PublicPlayerViewSchema = z.object({
  playerId: PlayerId,
  displayName: z.string().max(60),
  characterName: z.string().max(60),
  isGM: z.boolean(),
  status: z.enum(['ACTIVE', 'DISCONNECTED', 'LEFT', 'SPECTATOR']),
});
export type PublicPlayerView = z.infer<typeof PublicPlayerViewSchema>;

/** Broadcast: никаких per-player полей (блокер B-10). */
export const PublicGameStateViewSchema = z.object({
  sessionId: SessionId,
  version: z.number().int().nonnegative(),
  currentLocation: PublicLocationViewSchema.nullable(),
  timeOfDay: TimeOfDay,
  weather: z.string().max(60).nullable(),
  /** D124: в этапе 1 значения флагов публичны; приватность — через knowledge. */
  storyFlags: z.record(z.string().max(80), z.union([z.boolean(), z.number(), z.string().max(500)])),
  objectStates: z.array(z.object({ objectId: ObjectId, visible: z.boolean(), taken: z.boolean() })),
  players: z.array(PublicPlayerViewSchema),
  endingId: z.string().max(80).nullable(),
  updatedAt: IsoDateTime,
});
export type PublicGameStateView = z.infer<typeof PublicGameStateViewSchema>;

/** TARGETED: знания только этого игрока. */
export const PlayerGameStateViewSchema = z.object({
  playerId: PlayerId,
  version: z.number().int().nonnegative(),
  knowledge: z.array(KnowledgeEntrySchema),
});
export type PlayerGameStateView = z.infer<typeof PlayerGameStateViewSchema>;

/** GM_ONLY: полный доступ. */
export const GMStateViewSchema = z.object({
  session: PublicGameStateViewSchema,
  locations: z.array(GmLocationViewSchema),
  knowledgeByPlayer: z.record(z.string().uuid(), z.array(KnowledgeEntrySchema)),
  flagsDetail: z.array(
    z.object({
      key: z.string().max(80),
      value: z.union([z.boolean(), z.number(), z.string().max(500)]),
      setBy: z.enum(['AI_APPROVED', 'GM', 'ENGINE']),
      setAtTurnId: TurnId.nullable(),
    }),
  ),
  notes: z.array(
    z.object({ noteId: z.string().uuid(), visibility: z.string(), text: z.string().max(4000), createdAt: IsoDateTime }),
  ),
  pendingReviews: z.array(TurnId),
  deferredEffects: z.array(z.object({ id: z.number().int(), reason: z.string(), applyAtTurnNumber: z.number().int() })),
});
export type GMStateView = z.infer<typeof GMStateViewSchema>;

// ---------------------------------------------------------------- прочее

export const SessionViewSchema = z.object({
  sessionId: SessionId,
  title: z.string().max(120),
  status: z.enum(['LOBBY', 'ACTIVE', 'PAUSED', 'ENDED']),
  players: z.array(PublicPlayerViewSchema),
  gmPlayerId: PlayerId,
  currentTurnId: TurnId.nullable(),
  currentLocationId: LocationId.nullable(),
  worldPackId: z.string().max(60).nullable(),
  worldPackVersion: z.string().max(20).nullable(),
  createdAt: IsoDateTime,
});
export type SessionView = z.infer<typeof SessionViewSchema>;

export const TurnViewSchema = z.object({
  turnId: TurnId,
  number: z.number().int().nonnegative(),
  status: TurnStatus,
  actionCount: z.number().int().nonnegative(),
  myActions: z.array(
    z.object({
      actionId: z.string().uuid(),
      sequenceId: z.number().int(),
      rawText: z.string().max(4000),
      createdAt: IsoDateTime,
    }),
  ),
  lockedAt: IsoDateTime.nullable(),
  committedAt: IsoDateTime.nullable(),
  failed: z.object({ code: z.string(), message: z.string().max(500) }).nullable(),
});
export type TurnView = z.infer<typeof TurnViewSchema>;

export const ChatMessageViewSchema = z.object({
  messageId: MessageId,
  visibility: ChatVisibility,
  fromPlayerId: PlayerId.nullable(),
  fromDisplayName: z.string().max(60).nullable(),
  toPlayerId: PlayerId.nullable(),
  text: z.string().max(4000),
  turnId: TurnId.nullable(),
  createdAt: IsoDateTime,
});
export type ChatMessageView = z.infer<typeof ChatMessageViewSchema>;

export const MediaJobViewSchema = z.object({
  mediaJobId: z.string().uuid(),
  status: MediaJobStatus,
  providerId: z.string().max(64).nullable(),
  url: z.string().max(500).nullable(),
  seed: z.number().int().nullable(),
  fromCache: z.boolean(),
  errorCode: z.string().nullable(),
  queuedAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
});
export type MediaJobView = z.infer<typeof MediaJobViewSchema>;

export const AudioJobViewSchema = z.object({
  audioJobId: z.string().uuid(),
  status: AudioJobStatus,
  url: z.string().max(500).nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  errorCode: z.string().nullable(),
});
export type AudioJobView = z.infer<typeof AudioJobViewSchema>;

export const GmAuditEntryViewSchema = z.object({
  auditId: z.number().int(),
  gmPlayerId: PlayerId,
  action: z.string().max(60),
  meta: z.record(z.string(), z.unknown()),
  at: IsoDateTime,
});
export type GmAuditEntryView = z.infer<typeof GmAuditEntryViewSchema>;

export const JournalEntryViewSchema = z.object({
  id: z.number().int(),
  kind: z.string(),
  traceId: z.string().max(64),
  payload: z.record(z.string(), z.unknown()),
  createdAt: IsoDateTime,
});
export type JournalEntryView = z.infer<typeof JournalEntryViewSchema>;

/** Сводка item'ов черновика для списка в GM-панели (без полного resolution). */
export const ResolutionSummaryViewSchema = z.object({
  turnId: TurnId,
  source: z.enum(['AI', 'GM_MANUAL', 'AI_THEN_GM_EDIT']),
  resolutionHash: z.string().length(64).nullable(),
  counts: z.record(ItemStatus, z.number().int().nonnegative()),
  requiresGM: z.boolean(),
  violations: z.number().int().nonnegative(),
  ruleResults: z.array(RuleResultSchema),
  providerId: z.string().max(64),
  durationMs: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
});
export type ResolutionSummaryView = z.infer<typeof ResolutionSummaryViewSchema>;
