import { z } from 'zod';
import { LocationId, PlayerId, Scalar, Slug } from '../ids.js';
import { SceneHintSchema } from '../domain/visual.js';
import { KnowledgeSource } from '../domain/state.js';

/**
 * Эффекты DSL (v3 §III.4 + K4, K15, и USE_OBJECT из патча аудита §8.8).
 *
 * K4:  `TELEPORT.playerIds` опционален — в v1 `move_group` перемещает всю
 *      группу, и списка игроков в данных нет. Отсутствие playerIds = все
 *      игроки текущей локации.
 * K15: `REVEAL_OBJECT` — без него событие HIDDEN_DOOR_OPENED не откроет
 *      Скрытый тамбур (поле `visible` в ObjectState есть, способа менять не было).
 *      `GIVE_ITEM` — адресная выдача, требует модуль inventory (D180).
 *
 * AI может предлагать только эффекты из allowlist'а `limits.aiMutable`
 * (промпт 2.14, F-9.4/F-4.8).
 */

export const NarrativeVisibility = z.enum(['PUBLIC', 'GM_ONLY']);
export type NarrativeVisibility = z.infer<typeof NarrativeVisibility>;

export const EffectSchema = z.discriminatedUnion('kind', [
  // v1 допускает set_flag без value (реальный случай: reception_entered) → default true
  z.object({
    kind: z.literal('SET_FLAG'),
    key: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,79}$/),
    value: Scalar.default(true),
  }),
  z.object({
    kind: z.literal('CHANGE_OBJECT_STATE'),
    objectId: z.string().min(1).max(64),
    patch: z.record(z.string().max(60), Scalar),
  }),
  z.object({ kind: z.literal('REVEAL_OBJECT'), objectId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal('USE_OBJECT'), objectId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal('TELEPORT'), playerIds: z.array(PlayerId).optional(), toLocationId: LocationId }),
  z.object({
    kind: z.literal('GRANT_KNOWLEDGE'),
    playerId: PlayerId,
    key: z.string().max(80),
    value: Scalar,
    source: KnowledgeSource,
  }),
  z.object({ kind: z.literal('EMIT_NARRATIVE'), text: z.string().min(1).max(2000), visibility: NarrativeVisibility }),
  z.object({ kind: z.literal('REQUEST_MEDIA'), sceneHint: SceneHintSchema }),
  z.object({ kind: z.literal('REQUEST_AUDIO'), text: z.string().min(1).max(1200) }),
  z.object({
    kind: z.literal('REACH_ENDING'),
    endingId: z.string().min(1).max(80),
    /** Заполняются движком при применении, если AI/GM их не задал (F-4.9). */
    summary: z.string().max(2000).optional(),
    survivors: z.array(PlayerId).optional(),
  }),
  z.object({ kind: z.literal('GIVE_ITEM'), itemSlug: z.string().min(1).max(80), playerId: PlayerId.optional() }),
]);
export type Effect = z.infer<typeof EffectSchema>;

/** Эффекты, требующие модуль вне Core: не применяются, пока модуля нет (D180/D182). */
export const EFFECTS_REQUIRING_MODULE: Readonly<Record<string, string>> = Object.freeze({
  GIVE_ITEM: 'inventory',
  REQUEST_AUDIO: 'audio-director',
});

/** Шаблон эффекта для world-pack (slug-based). */
export const EffectTemplateSchema = z.discriminatedUnion('kind', [
  // v1 допускает set_flag без value (реальный случай: reception_entered) → default true
  z.object({
    kind: z.literal('SET_FLAG'),
    key: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,79}$/),
    value: Scalar.default(true),
  }),
  z.object({ kind: z.literal('CHANGE_OBJECT_STATE'), objectSlug: Slug, patch: z.record(z.string().max(60), Scalar) }),
  z.object({ kind: z.literal('REVEAL_OBJECT'), objectSlug: Slug }),
  z.object({ kind: z.literal('USE_OBJECT'), objectSlug: Slug }),
  z.object({ kind: z.literal('TELEPORT'), toLocationSlug: Slug, allPlayers: z.boolean().default(true) }),
  z.object({
    kind: z.literal('GRANT_KNOWLEDGE'),
    toAllPlayers: z.boolean().default(false),
    key: z.string().max(80),
    value: Scalar,
    source: KnowledgeSource,
  }),
  z.object({ kind: z.literal('EMIT_NARRATIVE'), text: z.string().min(1).max(2000), visibility: NarrativeVisibility }),
  z.object({ kind: z.literal('REQUEST_MEDIA'), sceneHint: SceneHintSchema }),
  z.object({ kind: z.literal('REQUEST_AUDIO'), text: z.string().min(1).max(1200) }),
  z.object({
    kind: z.literal('REACH_ENDING'),
    endingId: z.string().min(1).max(80),
    summary: z.string().max(2000).optional(),
  }),
  z.object({ kind: z.literal('GIVE_ITEM'), itemSlug: z.string().min(1).max(80) }),
]);
export type EffectTemplate = z.infer<typeof EffectTemplateSchema>;
