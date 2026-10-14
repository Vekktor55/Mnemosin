import { z } from 'zod';
import { IsoDateTime } from '../time.js';
import { EventId, LocationId, ObjectId, Scalar, SessionId, Slug } from '../ids.js';
import { LocationAiGuidanceSchema, LocationGmSecretSchema } from './guidance.js';

/**
 * Location (v3 §II.8) с поправками по реальным данным мира:
 *  K6  — ExitSchema v2: kind/label/description/oneWay/hidden/via/lock{}
 *  K7  — gmSecret: GM-only блок, никогда не уходит модели
 *  K8  — atmosphereParts (структура) + atmosphere (склейка, max 1000 по D179)
 *  K9  — hazards: структурированный discriminated union вместо string[]
 *  K10 — aiGuidance + narrativeNotes до 6000
 *  K12 — actors/items как непрозрачные данные
 *  K16 — takeable/itemMeta у объектов (предмет = интерактивный объект, D182)
 */

export const HazardSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('GAS'), level: z.enum(['none', 'low', 'medium', 'high', 'lethal']) }),
  z.object({ kind: z.literal('ACID'), active: z.boolean() }),
  z.object({ kind: z.literal('ELECTRICITY'), active: z.boolean() }),
  z.object({ kind: z.literal('DARKNESS'), requiresLight: z.boolean() }),
  z.object({ kind: z.literal('TURRET'), active: z.boolean() }),
  z.object({ kind: z.literal('TRAP'), trigger: z.string().max(120).nullable() }),
  z.object({ kind: z.literal('OTHER'), label: z.string().max(200) }),
]);
export type Hazard = z.infer<typeof HazardSchema>;

export const ExitVia = z.enum(['door', 'stairs', 'elevator', 'shaft', 'hatch', 'vent']);
export type ExitVia = z.infer<typeof ExitVia>;

export const ExitLockSchema = z.object({
  type: z.enum(['keycard', 'code', 'key', 'power', 'puzzle', 'condition']).nullable(),
  keyRequired: z.string().max(80).nullable(),
  requiresFlag: z.string().max(80).nullable(),
  /** Человекочитаемая причина для UI (v3 lockReason). */
  reason: z.string().max(200).nullable(),
});
export type ExitLock = z.infer<typeof ExitLockSchema>;

/**
 * K6: `kind='DESCRIPTIVE'` — выход, не ведущий в игровую локацию
 * (реальный случай: `surface_cemetery` в Шлюзе, ребро e00).
 * Инвариант проверяется `.superRefine`: LOCATION ⇒ toLocationId ≠ null.
 */
export const ExitSchema = z
  .object({
    kind: z.enum(['LOCATION', 'DESCRIPTIVE']).default('LOCATION'),
    toLocationId: LocationId.nullable(),
    /** Короткая подпись для UI, ≤60 (D177/D183: «Дверь в Регистратуру»). */
    label: z.string().min(1).max(60),
    /** Полный авторский текст (v1 `direction`), ≤200. */
    description: z.string().max(200).nullable().default(null),
    oneWay: z.boolean().default(false),
    hidden: z.boolean().default(false),
    via: ExitVia.nullable().default(null),
    locked: z.boolean().default(false),
    lock: ExitLockSchema.default({ type: null, keyRequired: null, requiresFlag: null, reason: null }),
  })
  .superRefine((exit, ctx) => {
    if (exit.kind === 'LOCATION' && exit.toLocationId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toLocationId'],
        message: "kind='LOCATION' требует toLocationId",
      });
    }
    if (exit.kind === 'DESCRIPTIVE' && exit.toLocationId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toLocationId'],
        message: "kind='DESCRIPTIVE' не имеет toLocationId",
      });
    }
  });
export type Exit = z.infer<typeof ExitSchema>;

/** K16/D182: предмет моделируется как интерактивный объект с `takeable`. */
export const ItemMetaSchema = z.object({
  unique: z.boolean().default(true),
  storyRelevance: z.string().max(60).nullable(),
  /** Поле для модели, не для игрока (K11): v1 `items[].hidden_role`. */
  hiddenRole: z.string().max(1000).nullable(),
});
export type ItemMeta = z.infer<typeof ItemMetaSchema>;

export const LocationObjectSchema = z.object({
  objectId: ObjectId,
  name: z.string().min(1).max(80),
  description: z.string().max(500),
  interactive: z.boolean(),
  takeable: z.boolean().default(false),
  itemMeta: ItemMetaSchema.nullable(),
  /** Как объект получен: из данных v1, выведен конвертером (D172) или заглушка. */
  source: z.enum(['v1', 'v1-snippet', 'derived', 'todo']).default('v1'),
});
export type LocationObject = z.infer<typeof LocationObjectSchema>;

export const AtmospherePartsSchema = z.object({
  lighting: z.string().max(300).nullable(),
  sounds: z.string().max(300).nullable(),
  smell: z.string().max(300).nullable(),
  temperature: z.string().max(300).nullable(),
  tone: z.string().max(300).nullable(),
});
export type AtmosphereParts = z.infer<typeof AtmospherePartsSchema>;

export const LocationMetaSchema = z.object({
  floor: z.number().int().min(-20).max(20).nullable(),
  indexOnFloor: z.number().int().nonnegative().nullable(),
  floorName: z.string().max(120).nullable(),
  batch: z.number().int().nonnegative().nullable(),
  /** Как получена локация: из данных, stub из реестра (D175) или описательная. */
  origin: z.enum(['v1', 'stub', 'derived', 'v3-fixture']),
  atmosphereParts: AtmospherePartsSchema.nullable(),
  /** Непрозрачные блоки v1, которые Core не интерпретирует (K12). */
  actors: z.unknown().optional(),
  items: z.unknown().optional(),
});
export type LocationMeta = z.infer<typeof LocationMetaSchema>;

export const LocationDefinitionSchema = z.object({
  locationId: LocationId,
  /** null = шаблон мира; в сессии всегда заполнен (v3 §II.8). */
  sessionId: SessionId.nullable(),
  templateSlug: Slug.nullable(),
  name: z.string().min(1).max(80),
  description: z.string().max(2000),
  /** D179: 500 → 1000 (склейка атмосферы Регистратуры = 564 символа). */
  atmosphere: z.string().max(1000),
  objects: z.array(LocationObjectSchema),
  exits: z.array(ExitSchema),
  hazards: z.array(HazardSchema),
  registeredEventIds: z.array(EventId),
  /** K10: 2000 → 6000, потому что ai_guidance Шлюза не влезает в 2000. */
  narrativeNotes: z.string().max(6000),
  aiGuidance: LocationAiGuidanceSchema.nullable(),
  /** K7: GM-only. Никогда не покидает GMStateView. */
  gmSecret: LocationGmSecretSchema.nullable(),
  tags: z.array(z.string().max(40)),
  meta: LocationMetaSchema,
  updatedAt: IsoDateTime.nullable(),
});
export type LocationDefinition = z.infer<typeof LocationDefinitionSchema>;

// ---------------------------------------------------------------- world-pack

/**
 * Шаблон локации в world-pack (slug-based, до инстанцирования).
 * Все ссылки — slug'и; UUID назначает instantiateWorldPack с таблицей remap
 * (аудит §8.7, D164).
 */
export const LocationTemplateSchema = z.object({
  locationSlug: Slug,
  name: z.string().min(1).max(80),
  description: z.string().max(2000),
  atmosphere: z.string().max(1000),
  atmosphereParts: AtmospherePartsSchema.nullable(),
  objects: z.array(
    z.object({
      objectSlug: Slug,
      name: z.string().min(1).max(80),
      description: z.string().max(500),
      interactive: z.boolean(),
      takeable: z.boolean().default(false),
      itemMeta: ItemMetaSchema.nullable(),
      source: z.enum(['v1', 'v1-snippet', 'derived', 'todo']).default('v1'),
    }),
  ),
  exits: z.array(
    z.object({
      kind: z.enum(['LOCATION', 'DESCRIPTIVE']).default('LOCATION'),
      toLocationSlug: z.string().max(60).nullable(),
      label: z.string().min(1).max(60),
      description: z.string().max(200).nullable().default(null),
      oneWay: z.boolean().default(false),
      hidden: z.boolean().default(false),
      via: ExitVia.nullable().default(null),
      locked: z.boolean().default(false),
      lock: ExitLockSchema.default({ type: null, keyRequired: null, requiresFlag: null, reason: null }),
    }),
  ),
  hazards: z.array(HazardSchema),
  registeredEventSlugs: z.array(Slug),
  narrativeNotes: z.string().max(6000),
  aiGuidance: LocationAiGuidanceSchema.nullable(),
  gmSecret: LocationGmSecretSchema.nullable(),
  tags: z.array(z.string().max(40)),
  /** D176: откуда взято описание (для аудита контента). */
  initialFlags: z.record(z.string().max(80), Scalar),
  meta: LocationMetaSchema,
});
export type LocationTemplate = z.infer<typeof LocationTemplateSchema>;

export const WorldPackSchema = z.object({
  packId: z.string().regex(/^[a-z0-9-]{1,60}$/),
  version: z.string().min(1).max(20),
  title: z.string().min(1).max(120),
  language: z.enum(['ru', 'en']).default('ru'),
  startLocationSlug: Slug,
  locations: z.array(LocationTemplateSchema).min(1),
  events: z.array(z.lazy(() => z.unknown())), // заполняется WorldEventTemplateSchema в dsl/events.ts (избегаем цикла)
  rules: z.array(z.unknown()),
  unresolved: z.array(z.object({ id: z.string().max(20), topic: z.string().max(200), note: z.string().max(1000) })),
  meta: z.object({
    author: z.string().max(120).nullable(),
    source: z.string().max(200).nullable(),
    createdAt: IsoDateTime.nullable(),
  }),
});
export type WorldPack = z.infer<typeof WorldPackSchema>;
