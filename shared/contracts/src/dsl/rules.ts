import { z } from 'zod';
import { ObjectId, SessionId, Slug, StatePathSchema } from './index.js';
import { ConditionSchema } from './conditions.js';
import { ActionIntent } from '../domain/action.js';

/**
 * Rules Engine (v3 §III.7–III.8) с устранением неоднозначностей:
 *
 * F-4.3: `RuleSubject` определён как discriminated union (в v3 тип упоминался
 *        в сигнатуре `evaluate()`, но не был объявлен).
 * F-4.5: **`predicate` описывает условие НАРУШЕНИЯ.** Если
 *        `evaluateCondition(predicate, ctx) === true` → проверка не пройдена →
 *        `outcome = onFail`. Если false → PASS. Семантика зафиксирована (D129).
 * F-4.6: intent — enum (см. domain/action.ts), поэтому правило может опираться
 *        на `ACTION_INTENT`/`ACTION_TARGET`/`ACTION_TEXT_MATCH`.
 */

export const RuleSubjectKind = z.enum(['ACTION', 'OBJECT_CHANGE', 'EVENT_TRIGGER', 'STATE_CHANGE']);
export type RuleSubjectKind = z.infer<typeof RuleSubjectKind>;

export const RuleSubjectSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ACTION'),
    actionId: z.string().uuid().optional(),
    playerId: z.string().uuid().optional(),
    intent: ActionIntent.nullable(),
    targetObjectId: ObjectId.nullable(),
    rawText: z.string().max(4000).optional(),
  }),
  z.object({ kind: z.literal('OBJECT_CHANGE'), objectId: ObjectId, patchKeys: z.array(z.string().max(60)) }),
  z.object({ kind: z.literal('EVENT_TRIGGER'), eventId: z.string().uuid() }),
  z.object({ kind: z.literal('STATE_CHANGE'), path: StatePathSchema }),
]);
export type RuleSubject = z.infer<typeof RuleSubjectSchema>;

export const RuleOutcome = z.enum(['PASS', 'REJECT', 'SOFT_REJECT', 'WARN', 'SKIPPED']);
export type RuleOutcome = z.infer<typeof RuleOutcome>;

export const RuleCheckSchema = z.object({
  checkId: z.string().min(1).max(80),
  /** К какому виду subject'а применяется проверка. */
  subject: RuleSubjectKind,
  /** Условие НАРУШЕНИЯ (D129). */
  predicate: ConditionSchema,
  onFail: z.enum(['REJECT', 'SOFT_REJECT', 'WARN']),
  message: z.string().min(1).max(300),
  /** выше = раньше; при равенстве — checkId ASC (v3 §III.8). */
  priority: z.number().int().default(0),
  enabled: z.boolean().default(true),
  meta: z
    .object({
      source: z.enum(['v1', 'derived', 'v3-fixture', 'todo']).default('derived'),
      notes: z.string().max(300).nullable(),
    })
    .default({
      source: 'derived',
      notes: null,
    }),
});
export type RuleCheck = z.infer<typeof RuleCheckSchema>;

export const RuleResultSchema = z.object({
  checkId: z.string().max(80),
  passed: z.boolean(),
  outcome: RuleOutcome,
  message: z.string().max(300).nullable(),
  /** SOFT_REJECT поднимает ход в REVIEW с пометкой (v3 §III.8). */
  requiresGM: z.boolean().default(false),
});
export type RuleResult = z.infer<typeof RuleResultSchema>;

export const RulesEvaluationSchema = z.object({
  passed: z.boolean(),
  requiresGM: z.boolean(),
  rejects: z.array(RuleResultSchema),
  softRejects: z.array(RuleResultSchema),
  warnings: z.array(RuleResultSchema),
  skipped: z.array(RuleResultSchema),
});
export type RulesEvaluation = z.infer<typeof RulesEvaluationSchema>;

export const RulesBundleSchema = z.object({
  bundleId: z.string().min(1).max(80),
  sessionId: SessionId.nullable(),
  checks: z.array(RuleCheckSchema),
  updatedAt: z.string().datetime({ offset: false, precision: 3 }).nullable(),
});
export type RulesBundle = z.infer<typeof RulesBundleSchema>;

export const RuleCheckTemplateSchema = RuleCheckSchema.omit({ meta: true }).extend({
  meta: z
    .object({
      source: z.enum(['v1', 'derived', 'v3-fixture', 'todo']).default('derived'),
      notes: z.string().max(300).nullable(),
    })
    .default({
      source: 'derived',
      notes: null,
    }),
});
export type RuleCheckTemplate = z.infer<typeof RuleCheckTemplateSchema>;

export const RulesBundleTemplateSchema = z.object({
  bundleSlug: Slug,
  checks: z.array(RuleCheckTemplateSchema),
});
export type RulesBundleTemplate = z.infer<typeof RulesBundleTemplateSchema>;
