import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { type z } from 'zod';
import {
  AiLocationViewSchema,
  ConditionSchema,
  EffectSchema,
  EventAiGuidanceSchema,
  GmLocationViewSchema,
  LocationDefinitionSchema,
  PublicGameStateViewSchema,
  PublicLocationViewSchema,
  TriggerSchema,
  WorldEventSchema,
} from '@mnemosin/contracts';
// @ts-expect-error — JS-модуль без типов (общая библиотека анализатора и теста)
import { deriveExitLabel, toAccusative } from '../../tools/lib/exit-label.mjs';

/**
 * Тест на РЕАЛЬНЫХ данных мира (content/source-v1): доказывает, что контракты
 * выражают фактический контент, а не абстрактную модель.
 *
 * Это главный смысл промпта 1.2: 47 экземпляров триггеров из данных не
 * покрывались DSL v3 (docs/CONTENT_MAPPING.md §2.3), поэтому схемы расширены
 * поправками K1–K16. Тест фиксирует результат и ловит регрессию.
 */

const ROOT = process.cwd();
const SRC = resolve(ROOT, 'content/source-v1');
const ROOMS = resolve(SRC, 'rooms');

interface V1Room {
  room_id: string;
  title: string;
  floor: number;
  base_description?: string;
  atmosphere?: Record<string, string>;
  lore?: { public_revelation?: { text_snippet?: string; summary?: string }; secret_truth?: Record<string, unknown> };
  exits?: Array<{
    target_room_id: string;
    direction?: string;
    via?: string;
    one_way?: boolean;
    hidden?: boolean;
    is_locked?: boolean;
    lock_type?: string | null;
    key_required?: string | null;
    requires_flag?: string | null;
  }>;
  objects?: unknown[];
  events?: Array<{
    id: string;
    category?: string;
    once?: boolean;
    trigger: Record<string, unknown> & { type: string };
    conditions?: Array<Record<string, unknown> & { type: string }>;
    effects?: Array<Record<string, unknown> & { type: string }>;
    narrative_guidance?: Record<string, unknown>;
  }>;
  ai_guidance?: Record<string, unknown>;
}

const roomFiles = readdirSync(ROOMS)
  .filter((f) => f.endsWith('.json') && !f.endsWith('.gm.json'))
  .sort();
const rooms = roomFiles.map((f) => JSON.parse(readFileSync(resolve(ROOMS, f), 'utf8')) as V1Room);
const registry = JSON.parse(readFileSync(resolve(SRC, '_registry.json'), 'utf8')) as Array<{
  room_id: string;
  title: string;
}>;
const titleOf = new Map(registry.map((r) => [r.room_id, r.title]));

/** Детерминированный uuid из slug — так же сделает конвертер (remap). */
function uuidFromSlug(slug: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const ch of slug) {
    h1 = (h1 ^ ch.charCodeAt(0)) >>> 0;
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 = (h2 + ch.charCodeAt(0) * 31) >>> 0;
  }
  const hex = (n: number, len: number) => n.toString(16).padStart(len, '0').slice(-len);
  return `${hex(h1, 8)}-${hex(h2, 4)}-4${hex(h1 >> 3, 3)}-8${hex(h2 >> 3, 3)}-${hex(h1, 8)}${hex(h2, 4)}`;
}

/**
 * Соответствие типов v1 → v3 (docs/CONTENT_MAPPING.md §2.3).
 * Если появится новый тип v1, тест упадёт — это сигнал добавить поправку K*.
 */
function toV3Trigger(trigger: Record<string, unknown>, roomId: string, objectSlug?: string): unknown {
  const t = trigger as Record<string, unknown> & { type: string };
  const loc = uuidFromSlug(roomId);
  switch (t.type) {
    case 'enter_room':
      return { kind: 'ENTER_ROOM', locationId: loc };
    case 'inspect_object':
      return { kind: 'OBJECT_INSPECTED', objectId: uuidFromSlug(String(t.target ?? objectSlug ?? 'unknown')) };
    case 'interact':
      return { kind: 'OBJECT_USED', objectId: uuidFromSlug(String(t.target ?? 'unknown')) };
    case 'attempt_interaction': {
      // В данных встречаются оба имени поля: targets (8 случаев) и object_ids (1),
      // а у LOBBY_ELEVATOR_DEAD список пуст — контракт это допускает (D184).
      const rawTargets = (t.targets as string[] | undefined) ?? (t.object_ids as string[] | undefined) ?? [];
      return {
        kind: 'ATTEMPT_INTERACTION',
        objectIds: rawTargets.map((slug) => uuidFromSlug(slug)),
        interactionTypes: (t.interaction_types as string[] | undefined) ?? ['force'],
      };
    }
    case 'compound_player_action':
      return {
        kind: 'COMPOUND_ACTION',
        required:
          (t.required_actions as string[] | undefined)?.map((label) => ({
            intent: 'ACT',
            targetKind: 'SELF',
            sourceLabel: label,
          })) ?? [],
      };
    case 'object_changed':
      return {
        kind: 'OBJECT_CHANGED',
        objectId: uuidFromSlug(String(t.target ?? t.object ?? 'unknown')),
        key: typeof t.key === 'string' ? t.key : undefined,
      };
    case 'object_unlocked':
      return { kind: 'OBJECT_UNLOCKED', objectId: uuidFromSlug(String(t.target ?? t.object ?? 'unknown')) };
    case 'take_item':
      return { kind: 'ITEM_TAKEN', itemSlug: String(t.item ?? t.target ?? 'unknown') };
    default:
      throw new Error(`неизвестный тип триггера v1: ${t.type}`);
  }
}

function toV3Condition(condition: Record<string, unknown>, roomId: string): unknown {
  if (condition.type === 'state_is') {
    return {
      op: 'EQ',
      // D174/K5: локальные флаги получают namespace комнаты
      path: { kind: 'FLAG', key: `${roomId}.${String(condition.path)}` },
      value: condition.equals,
    };
  }
  throw new Error(`неизвестный тип условия v1: ${String(condition.type)}`);
}

function toV3Effect(effect: Record<string, unknown>, roomId: string): unknown {
  switch (effect.type) {
    case 'set_flag':
      // 1 случай в данных — set_flag без value (reception_entered): контракт даёт default true
      return effect.value === undefined
        ? { kind: 'SET_FLAG', key: `${roomId}.${String(effect.flag)}` }
        : { kind: 'SET_FLAG', key: `${roomId}.${String(effect.flag)}`, value: effect.value };
    case 'narrative_marker': {
      // В данных две формы: {message} (6) и {value} (1 — LOUD_HACK_NO_FLOOR_EFFECT,
      // «маркер шума», а не текст). Вторую конвертер сводит к флагу-маркеру (D185).
      const message = effect.message;
      if (typeof message === 'string' && message.trim().length > 0) {
        return { kind: 'EMIT_NARRATIVE', text: message, visibility: 'PUBLIC' };
      }
      return { kind: 'SET_FLAG', key: `${roomId}.marker.${String(effect.value ?? 'unknown')}`, value: true };
    }
    case 'move_group':
      return { kind: 'TELEPORT', toLocationId: uuidFromSlug(String(effect.target)) }; // K4: playerIds опущен → вся группа
    case 'reveal_object':
      return { kind: 'REVEAL_OBJECT', objectId: uuidFromSlug(String(effect.object ?? effect.target ?? 'unknown')) };
    case 'change_object_state':
      return {
        kind: 'CHANGE_OBJECT_STATE',
        objectId: uuidFromSlug(String(effect.object ?? 'unknown')),
        patch: (effect.patch as Record<string, unknown>) ?? {},
      };
    default:
      throw new Error(`неизвестный тип эффекта v1: ${String(effect.type)}`);
  }
}

const GUIDANCE_KEY_MAP: Record<string, string> = {
  purpose: 'purpose',
  sequence: 'sequence',
  must_not_explain: 'mustNotExplain',
  allowed_revelation: 'allowedRevelation',
  forbidden_revelation: 'forbiddenRevelation',
  effect: 'effect',
  mechanical_consequence: 'mechanicalConsequence',
  important: 'important',
  forbidden: 'forbidden',
  consequence: 'consequence',
  default_visibility: 'defaultVisibility',
  frequency: 'frequency',
  secret_role: 'secretRole',
  condition_note: 'conditionNote',
};

describe('Реальные данные мира → контракты v3', () => {
  it('загружены все комнаты этажей 0 и −1', () => {
    expect(roomFiles.length).toBeGreaterThanOrEqual(7);
    expect(rooms.map((r) => r.room_id)).toContain('floor0_airlock');
    expect(rooms.map((r) => r.room_id)).toContain('floor-1_lobby');
  });

  it('КАЖДЫЙ триггер v1 выражается схемой TriggerSchema (K1–K3, K14)', () => {
    let checked = 0;
    for (const room of rooms) {
      for (const event of room.events ?? []) {
        const trigger = toV3Trigger(event.trigger, room.room_id);
        const result = TriggerSchema.safeParse(trigger);
        expect(
          result.success,
          `${room.room_id}/${event.id}: ${JSON.stringify(trigger)} — ${result.success ? '' : result.error.issues[0]?.message}`,
        ).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  it('КАЖДОЕ условие v1 выражается ConditionSchema с namespace флага (K5/D174)', () => {
    let checked = 0;
    for (const room of rooms) {
      for (const event of room.events ?? []) {
        for (const condition of event.conditions ?? []) {
          const v3 = toV3Condition(condition, room.room_id);
          const result = ConditionSchema.safeParse(v3);
          expect(
            result.success,
            `${room.room_id}/${event.id}: ${result.success ? '' : result.error.issues[0]?.message}`,
          ).toBe(true);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('КАЖДЫЙ эффект v1 выражается EffectSchema (K4, K15)', () => {
    let checked = 0;
    for (const room of rooms) {
      for (const event of room.events ?? []) {
        for (const effect of event.effects ?? []) {
          const v3 = toV3Effect(effect, room.room_id);
          const result = EffectSchema.safeParse(v3);
          expect(
            result.success,
            `${room.room_id}/${event.id}: ${result.success ? '' : result.error.issues[0]?.message}`,
          ).toBe(true);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(90);
  });

  it('событие целиком проходит WorldEventSchema (priority, conditions[], aiGuidance — F-4.2, K10)', () => {
    let checked = 0;
    for (const room of rooms) {
      for (const event of room.events ?? []) {
        const guidance: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(event.narrative_guidance ?? {})) {
          const mapped = GUIDANCE_KEY_MAP[key];
          if (mapped === undefined)
            throw new Error(`нет маппинга для narrative_guidance.${key} (${room.room_id}/${event.id})`);
          guidance[mapped] = value;
        }
        const parsed = WorldEventSchema.safeParse({
          eventId: uuidFromSlug(`${room.room_id}.${event.id}`),
          sessionId: null,
          templateSlug: `evt_${event.id.toLowerCase()}`,
          locationId: uuidFromSlug(room.room_id),
          name: event.id,
          category: event.category ?? 'custom',
          priority: 0,
          trigger: toV3Trigger(event.trigger, room.room_id),
          conditions: (event.conditions ?? []).map((c) => toV3Condition(c, room.room_id)),
          effects: (event.effects ?? []).map((e) => toV3Effect(e, room.room_id)),
          once: event.once ?? true,
          aiGuidance: Object.keys(guidance).length > 0 ? guidance : null,
          requiresModule: event.trigger.type === 'take_item' ? 'inventory' : null,
          tags: [],
        });
        expect(
          parsed.success,
          `${room.room_id}/${event.id}: ${parsed.success ? '' : parsed.error.issues[0]?.message}`,
        ).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  it('все 14 ключей narrative_guidance помещаются в EventAiGuidanceSchema (K10, D191)', () => {
    const keys = Object.keys(EventAiGuidanceSchema.shape as Record<string, unknown>);
    for (const mapped of Object.values(GUIDANCE_KEY_MAP)) {
      expect(keys, mapped).toContain(mapped);
    }
    expect(Object.keys(GUIDANCE_KEY_MAP)).toHaveLength(14);
  });

  it('атмосфера всех комнат влезает в лимит 1000 (D179)', () => {
    for (const room of rooms) {
      const parts = room.atmosphere ?? {};
      const flat = Object.keys(parts)
        .map((k) => `${k}: ${parts[k]}`)
        .join('; ');
      expect(flat.length, `${room.room_id}: ${flat.length}`).toBeLessThanOrEqual(1000);
      expect(LocationDefinitionSchema.shape.atmosphere.safeParse(flat).success, room.room_id).toBe(true);
    }
  });

  it('у каждой комнаты есть источник описания (D176)', () => {
    for (const room of rooms) {
      const base = (room.base_description ?? '').trim();
      const snippet = (room.lore?.public_revelation?.text_snippet ?? '').trim();
      expect(base.length > 0 || snippet.length > 0, `${room.room_id}: нет ни base_description, ни text_snippet`).toBe(
        true,
      );
      const description = base.length > 0 ? base : snippet;
      expect(LocationDefinitionSchema.shape.description.safeParse(description).success, room.room_id).toBe(true);
    }
  });

  it('все подписи выходов ≤60 символов (D177/D183)', () => {
    let total = 0;
    for (const room of rooms) {
      for (const exit of room.exits ?? []) {
        const title = titleOf.get(exit.target_room_id) ?? null;
        const { label } = deriveExitLabel(exit, title) as { label: string; source: string; needsReview: boolean };
        expect(label.length, `${room.room_id} → ${exit.target_room_id}: «${label}»`).toBeLessThanOrEqual(60);
        expect(label.length).toBeGreaterThan(0);
        total += 1;
      }
    }
    expect(total).toBeGreaterThan(12);
  });

  it('склонение: «Смотровая А» → «Смотровую А», одиночные буквы и аббревиатуры не склоняются', () => {
    expect((toAccusative('Смотровая А (Первичный осмотр)') as { text: string }).text).toBe(
      'Смотровую А (Первичный осмотр)',
    );
    expect((toAccusative('Регистратура') as { text: string }).text).toBe('Регистратуру');
    expect((toAccusative('Светлый холл') as { text: string }).text).toBe('Светлый холл');
    expect((toAccusative('Комната релаксации') as { text: string }).text).toBe('Комнату релаксации');
    expect((toAccusative('Раздевалка') as { text: string }).text).toBe('Раздевалку');
  });

  it('Локация целиком проходит LocationDefinitionSchema (полная конвертация Шлюза)', () => {
    const airlock = rooms.find((r) => r.room_id === 'floor0_airlock');
    expect(airlock).toBeDefined();
    const room = airlock as V1Room;
    const parts = room.atmosphere ?? {};
    const base = (room.base_description ?? '').trim();
    const description = base.length > 0 ? base : ((room.lore?.public_revelation?.text_snippet ?? '') as string);

    // объекты, на которые ссылаются события (D172: derived)
    const objectSlugs = new Set<string>();
    for (const event of room.events ?? []) {
      const t = event.trigger as Record<string, unknown>;
      if (typeof t.target === 'string') objectSlugs.add(t.target);
      for (const target of (t.targets as string[] | undefined) ?? []) objectSlugs.add(target);
    }

    const location = {
      locationId: uuidFromSlug(room.room_id),
      sessionId: null,
      templateSlug: room.room_id,
      name: room.title,
      description,
      atmosphere: Object.keys(parts)
        .map((k) => `${k}: ${parts[k]}`)
        .join('; '),
      objects: [...objectSlugs].map((slug) => ({
        objectId: uuidFromSlug(slug),
        name: slug.replace(/_/g, ' '),
        description: '',
        interactive: true,
        takeable: false,
        itemMeta: null,
        source: 'derived',
      })),
      exits: (room.exits ?? []).map((exit) => {
        const title = titleOf.get(exit.target_room_id) ?? null;
        const known = title !== null;
        const { label } = deriveExitLabel(exit, title) as { label: string };
        return {
          kind: known ? 'LOCATION' : 'DESCRIPTIVE',
          toLocationId: known ? uuidFromSlug(exit.target_room_id) : null,
          label,
          description: exit.direction ?? null,
          oneWay: exit.one_way ?? false,
          hidden: exit.hidden ?? false,
          via: exit.via ?? null,
          locked: exit.is_locked ?? false,
          lock: {
            type: exit.lock_type ?? null,
            keyRequired: exit.key_required ?? null,
            requiresFlag: exit.requires_flag ?? null,
            reason: null,
          },
        };
      }),
      hazards: [
        { kind: 'GAS', level: (room as unknown as { hazards?: { gas_level?: string } }).hazards?.gas_level ?? 'none' },
        {
          kind: 'DARKNESS',
          requiresLight: Boolean(
            (room as unknown as { hazards?: { darkness_requires_light?: boolean } }).hazards?.darkness_requires_light,
          ),
        },
      ],
      registeredEventIds: (room.events ?? []).map((e) => uuidFromSlug(`${room.room_id}.${e.id}`)),
      narrativeNotes: room.lore?.public_revelation?.summary ?? '',
      aiGuidance: null,
      gmSecret: null,
      tags: ['intro'],
      meta: {
        floor: room.floor,
        indexOnFloor: 0,
        floorName: 'Поверхность / входной узел',
        batch: 1,
        origin: 'v1',
        atmosphereParts: parts,
        actors: undefined,
        items: undefined,
      },
      updatedAt: null,
    };

    const result = LocationDefinitionSchema.safeParse(location);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues.slice(0, 3))).toBe(true);
    if (result.success) {
      expect(result.data.objects.length).toBeGreaterThanOrEqual(4);
      expect(result.data.exits.find((e) => e.kind === 'DESCRIPTIVE')?.toLocationId).toBeNull();
    }
  });

  it('GM-only блок отсутствует в схемах публичного и AI-видов (K7/K11, блокер B-10)', () => {
    // Структурная проверка: в contracts gmSecret есть только у GmLocationView.
    const keysOf = (schema: z.ZodTypeAny): string[] => {
      const shape = (schema as unknown as { _def?: { shape?: () => Record<string, z.ZodTypeAny> } })._def?.shape?.();
      return shape ? Object.keys(shape) : [];
    };
    expect(keysOf(PublicLocationViewSchema)).not.toContain('gmSecret');
    expect(keysOf(AiLocationViewSchema)).not.toContain('gmSecret');
    expect(keysOf(GmLocationViewSchema)).toContain('gmSecret');
    expect(keysOf(PublicGameStateViewSchema)).not.toContain('gmSecret');
    expect(keysOf(PublicGameStateViewSchema)).not.toContain('knowledge');
    expect(keysOf(AiLocationViewSchema)).toContain('narrativeNotes');
    expect(keysOf(PublicLocationViewSchema)).not.toContain('narrativeNotes');
  });

  it('у каждого .gm.json есть парный публичный файл (Q11 закрыт: 8 комнат, 8 GM-файлов)', () => {
    const orphans: string[] = [];
    for (const file of readdirSync(ROOMS).filter((f) => f.endsWith('.gm.json'))) {
      const publicFile = resolve(ROOMS, file.replace(/\.gm\.json$/, '.json'));
      if (!existsSync(publicFile)) orphans.push(file);
    }
    expect(orphans).toEqual([]);
    expect(readdirSync(ROOMS).filter((f) => !f.endsWith('.gm.json'))).toHaveLength(8);
  });
});
