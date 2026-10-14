import { z } from 'zod';
import { type ObjectId, PlayerId, Slug } from '../ids.js';
import { ActionIntent } from '../domain/action.js';

/**
 * Триггеры DSL (v3 §III.4 + поправки K1–K3, K14).
 *
 * 5 видов из v3 не покрывали реальный контент: по 6 комнатам (58 событий)
 * 47 экземпляров триггеров относились к типам, которых в v3 нет
 * (docs/CONTENT_MAPPING.md §2.3). Добавлены:
 *   K1  OBJECT_INSPECTED   — v1 `inspect_object` (29 экземпляров)
 *   K2  ATTEMPT_INTERACTION— v1 `attempt_interaction` (8)
 *   K3  COMPOUND_ACTION    — v1 `compound_player_action` (5)
 *   K14 OBJECT_CHANGED / OBJECT_UNLOCKED / ITEM_TAKEN (1 / 3 / 3)
 *
 * Таблица источников триггеров (кто и когда эмитит) — docs/CONTENT_MAPPING.md
 * и патч аудита §8.8.
 */

export const TriggerSchema = z.discriminatedUnion('kind', [
  // --- v3 §III.4
  z.object({ kind: z.literal('ENTER_ROOM'), locationId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal('TURN_COMMITTED'), turnNumber: z.number().int().nonnegative().optional() }),
  z.object({ kind: z.literal('OBJECT_USED'), objectId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal('FLAG_SET'), flagKey: z.string().min(1).max(80) }),
  z.object({ kind: z.literal('MANUAL'), byGM: z.literal(true) }),
  // --- K1: осмотр объекта (v1 inspect_object)
  z.object({ kind: z.literal('OBJECT_INSPECTED'), objectId: z.string().min(1).max(64) }),
  // --- K2: неудачная попытка взаимодействия (v1 attempt_interaction).
  //     Источник: Rules Engine вернул REJECT/SOFT_REJECT для действия с одним
  //     из intents на одном из объектов (D169).
  z.object({
    kind: z.literal('ATTEMPT_INTERACTION'),
    /** Пустой массив допустим: в данных есть событие без конкретного объекта
     *  (LOBBY_ELEVATOR_DEAD — «лифт не работает»), оно реагирует на любую попытку. */
    objectIds: z.array(z.string().min(1).max(64)),
    /**
     * D184: словарь контента v1 (force, bruteforce, shout, hack, call_elevator,
     * return_to_surface) не совпадает с ActionIntent, поэтому значения
     * сохраняются как есть, а intents — опциональное сужение для Rules Engine.
     */
    interactionTypes: z.array(z.string().min(1).max(40)).min(1),
    intents: z.array(ActionIntent).optional(),
  }),
  // --- K3: составное действие (v1 compound_player_action).
  //     Источник: только предложение AI Director + проверка Rules (D168) —
  //     детерминированного распознавания составных действий нет.
  z.object({
    kind: z.literal('COMPOUND_ACTION'),
    required: z
      .array(
        z.object({
          intent: ActionIntent,
          targetKind: z.enum(['OBJECT', 'PLAYER', 'SELF', 'GROUP']).optional(),
          /** v1 форма `notice:own_belongings` — сохраняется для трассируемости. */
          sourceLabel: z.string().max(80).optional(),
        }),
      )
      .min(2),
  }),
  // --- K14
  z.object({
    kind: z.literal('OBJECT_CHANGED'),
    objectId: z.string().min(1).max(64),
    key: z.string().max(60).optional(),
  }),
  z.object({ kind: z.literal('OBJECT_UNLOCKED'), objectId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal('ITEM_TAKEN'), itemSlug: z.string().min(1).max(80), playerId: PlayerId.optional() }),
]);
export type Trigger = z.infer<typeof TriggerSchema>;

/** Триггеры, требующие модуль вне Core: событие не регистрируется, пока модуля нет (D180). */
export const TRIGGERS_REQUIRING_MODULE = {
  ITEM_TAKEN: 'inventory',
} as const;

/** Тип триггера → moduleId, который обязан его эмитировать. */
export const TRIGGER_SOURCE: Readonly<Record<Trigger['kind'], string>> = Object.freeze({
  ENTER_ROOM: 'gm (moveGroup) / effect TELEPORT',
  TURN_COMMITTED: 'turn',
  OBJECT_USED: 'turn (подтверждённое действие intent=USE)',
  OBJECT_INSPECTED: 'turn (подтверждённое действие intent=OBSERVE)',
  FLAG_SET: 'event-engine (после применения SET_FLAG)',
  MANUAL: 'gm.activateEvent',
  ATTEMPT_INTERACTION: 'rules (REJECT/SOFT_REJECT действия с одним из interactionTypes) — D169',
  COMPOUND_ACTION: 'ai-director (предложение) + rules (проверка) — D168',
  OBJECT_CHANGED: 'event-engine / state-service (после CHANGE_OBJECT_STATE)',
  OBJECT_UNLOCKED: 'rules / event-engine (после снятия locked)',
  ITEM_TAKEN: 'turn (OBJECT_USED на объекте takeable:true) — D182',
});

/** Шаблон триггера для world-pack: те же виды, но ссылки — slug'и. */
export const TriggerTemplateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ENTER_ROOM'), locationSlug: Slug }),
  z.object({ kind: z.literal('TURN_COMMITTED'), turnNumber: z.number().int().nonnegative().optional() }),
  z.object({ kind: z.literal('OBJECT_USED'), objectSlug: Slug }),
  z.object({ kind: z.literal('OBJECT_INSPECTED'), objectSlug: Slug }),
  z.object({
    kind: z.literal('ATTEMPT_INTERACTION'),
    objectSlugs: z.array(Slug),
    interactionTypes: z.array(z.string().min(1).max(40)).min(1),
    intents: z.array(ActionIntent).optional(),
  }),
  z.object({
    kind: z.literal('COMPOUND_ACTION'),
    required: z
      .array(
        z.object({
          intent: ActionIntent,
          targetKind: z.enum(['OBJECT', 'PLAYER', 'SELF', 'GROUP']).optional(),
          sourceLabel: z.string().max(80).optional(),
        }),
      )
      .min(2),
  }),
  z.object({ kind: z.literal('OBJECT_CHANGED'), objectSlug: Slug, key: z.string().max(60).optional() }),
  z.object({ kind: z.literal('OBJECT_UNLOCKED'), objectSlug: Slug }),
  z.object({ kind: z.literal('ITEM_TAKEN'), itemSlug: z.string().min(1).max(80) }),
  z.object({ kind: z.literal('FLAG_SET'), flagKey: z.string().min(1).max(80) }),
  z.object({ kind: z.literal('MANUAL'), byGM: z.literal(true) }),
]);
export type TriggerTemplate = z.infer<typeof TriggerTemplateSchema>;

/** objectId в runtime-триггере — uuid; здесь хелпер для чтения без каста. */
export function triggerObjectId(trigger: Trigger): string | null {
  if ('objectId' in trigger) return trigger.objectId;
  return null;
}

/** Для ITEM_TAKEN: slug предмета (D182 — предмет = объект с takeable:true). */
export function triggerItemSlug(trigger: Trigger): string | null {
  return trigger.kind === 'ITEM_TAKEN' ? trigger.itemSlug : null;
}

export type { ObjectId };
