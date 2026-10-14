import { z } from 'zod';
import { IsoDateTime } from '../time.js';
import { EventId, LocationId, SessionId, Slug, TurnId } from '../ids.js';
import { ConditionSchema } from './conditions.js';
import { TriggerSchema, TriggerTemplateSchema } from './triggers.js';
import { EffectSchema, EffectTemplateSchema } from './effects.js';
import { EventAiGuidanceSchema } from '../domain/guidance.js';

/**
 * WorldEvent (v3 §II.9) с поправками:
 *  - `priority` добавлен (F-4.2/B-06: сортировка по нему требовалась в §III.5,
 *    но поля в схеме не было);
 *  - `conditions` — массив, а не одиночное условие (F-1.6c);
 *  - `cascadeDepth` — защита от бесконечного каскада (F-2.6, лимит из limits.yaml);
 *  - `aiGuidance` — K10 (v1 `narrative_guidance`, 13 ключей);
 *  - `requiresModule` — D180: событие не регистрируется в allowedEventIds,
 *    пока модуль не подключён;
 *  - `sessionId` nullable — null означает шаблон (до инстанцирования).
 */

/**
 * Фактический словарь из данных мира (7 комнат, 67 событий):
 * discovery 35, scene 8, interaction 7, reaction 7, supernatural 6, item 3, exploration 1.
 * 'finale' и 'custom' добавлены на вырост (D186).
 */
export const WorldEventCategory = z.enum([
  'scene',
  'discovery',
  'interaction',
  'reaction',
  'item',
  'supernatural',
  'exploration',
  'finale',
  'custom',
]);
export type WorldEventCategory = z.infer<typeof WorldEventCategory>;

export const WorldEventSchema = z.object({
  eventId: EventId,
  sessionId: SessionId.nullable(),
  templateSlug: Slug.nullable(),
  locationId: LocationId.nullable(),
  name: z.string().min(1).max(120),
  category: WorldEventCategory.default('custom'),
  /** F-4.2: выше = раньше; при равенстве — eventId ASC (детерминированный порядок). */
  priority: z.number().int().default(0),
  trigger: TriggerSchema,
  conditions: z.array(ConditionSchema).default([]),
  effects: z.array(EffectSchema),
  once: z.boolean().default(true),
  fired: z.boolean().default(false),
  firedAtTurnId: TurnId.nullable().default(null),
  cascadeDepth: z.number().int().min(0).default(0),
  aiGuidance: EventAiGuidanceSchema.nullable().default(null),
  /** D180: 'inventory' | 'audio-director' | null. */
  requiresModule: z.string().max(60).nullable().default(null),
  tags: z.array(z.string().max(40)).default([]),
});
export type WorldEvent = z.infer<typeof WorldEventSchema>;

export const WorldEventTemplateSchema = z.object({
  eventSlug: Slug,
  name: z.string().min(1).max(120),
  category: WorldEventCategory.default('custom'),
  priority: z.number().int().default(0),
  locationSlug: Slug.nullable().default(null),
  trigger: TriggerTemplateSchema,
  conditions: z.array(ConditionSchema).default([]),
  effects: z.array(EffectTemplateSchema),
  once: z.boolean().default(true),
  aiGuidance: EventAiGuidanceSchema.nullable().default(null),
  requiresModule: z.string().max(60).nullable().default(null),
  tags: z.array(z.string().max(40)).default([]),
  meta: z
    .object({
      source: z.enum(['v1', 'derived', 'todo', 'v3-fixture']).default('v1'),
      notes: z.string().max(500).nullable(),
    })
    .default({
      source: 'v1',
      notes: null,
    }),
});
export type WorldEventTemplate = z.infer<typeof WorldEventTemplateSchema>;

/** Отложенный эффект (first-writer-wins, второй — на следующий ход, v3 §III.5). */
export const DeferredEffectSchema = z.object({
  id: z.number().int().positive(),
  sessionId: SessionId,
  sourceEventId: EventId.nullable(),
  effect: EffectSchema,
  reason: z.enum(['EVENT_EFFECT_CONFLICT', 'CASCADE_DEPTH', 'MODULE_UNAVAILABLE']),
  sourceTurnId: TurnId.nullable(),
  applyAtTurnNumber: z.number().int().nonnegative(),
  status: z.enum(['PENDING', 'APPLIED', 'FAILED']).default('PENDING'),
  createdAt: IsoDateTime,
});
export type DeferredEffect = z.infer<typeof DeferredEffectSchema>;

/** Запись first_seen для условия FIRST_TIME (F-4.1: нужен entityId). */
export const FirstSeenSchema = z.object({
  sessionId: SessionId,
  scope: z.enum(['LOCATION', 'OBJECT', 'EVENT']),
  entityId: z.string().min(1).max(64),
  firstTurnId: TurnId.nullable(),
});
export type FirstSeen = z.infer<typeof FirstSeenSchema>;
