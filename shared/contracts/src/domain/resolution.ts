import { z } from 'zod';
import { IsoDateTime } from '../time.js';
import { EventId, ObjectId, PlayerId, SessionId, TurnId } from '../ids.js';
import { EffectSchema } from '../dsl/effects.js';
import { RuleResultSchema } from '../dsl/rules.js';
import { VisualSceneDescriptionSchema } from './visual.js';
import { TimeOfDay } from './state.js';
import { Scalar } from '../ids.js';

/**
 * TurnResolution — патч аудита §8.1 (блокер B-01).
 *
 * В v3 тип упоминался 4 раза (§II.4, §II.15, §IV.9), но определён не был,
 * из-за чего `draftReady`, `editAndApprove` и commit-пайплайн были нереализуемы.
 *
 * Разделение ответственности:
 *   AIResponse      — то, что вернул провайдер (вход);
 *   TurnResolution  — то, что лежит в turns.resolution_json, правит GM и
 *                     применяет commitTurn (каждый item имеет статус).
 */

export const ItemStatus = z.enum(['PROPOSED', 'APPROVED', 'REJECTED', 'EDITED', 'APPLIED', 'SKIPPED']);
export type ItemStatus = z.infer<typeof ItemStatus>;

/** Кому виден сегмент/сообщение — основа матрицы приватности (патч §8.4). */
export const AudienceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ALL') }),
  z.object({ kind: z.literal('GM') }),
  z.object({ kind: z.literal('PLAYER'), playerId: PlayerId }),
  z.object({ kind: z.literal('PLAYERS'), playerIds: z.array(PlayerId).min(1) }),
]);
export type Audience = z.infer<typeof AudienceSchema>;

export const NarrativeSegmentSchema = z.object({
  segmentId: z.string().uuid(),
  text: z.string().min(1).max(2000),
  audience: AudienceSchema,
  editedByGM: z.boolean().default(false),
  status: ItemStatus.default('PROPOSED'),
});
export type NarrativeSegment = z.infer<typeof NarrativeSegmentSchema>;

export const PrivateMessageResolutionSchema = z.object({
  playerId: PlayerId,
  text: z.string().min(1).max(1500),
  status: ItemStatus.default('PROPOSED'),
  editedByGM: z.boolean().default(false),
});
export type PrivateMessageResolution = z.infer<typeof PrivateMessageResolutionSchema>;

export const ProposedEventResolutionSchema = z.object({
  eventId: EventId,
  rationale: z.string().max(400),
  effects: z.array(EffectSchema),
  status: ItemStatus.default('PROPOSED'),
  ruleResults: z.array(RuleResultSchema).default([]),
  gmComment: z.string().max(500).nullable().default(null),
});
export type ProposedEventResolution = z.infer<typeof ProposedEventResolutionSchema>;

export const ProposedObjectChangeResolutionSchema = z.object({
  objectId: ObjectId,
  patch: z.record(z.string().max(60), Scalar),
  rationale: z.string().max(300),
  status: ItemStatus.default('PROPOSED'),
  ruleResults: z.array(RuleResultSchema).default([]),
  gmComment: z.string().max(500).nullable().default(null),
});
export type ProposedObjectChangeResolution = z.infer<typeof ProposedObjectChangeResolutionSchema>;

export const AiUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  model: z.string().max(120),
});
export type AiUsage = z.infer<typeof AiUsageSchema>;

/** Нарушения, найденные guard'ом (промпт 2.14) — видны GM в Review-панели. */
export const AiViolationSchema = z.object({
  kind: z.enum([
    'EVENT_NOT_REGISTERED',
    'EFFECT_NOT_ALLOWED',
    'OBJECT_KEY_NOT_ALLOWED',
    'FLAG_KEY_FORBIDDEN',
    'OBJECT_NOT_IN_LOCATION',
    'PLAYER_NOT_IN_SESSION',
    'LIMIT_EXCEEDED',
  ]),
  message: z.string().max(300),
  path: z.string().max(120).nullable(),
});
export type AiViolation = z.infer<typeof AiViolationSchema>;

export const DiagnosticsSchema = z.object({
  providerId: z.string().max(64),
  model: z.string().max(120).nullable(),
  attempts: z.number().int().nonnegative().default(0),
  schemaRepairAttempts: z.number().int().nonnegative().default(0),
  usage: AiUsageSchema.nullable(),
  /** null, пока цена неизвестна (UNKNOWN#5; появляется в промпте 2.8). */
  costUsd: z.number().nonnegative().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  softRejects: z.array(RuleResultSchema).default([]),
  warnings: z.array(RuleResultSchema).default([]),
  violations: z.array(AiViolationSchema).default([]),
  requiresGM: z.boolean().default(false),
});
export type Diagnostics = z.infer<typeof DiagnosticsSchema>;

export const TurnResolutionSchema = z.object({
  turnId: TurnId,
  sessionId: SessionId,
  source: z.enum(['AI', 'GM_MANUAL', 'AI_THEN_GM_EDIT']),
  /** sha256 от канонического JSON сырого AIResponse (связка с journal и A2.8). */
  aiResponseHash: z.string().length(64).nullable(),
  /** Версия GameState на момент сборки черновика — optimistic lock при commit. */
  baseVersion: z.number().int().nonnegative(),
  /** Хэш самого resolution для editAndApprove (F-3.2: защита от lost update). */
  resolutionHash: z.string().length(64).nullable(),
  segments: z.array(NarrativeSegmentSchema).default([]),
  privateMessages: z.array(PrivateMessageResolutionSchema).default([]),
  proposedEvents: z.array(ProposedEventResolutionSchema).default([]),
  proposedObjectChanges: z.array(ProposedObjectChangeResolutionSchema).default([]),
  proposedWorldStatePatch: z
    .object({
      timeOfDay: TimeOfDay.optional(),
      weather: z.string().max(60).nullable().optional(),
      ambientFlags: z.record(z.string().max(60), Scalar).optional(),
    })
    .default({}),
  visualScene: VisualSceneDescriptionSchema.nullable(),
  diagnostics: DiagnosticsSchema,
  createdAt: IsoDateTime,
  editedAt: IsoDateTime.nullable(),
});
export type TurnResolution = z.infer<typeof TurnResolutionSchema>;

/** Хэш-функция не живёт в контрактах (нужен node:crypto) — объявляем контракт формата. */
export const RESOLUTION_HASH_LENGTH = 64;
