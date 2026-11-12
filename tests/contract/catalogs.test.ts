import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  assertEventCatalogConsistent,
  ERROR_TABLE,
  ErrorCode,
  EVENT_EMITTERS,
  EVENT_NAMES,
  EVENT_SUBSCRIBERS,
  EventPayloadSchemas,
  FORBIDDEN_IN_BROADCAST,
  HTTP_ROUTES,
  ModuleIdSchema,
  routeKey,
  STAGE1_ROUTES,
  WS_CLIENT_TYPES,
  WS_REQUIRES_IDEMPOTENCY_KEY,
  WS_GM_ONLY,
  WS_PRIVACY_POLICY,
  WS_SERVER_TYPES,
  WSServerPayloadSchemas,
  WSClientPayloadSchemas,
} from '@mnemosin/contracts';

/**
 * Каталог-тесты (промпт 1.2): проверяют согласованность перечней, которые
 * в v3 были прозой и потому разъезжались с кодом (F-2.1…F-2.4, F-6.2, F-6.3).
 */

type Shape = Record<string, z.ZodTypeAny>;

function shapeOf(schema: z.ZodTypeAny): Shape | null {
  const maybe = schema as unknown as { _def?: { shape?: () => Shape; typeName?: string } };
  if (typeof maybe._def?.shape === 'function') return maybe._def.shape();
  return null;
}

/** Ключи схемы payload на глубину 2 (достаточно для поиска запрещённых полей). */
function collectKeys(schema: z.ZodTypeAny, depth = 2): string[] {
  const keys: string[] = [];
  const shape = shapeOf(schema);
  if (shape === null) return keys;
  for (const [key, child] of Object.entries(shape)) {
    keys.push(key);
    if (depth > 1) keys.push(...collectKeys(child, depth - 1));
  }
  return keys;
}

describe('Каталог WS (F-6.3)', () => {
  it('политика приватности задана для КАЖДОГО server-сообщения', () => {
    for (const type of WS_SERVER_TYPES) {
      expect(WS_PRIVACY_POLICY[type], type).toBeDefined();
    }
    expect(Object.keys(WS_PRIVACY_POLICY)).toHaveLength(WS_SERVER_TYPES.length);
  });

  it('в BROADCAST-сообщениях нет запрещённых per-player полей (блокер B-10)', () => {
    const violations: string[] = [];
    for (const type of WS_SERVER_TYPES) {
      if (WS_PRIVACY_POLICY[type] !== 'BROADCAST') continue;
      const keys = collectKeys(WSServerPayloadSchemas[type]);
      for (const key of keys) {
        if (FORBIDDEN_IN_BROADCAST.includes(key)) violations.push(`${type}.${key}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('GM_ONLY — все сообщения, содержащие черновик/состояние GM', () => {
    for (const type of [
      'TURN_DRAFT_READY',
      'TURN_RESOLUTION_GM',
      'GM_STATE',
      'GM_AI_CONTEXT',
      'CHAT_GM',
      'BUDGET_WARNING',
      'BUDGET_EXCEEDED',
    ] as const) {
      expect(WS_PRIVACY_POLICY[type], type).toBe('GM_ONLY');
    }
  });

  it('TARGETED — приватные данные одного игрока', () => {
    expect(WS_PRIVACY_POLICY.STATE_PROJECTION_PRIVATE).toBe('TARGETED');
    expect(WS_PRIVACY_POLICY.TURN_PRIVATE_RESOLUTION).toBe('TARGETED');
    expect(WS_PRIVACY_POLICY.CHAT_PRIVATE).toBe('TARGETED');
  });

  it('TURN_COMMITTED (broadcast) не содержит privateMessages и diagnostics', () => {
    const keys = collectKeys(WSServerPayloadSchemas.TURN_COMMITTED);
    expect(keys).not.toContain('privateMessages');
    expect(keys).not.toContain('diagnostics');
    expect(keys).toContain('publicSegments');
  });

  it('idempotencyKey обязателен ровно для тех client-типов, где он есть в схеме (B-08)', () => {
    const withKey = WS_CLIENT_TYPES.filter((type) =>
      collectKeys(WSClientPayloadSchemas[type], 1).includes('idempotencyKey'),
    );
    expect([...withKey].sort()).toEqual([...WS_REQUIRES_IDEMPOTENCY_KEY].sort());
  });

  it('все GM_* типы помечены как GM-only', () => {
    const gmTypes = WS_CLIENT_TYPES.filter((t) => t.startsWith('GM_'));
    expect([...gmTypes].sort()).toEqual([...WS_GM_ONLY].sort());
    expect(gmTypes.length).toBeGreaterThan(10);
  });

  it('client-типов 28, server-типов 35 (сверка с docs/SPEC_STAGE1.md)', () => {
    expect(WS_CLIENT_TYPES.length).toBe(28);
    expect(WS_SERVER_TYPES.length).toBe(35);
  });
});

describe('Каталог HTTP (B-11, B-12)', () => {
  it('ключи маршрутов уникальны', () => {
    const keys = HTTP_ROUTES.map(routeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('каждый маршрут имеет схемы request/response и непустой список ошибок (или он пуст осознанно)', () => {
    for (const route of HTTP_ROUTES) {
      expect(route.request, routeKey(route)).toBeDefined();
      expect(route.response, routeKey(route)).toBeDefined();
      expect(['none', 'player', 'gm', 'internal'], routeKey(route)).toContain(route.auth);
      expect([1, 2, 3], routeKey(route)).toContain(route.stage);
    }
  });

  it('все коды ошибок маршрутов существуют в ERROR_TABLE', () => {
    for (const route of HTTP_ROUTES) {
      for (const code of route.errors) {
        expect(ERROR_TABLE[code], `${routeKey(route)} → ${code}`).toBeDefined();
      }
    }
  });

  it('присутствуют маршруты, которых не было в v3 (B-11)', () => {
    const keys = new Set(HTTP_ROUTES.map(routeKey));
    for (const required of [
      'POST /auth/refresh',
      'POST /sessions/:id/pause',
      'POST /sessions/:id/resume',
      'POST /sessions/:id/end',
      'POST /sessions/:id/turns',
      'POST /sessions/:id/move',
      'POST /turns/:id/unlock',
      'POST /turns/:id/cancel',
      'POST /turns/:id/retry',
      'POST /turns/:id/edit-approve',
      'DELETE /sessions/:id/me',
      'GET /gm/audit',
      'POST /media/jobs/:id/cancel',
    ]) {
      expect(keys.has(required), required).toBe(true);
    }
  });

  it('ai/gm-проекции — отдельный GM-маршрут (блокер B-10)', () => {
    const publicProjection = HTTP_ROUTES.find((r) => r.path === '/state/projection');
    const gmProjection = HTTP_ROUTES.find((r) => r.path === '/state/projection/gm');
    expect(publicProjection?.auth).toBe('player');
    expect(gmProjection?.auth).toBe('gm');
  });

  it('все маршруты этапа 1 входят в общий каталог', () => {
    const all = new Set(HTTP_ROUTES.map(routeKey));
    for (const route of STAGE1_ROUTES) expect(all.has(routeKey(route))).toBe(true);
    expect(STAGE1_ROUTES.length).toBe(32);
  });
});

describe('Каталог доменных событий (F-2.1, F-2.2, F-2.4, D115)', () => {
  it('каталог согласован: у каждого события есть эмитент и подписчики, самоподписок нет', () => {
    expect(assertEventCatalogConsistent()).toEqual([]);
  });

  it('эмитенты и подписчики — только moduleId, никаких адаптеров (F-2.2/F-2.4)', () => {
    for (const name of EVENT_NAMES) {
      expect(ModuleIdSchema.safeParse(EVENT_EMITTERS[name]).success, `эмитент ${name}`).toBe(true);
      for (const sub of EVENT_SUBSCRIBERS[name] ?? []) {
        expect(ModuleIdSchema.safeParse(sub).success, `подписчик ${name} → ${sub}`).toBe(true);
      }
    }
  });

  it('ai-director НЕ подписан на TURN_LOCKED — только командный вызов (D115, B-09)', () => {
    expect(EVENT_SUBSCRIBERS.TURN_LOCKED).not.toContain('ai-director');
    expect(EVENT_SUBSCRIBERS.TURN_LOCKED).toEqual([]);
  });

  it('события чата и GM-ревью присутствуют в каталоге (F-2.1)', () => {
    for (const name of [
      'CHAT_MESSAGE_PUBLIC',
      'CHAT_MESSAGE_PRIVATE',
      'CHAT_MESSAGE_SYSTEM',
      'CHAT_MESSAGE_GM',
      'GM_REVIEW_DECIDED',
      'SESSION_ENDED',
      'PLAYER_DISCONNECTED',
      'MEDIA_JOB_QUEUED',
      'TURN_UNLOCKED',
    ] as const) {
      expect(EVENT_NAMES, name).toContain(name);
    }
  });

  it('40 событий, у каждого payload-схема (инвариант 16)', () => {
    expect(EVENT_NAMES.length).toBe(40);
    expect(Object.keys(EVENT_EMITTERS)).toHaveLength(40);
  });

  it('каждый payload события содержит sessionId (F-2.9)', () => {
    const withoutSession: string[] = [];
    for (const name of EVENT_NAMES) {
      // CAPABILITY_CHANGED — глобальное событие: sessionId у него nullable, но поле есть.
      const keys = collectKeys(EventPayloadSchemas[name], 1);
      if (!keys.includes('sessionId') && !keys.includes('capability')) withoutSession.push(name);
    }
    expect(withoutSession).toEqual([]);
  });

  it('payload каждого события проходит парсинг на валидной фикстуре (инвариант 16)', () => {
    const uuid = '00000000-0000-4000-8000-000000000001';
    const at = '2026-10-12T10:00:00.000Z';
    const fixtures: Record<string, Record<string, unknown>> = {
      SESSION_CREATED: { sessionId: uuid, gmPlayerId: uuid, title: 'Цикл 48' },
      SESSION_STATUS_CHANGED: { sessionId: uuid, from: 'LOBBY', to: 'ACTIVE' },
      SESSION_ENDED: { sessionId: uuid, reason: 'завершена GM' },
      PLAYER_JOINED: { sessionId: uuid, playerId: uuid, displayName: 'Игрок', characterName: 'Аня' },
      PLAYER_LEFT: { sessionId: uuid, playerId: uuid, reason: 'LEFT' },
      PLAYER_DISCONNECTED: { sessionId: uuid, playerId: uuid, connectionId: uuid },
      TURN_OPENED: { sessionId: uuid, turnId: uuid, number: 1 },
      TURN_LOCKED: { sessionId: uuid, turnId: uuid, actionIds: [uuid] },
      TURN_UNLOCKED: { sessionId: uuid, turnId: uuid },
      TURN_PROCESSING_STARTED: { sessionId: uuid, turnId: uuid },
      TURN_DRAFT_READY: { sessionId: uuid, turnId: uuid },
      TURN_COMMITTED: { sessionId: uuid, turnId: uuid, version: 8 },
      TURN_FAILED: { sessionId: uuid, turnId: uuid, errorCode: 'PROVIDER_TIMEOUT', message: 'таймаут' },
      ACTION_SUBMITTED: { sessionId: uuid, turnId: uuid, actionId: uuid, playerId: uuid, sequenceId: 1 },
      LOCATION_CHANGED: { sessionId: uuid, fromLocationId: uuid, toLocationId: uuid, playerIds: [uuid] },
      EVENT_REGISTERED: { sessionId: uuid, eventId: uuid, locationId: uuid },
      WORLD_EVENT_FIRED: { sessionId: uuid, eventId: uuid, turnId: uuid, effectsCount: 3 },
      EFFECT_DEFERRED: { sessionId: uuid, deferredId: 1, reason: 'EVENT_EFFECT_CONFLICT', applyAtTurnNumber: 2 },
      STATE_COMMITTED: { sessionId: uuid, version: 8, changedKeys: ['storyFlags.x'] },
      GM_ACTION_PERFORMED: {
        sessionId: uuid,
        gmPlayerId: uuid,
        action: 'lockTurn',
        meta: {},
        idempotencyKey: 'k'.repeat(20),
      },
      GM_NOTE_ADDED: { sessionId: uuid, noteId: uuid, visibility: 'GM_ONLY' },
      GM_REVIEW_DECIDED: { sessionId: uuid, turnId: uuid, gmPlayerId: uuid, decision: 'APPROVE' },
      VISUAL_SCENE_REQUESTED: { sessionId: uuid, mediaJobId: uuid, turnId: uuid, promptHash: 'a'.repeat(64) },
      MEDIA_JOB_QUEUED: { sessionId: uuid, mediaJobId: uuid, queueDepth: 1 },
      MEDIA_GENERATION_STARTED: { sessionId: uuid, mediaJobId: uuid, providerId: 'debug' },
      MEDIA_READY: { sessionId: uuid, mediaJobId: uuid, url: '/media/files/x.svg', seed: 7, providerId: 'debug' },
      MEDIA_FAILED: { sessionId: uuid, mediaJobId: uuid, errorCode: 'PROVIDER_TIMEOUT', providerId: 'comfyui' },
      CAPABILITY_CHANGED: {
        capability: 'TEXT_AI',
        available: false,
        providers: [],
        reason: 'breaker',
        sessionId: null,
      },
      AI_DRAFT_PROPOSED: { sessionId: uuid, turnId: uuid, proposalHash: 'b'.repeat(64) },
      AI_GENERATION_FAILED: { sessionId: uuid, turnId: uuid, errorCode: 'PROVIDER_SCHEMA', providerId: 'openrouter' },
      CHAT_MESSAGE_PUBLIC: { sessionId: uuid, messageId: uuid, fromPlayerId: uuid, turnId: null },
      CHAT_MESSAGE_PRIVATE: { sessionId: uuid, messageId: uuid, fromPlayerId: uuid, toPlayerId: uuid, turnId: null },
      CHAT_MESSAGE_SYSTEM: { sessionId: uuid, messageId: uuid, turnId: null },
      CHAT_MESSAGE_GM: { sessionId: uuid, messageId: uuid, turnId: null },
      AUDIO_REQUESTED: { sessionId: uuid, audioJobId: uuid, turnId: uuid, textHash: 'c'.repeat(64) },
      AUDIO_READY: { sessionId: uuid, audioJobId: uuid, url: '/media/files/a.wav', providerId: 'mock-tts' },
      AUDIO_FAILED: { sessionId: uuid, audioJobId: uuid, errorCode: 'PROVIDER_TIMEOUT' },
      BUDGET_WARNING: { sessionId: uuid, spentUsd: 4, budgetUsd: 5 },
      BUDGET_EXCEEDED: { sessionId: uuid, spentUsd: 5.2, budgetUsd: 5, disabledCapability: 'IMAGE_GENERATION' },
      SNAPSHOT_TAKEN: { sessionId: uuid, turnId: uuid, version: 8 },
    };
    for (const name of EVENT_NAMES) {
      const fixture = fixtures[name];
      expect(fixture, `нет фикстуры для ${name}`).toBeDefined();
      const result = EventPayloadSchemas[name].safeParse(fixture);
      expect(result.success, `${name}: ${result.success ? '' : result.error.issues[0]?.message}`).toBe(true);
    }
    void at;
  });
});

describe('Error Taxonomy', () => {
  it('ERROR_TABLE покрывает все значения ErrorCode', () => {
    const options = (ErrorCode as unknown as { options: readonly z.ZodTypeAny[] }).options ?? [];
    const codes: string[] = [];
    for (const option of options) {
      const values = (option as unknown as { options: readonly string[] }).options ?? [];
      codes.push(...values);
    }
    expect(codes.length).toBeGreaterThan(40);
    for (const code of codes) expect(ERROR_TABLE, code).toHaveProperty(code);
  });

  it('каждый HTTP-код в таблице — 4xx/5xx', () => {
    for (const descriptor of Object.values(ERROR_TABLE)) {
      expect(descriptor.http).toBeGreaterThanOrEqual(400);
      expect(descriptor.http).toBeLessThan(600);
    }
  });
});
