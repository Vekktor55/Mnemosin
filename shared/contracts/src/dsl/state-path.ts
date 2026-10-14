import { z } from 'zod';
import { ObjectId, PlayerId } from '../ids.js';
import { type TimeOfDay } from '../domain/state.js';

/**
 * StatePath (v3 §III.4) — структурированный union вместо регулярки (блокер B-03).
 *
 * Почему не регексп: в v3 ветка `worldState` не допускала полей, поэтому
 * `worldState.timeOfDay` из собственных примеров (§III.6, §III.8) не проходил
 * валидацию; а `storyFlags` ключевался UUID при обращении DSL по key.
 *
 * Сериализация обратима и совместима с примерами v3 (§8.2 аудита).
 */

const keyPattern = /^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,79}$/;
const stateKeyPattern = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,59}$/;

export const StatePathSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('WORLD'), field: z.enum(['timeOfDay', 'weather', 'currentLocationId']) }),
  z.object({ kind: z.literal('AMBIENT'), key: z.string().regex(keyPattern) }),
  z.object({ kind: z.literal('FLAG'), key: z.string().regex(keyPattern) }),
  z.object({ kind: z.literal('OBJECT'), objectId: ObjectId, key: z.string().regex(stateKeyPattern) }),
  z.object({ kind: z.literal('KNOWLEDGE'), playerId: PlayerId, key: z.string().regex(stateKeyPattern) }),
]);
export type StatePath = z.infer<typeof StatePathSchema>;

const PREFIX = {
  WORLD: 'worldState.',
  AMBIENT: 'ambientFlags.',
  FLAG: 'storyFlags.',
  OBJECT: 'objectStates.',
  KNOWLEDGE: 'playerKnowledge.',
} as const;

/** Детерминированная сериализация (используется как ключ при детекции конфликтов). */
export function serializePath(path: StatePath): string {
  switch (path.kind) {
    case 'WORLD':
      return `${PREFIX.WORLD}${path.field}`;
    case 'AMBIENT':
      return `${PREFIX.AMBIENT}${path.key}`;
    case 'FLAG':
      return `${PREFIX.FLAG}${path.key}`;
    case 'OBJECT':
      return `${PREFIX.OBJECT}${path.objectId}.${path.key}`;
    case 'KNOWLEDGE':
      return `${PREFIX.KNOWLEDGE}${path.playerId}.${path.key}`;
  }
}

/**
 * Обратный разбор. Формат `objectStates.<uuid>.<key>` однозначен: UUID не
 * содержит точек, поэтому первая точка после префикса разделяет id и ключ
 * (ключ может содержать точки — например `floor0_airlock.group_awake`).
 */
export function parsePath(serialized: string): StatePath {
  const fail = (reason: string): never => {
    throw new TypeError(`invalid StatePath "${serialized}": ${reason}`);
  };

  if (serialized.startsWith(PREFIX.WORLD)) {
    const field = serialized.slice(PREFIX.WORLD.length);
    const parsed = StatePathSchema.safeParse({ kind: 'WORLD', field });
    return parsed.success ? parsed.data : fail(`unknown worldState field "${field}"`);
  }
  if (serialized.startsWith(PREFIX.AMBIENT)) {
    return parseKeyed('AMBIENT', serialized, PREFIX.AMBIENT, keyPattern, fail);
  }
  if (serialized.startsWith(PREFIX.FLAG)) {
    return parseKeyed('FLAG', serialized, PREFIX.FLAG, keyPattern, fail);
  }
  if (serialized.startsWith(PREFIX.OBJECT)) {
    return parseIdKey('OBJECT', serialized, PREFIX.OBJECT, fail);
  }
  if (serialized.startsWith(PREFIX.KNOWLEDGE)) {
    return parseIdKey('KNOWLEDGE', serialized, PREFIX.KNOWLEDGE, fail);
  }
  return fail('неизвестный префикс (ожидается worldState.|ambientFlags.|storyFlags.|objectStates.|playerKnowledge.)');
}

function parseKeyed(
  kind: 'AMBIENT' | 'FLAG',
  serialized: string,
  prefix: string,
  pattern: RegExp,
  fail: (reason: string) => never,
): StatePath {
  const key = serialized.slice(prefix.length);
  if (!pattern.test(key)) fail(`ключ "${key}" не соответствует шаблону`);
  const parsed = StatePathSchema.safeParse({ kind, key });
  return parsed.success ? parsed.data : fail('не прошёл валидацию схемы');
}

function parseIdKey(
  kind: 'OBJECT' | 'KNOWLEDGE',
  serialized: string,
  prefix: string,
  fail: (reason: string) => never,
): StatePath {
  const rest = serialized.slice(prefix.length);
  const dot = rest.indexOf('.');
  if (dot <= 0 || dot === rest.length - 1) fail(`ожидается формат <uuid>.<key>, получено "${rest}"`);
  const rawId = rest.slice(0, dot);
  const key = rest.slice(dot + 1);
  const idSchema = kind === 'OBJECT' ? ObjectId : PlayerId;
  if (!idSchema.safeParse(rawId).success)
    fail(`"${rawId}" не является валидным ${kind === 'OBJECT' ? 'ObjectId' : 'PlayerId'}`);
  const parsed = StatePathSchema.safeParse({ kind, [kind === 'OBJECT' ? 'objectId' : 'playerId']: rawId, key });
  return parsed.success ? parsed.data : fail('не прошёл валидацию схемы');
}

/** Значение по пути (undefined, если пути нет — не исключение). */
export type PathValue = boolean | number | string | undefined;

export function readPath(
  state: {
    worldState: {
      timeOfDay: TimeOfDay;
      weather: string | null;
      currentLocationId: string;
      ambientFlags: Record<string, unknown>;
    };
    storyFlags: Record<string, { value: unknown }>;
    objectStates: Record<string, { state: Record<string, unknown>; visible: boolean; taken: boolean }>;
    playerKnowledge: Record<string, { entries: Array<{ key: string; value: unknown }> }>;
  },
  path: StatePath,
): PathValue {
  switch (path.kind) {
    case 'WORLD':
      return normalize(state.worldState[path.field]);
    case 'AMBIENT':
      return normalize(state.worldState.ambientFlags[path.key]);
    case 'FLAG':
      return normalize(state.storyFlags[path.key]?.value);
    case 'OBJECT': {
      const obj = state.objectStates[path.objectId];
      if (obj === undefined) return undefined;
      if (path.key === 'visible') return obj.visible;
      if (path.key === 'taken') return obj.taken;
      return normalize(obj.state[path.key]);
    }
    case 'KNOWLEDGE': {
      const entry = state.playerKnowledge[path.playerId]?.entries.find((e) => e.key === path.key);
      return normalize(entry?.value);
    }
  }
}

function normalize(value: unknown): PathValue {
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  return undefined;
}
