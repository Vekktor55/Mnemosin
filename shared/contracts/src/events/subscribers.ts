import type { ModuleId } from '../module.js';
import { EVENT_NAMES, type EventName } from './payloads.js';

/**
 * Эмитенты и подписчики как данные (v3 §II.16) с исправлениями:
 *  F-2.4 — в колонке Emits были `core`/`state`/`turn` (не moduleId); теперь только moduleId;
 *  F-2.2 — адаптеры не могут быть подписчиками (`media-provider (via port)` исключён):
 *          провайдер вызывается через порт, а не подписывается на события;
 *  D115  — ai-director НЕ подписан на TURN_LOCKED: вызывается только командой
 *          из Turn Engine (иначе двойная генерация, блокер B-09).
 *
 * `ws-gateway` и `client-projection` — инфраструктурные подписчики (не модули),
 * поэтому вынесены в отдельный список INFRA_SUBSCRIBERS.
 */

export const INFRA_SUBSCRIBERS = ['ws-gateway', 'projection-builder'] as const;
export type InfraSubscriber = (typeof INFRA_SUBSCRIBERS)[number];

export const EVENT_EMITTERS: Readonly<Record<EventName, ModuleId>> = Object.freeze({
  SESSION_CREATED: 'session',
  SESSION_STATUS_CHANGED: 'session',
  SESSION_ENDED: 'session',
  PLAYER_JOINED: 'session',
  PLAYER_LEFT: 'session',
  PLAYER_DISCONNECTED: 'session',
  TURN_OPENED: 'turn',
  TURN_LOCKED: 'turn',
  TURN_UNLOCKED: 'turn',
  TURN_PROCESSING_STARTED: 'turn',
  TURN_DRAFT_READY: 'turn',
  TURN_COMMITTED: 'turn',
  TURN_FAILED: 'turn',
  ACTION_SUBMITTED: 'turn',
  LOCATION_CHANGED: 'gm',
  EVENT_REGISTERED: 'session',
  WORLD_EVENT_FIRED: 'turn',
  EFFECT_DEFERRED: 'turn',
  STATE_COMMITTED: 'turn',
  GM_ACTION_PERFORMED: 'gm',
  GM_NOTE_ADDED: 'gm',
  GM_REVIEW_DECIDED: 'gm-review',
  VISUAL_SCENE_REQUESTED: 'media-director',
  MEDIA_JOB_QUEUED: 'media-director',
  MEDIA_GENERATION_STARTED: 'media-director',
  MEDIA_READY: 'media-director',
  MEDIA_FAILED: 'media-director',
  CAPABILITY_CHANGED: 'turn',
  AI_DRAFT_PROPOSED: 'ai-director',
  AI_GENERATION_FAILED: 'ai-director',
  CHAT_MESSAGE_PUBLIC: 'chat',
  CHAT_MESSAGE_PRIVATE: 'chat',
  CHAT_MESSAGE_SYSTEM: 'chat',
  CHAT_MESSAGE_GM: 'chat',
  AUDIO_REQUESTED: 'audio-director',
  AUDIO_READY: 'audio-director',
  AUDIO_FAILED: 'audio-director',
  BUDGET_WARNING: 'ai-director',
  BUDGET_EXCEEDED: 'ai-director',
  SNAPSHOT_TAKEN: 'turn',
});

export const EVENT_SUBSCRIBERS: Readonly<Record<EventName, readonly ModuleId[]>> = Object.freeze({
  SESSION_CREATED: ['chat', 'gm'],
  SESSION_STATUS_CHANGED: ['chat', 'gm'],
  SESSION_ENDED: ['chat'],
  PLAYER_JOINED: ['chat'],
  PLAYER_LEFT: ['chat'],
  PLAYER_DISCONNECTED: [],
  TURN_OPENED: ['gm'],
  TURN_LOCKED: [], // ai-director вызывается командой (D115), подписки нет
  TURN_UNLOCKED: [],
  TURN_PROCESSING_STARTED: [],
  TURN_DRAFT_READY: ['gm', 'gm-review'],
  TURN_COMMITTED: ['media-director', 'chat', 'gm-audit', 'audio-director'],
  TURN_FAILED: ['gm'],
  ACTION_SUBMITTED: [],
  LOCATION_CHANGED: ['media-director'],
  EVENT_REGISTERED: [],
  WORLD_EVENT_FIRED: ['media-director', 'chat', 'audio-director'],
  EFFECT_DEFERRED: ['gm'],
  STATE_COMMITTED: ['story'],
  GM_ACTION_PERFORMED: ['gm-audit'],
  GM_NOTE_ADDED: ['ai-director'],
  GM_REVIEW_DECIDED: ['gm-audit'],
  VISUAL_SCENE_REQUESTED: [],
  MEDIA_JOB_QUEUED: [],
  MEDIA_GENERATION_STARTED: [],
  MEDIA_READY: [],
  MEDIA_FAILED: [],
  CAPABILITY_CHANGED: ['ai-director', 'media-director', 'audio-director'],
  AI_DRAFT_PROPOSED: ['gm'],
  AI_GENERATION_FAILED: ['gm'],
  CHAT_MESSAGE_PUBLIC: [],
  CHAT_MESSAGE_PRIVATE: [],
  CHAT_MESSAGE_SYSTEM: [],
  CHAT_MESSAGE_GM: [],
  AUDIO_REQUESTED: [],
  AUDIO_READY: [],
  AUDIO_FAILED: [],
  BUDGET_WARNING: ['gm'],
  BUDGET_EXCEEDED: ['gm', 'media-director'],
  SNAPSHOT_TAKEN: [],
});

/** Проверка согласованности каталога (используется contract-тестом). */
export function assertEventCatalogConsistent(): string[] {
  const problems: string[] = [];
  for (const name of EVENT_NAMES) {
    if (!(name in EVENT_EMITTERS)) problems.push(`нет эмитента для ${name}`);
    if (!(name in EVENT_SUBSCRIBERS)) problems.push(`нет списка подписчиков для ${name}`);
    const emitter = EVENT_EMITTERS[name];
    if (emitter !== undefined && EVENT_SUBSCRIBERS[name]?.includes(emitter)) {
      problems.push(`${name}: эмитент ${emitter} подписан на собственное событие`);
    }
  }
  return problems;
}
