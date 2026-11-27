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
 * Проекции (P02: NETWORK_PROTOCOL.md §10).
 *
 * LEGACY (Stage 1): Player / AI / GM — сохранены для совместимости, будут удалены/мигрированы в P02/P05.
 * v4: Player / Observer / Developer — новые проекции для v4 архитектуры.
 * Проекции — единственное место, где доменные данные превращаются в клиентские;
 * транспорт их только применяет (инвариант 14).
 */

// ============================================================================
// LEGACY PROJECTIONS (Stage 1: Player / AI / GM) — для обратной совместимости
// Будет удалено/мигрировано в P02/P05
// ============================================================================

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

// ============================================================================
// v4 PROJECTIONS (Player / Observer / Developer) — NETWORK_PROTOCOL.md §10
// ============================================================================

/** Player projection: только данные, доступные конкретному игроку. */
export const LegacyPlayerProjectionSchema = z.object({
  sessionId: SessionId,
  version: z.number().int().nonnegative(),
  playerId: PlayerId,
  // Публичное состояние локации (без скрытых выходов/объектов)
  currentLocation: PublicLocationViewSchema.nullable(),
  timeOfDay: TimeOfDay,
  weather: z.string().max(60).nullable(),
  storyFlags: z.record(z.string().max(80), z.union([z.boolean(), z.number(), z.string().max(500)])),
  // Только видимые объекты
  objectStates: z.array(z.object({ objectId: ObjectId, visible: z.boolean(), taken: z.boolean() })),
  players: z.array(PublicPlayerViewSchema),
  // Знания ТОЛЬКО этого игрока
  knowledge: z.array(KnowledgeEntrySchema),
  endingId: z.string().max(80).nullable(),
  updatedAt: IsoDateTime,
});
export type LegacyPlayerProjection = z.infer<typeof LegacyPlayerProjectionSchema>;

/** Observer projection: полная видимость скрытого игрового состояния (NETWORK_PROTOCOL.md §10.3). */
export const LegacyObserverProjectionSchema = z.object({
  sessionId: SessionId,
  version: z.number().int().nonnegative(),
  // Полное состояние включая скрытые поля
  currentLocation: GmLocationViewSchema.nullable(), // GM view = полная видимость локации
  timeOfDay: TimeOfDay,
  weather: z.string().max(60).nullable(),
  storyFlags: z.record(z.string().max(80), z.union([z.boolean(), z.number(), z.string().max(500)])),
  // Все объекты с видимостью
  objectStates: z.array(
    z.object({
      objectId: ObjectId,
      visible: z.boolean(),
      taken: z.boolean(),
      state: z.record(z.string().max(60), z.unknown()).optional(),
    }),
  ),
  players: z.array(
    PublicPlayerViewSchema.extend({
      // Observer видит скрытые роли/статусы
      trueRole: z.string().max(40).optional(),
      infectionStatus: z.enum(['CLEAN', 'INFECTED', 'UNKNOWN']).optional(),
    }),
  ),
  // Знания всех игроков
  knowledgeByPlayer: z.record(z.string().uuid(), z.array(KnowledgeEntrySchema)),
  // Детали флагов
  flagsDetail: z.array(
    z.object({
      key: z.string().max(80),
      value: z.union([z.boolean(), z.number(), z.string().max(500)]),
      setBy: z.enum(['AI_APPROVED', 'GM', 'ENGINE']),
      setAtTurnId: TurnId.nullable(),
    }),
  ),
  // Все заметки
  notes: z.array(
    z.object({ noteId: z.string().uuid(), visibility: z.string(), text: z.string().max(4000), createdAt: IsoDateTime }),
  ),
  // Состояние кукол (hidden internal state)
  dollStates: z.array(z.unknown()).optional(),
  // Андрей: фактические beliefs/trust
  andreyBeliefs: z.unknown().optional(),
  // Состояние дверей/света/газа/укрытий
  environmentState: z.unknown().optional(),
  updatedAt: IsoDateTime,
});
export type LegacyObserverProjection = z.infer<typeof LegacyObserverProjectionSchema>;

/** Developer projection: диагностическая информация (NETWORK_PROTOCOL.md §10.4). */
export const DeveloperProjectionSchema = z.object({
  sessionId: SessionId,
  // Техническая диагностика
  tickMetrics: z
    .object({
      tickDurationMs: z.number(),
      tickOverrun: z.boolean(),
      activeEntities: z.number().int(),
      queueDepth: z.number().int(),
    })
    .optional(),
  // Doll AI decisions trace
  dollAiTrace: z.array(z.unknown()).optional(),
  // Andrew request traces
  andrewTraces: z.array(z.unknown()).optional(),
  // Replay fixtures
  replayFixtures: z.unknown().optional(),
  // Schema validation failures
  validationFailures: z.array(z.unknown()).optional(),
  // GM Review test artifacts
  gmReviewArtifacts: z.unknown().optional(),
  // Raw provider output (redacted)
  rawProviderOutput: z.unknown().optional(),
});
export type DeveloperProjection = z.infer<typeof DeveloperProjectionSchema>;
