import { describe, expect, it } from 'vitest';
import { defineModule, type ModuleContract } from '@mnemosin/contracts';
import { InProcessEventBus } from '@mnemosin/core';
import type { ChatService } from '@mnemosin/module-chat';
import type { GmService } from '@mnemosin/module-gm';
import type { GmAuditService } from '@mnemosin/module-gm-audit';
import {
  attachModulesRegistry,
  buildStage1Registrations,
  mediaDirectorContract,
  validateModulesRegistry,
  type ModuleRegistration,
} from '@mnemosin/server';

/**
 * Реестр модулей этапа 1 (промпт 1.9, п.8; F-8.3: «9 модулей»).
 *
 * Валидация: emits/subscribes ⊆ каталога событий, владелец emits по
 * EVENT_EMITTERS, подписчик ∈ EVENT_SUBSCRIBERS, dependencies ⊆ ModuleIdSchema
 * и ацикличны, idempotentCommands ⊆ commands, обработчики ⊆ subscribes.
 * Boot-подписка: реальные обработчики вызываются, декларативные — log-only.
 */

const noopServices = {
  chat: {} as ChatService,
  gm: {} as GmService,
  gmAudit: {} as GmAuditService,
};

describe('modules-registry · состав (F-8.3)', () => {
  it('ровно 9 модулей этапа 1, все moduleId из каталога, валидация проходит', () => {
    const registrations = buildStage1Registrations(noopServices);
    expect(registrations).toHaveLength(9);
    const ids = registrations.map((registration) => registration.contract.moduleId).sort();
    expect(ids).toEqual(
      ['ai-director', 'chat', 'gm', 'gm-audit', 'gm-review', 'media-director', 'session', 'story', 'turn'].sort(),
    );
    expect(() => validateModulesRegistry(registrations)).not.toThrow();
    // media-director — декларация этапа 1 (реализация 2.10–2.12)
    const media = registrations.find((registration) => registration.contract.moduleId === 'media-director');
    expect(media?.stage1Implemented).toBe(false);
    expect(mediaDirectorContract.capabilities).toEqual(['IMAGE_GENERATION', 'IMAGE_EDITING']);
  });
});

describe('modules-registry · валидация ловит нарушения', () => {
  const valid = buildStage1Registrations(noopServices);
  const withContract = (contract: ModuleContract): ModuleRegistration[] => [
    ...valid,
    { contract, stage1Implemented: true },
  ];

  it('неизвестное событие в emits → ошибка', () => {
    const bad = defineModule({
      moduleId: 'inventory',
      purpose: 'тест',
      version: '0.0.1',
      commands: {},
      queries: {},
      emits: ['НЕСУЩЕСТВУЮЩЕЕ_СОБЫТИЕ'],
    });
    expect(() => validateModulesRegistry(withContract(bad))).toThrowError(/отсутствует в каталоге/);
  });

  it('emits чужого события (владелец по EVENT_EMITTERS другой) → ошибка', () => {
    const bad = defineModule({
      moduleId: 'inventory',
      purpose: 'тест',
      version: '0.0.1',
      commands: {},
      queries: {},
      emits: ['TURN_COMMITTED'], // владелец — turn
    });
    expect(() => validateModulesRegistry(withContract(bad))).toThrowError(/владелец по EVENT_EMITTERS/);
  });

  it('подписка, которой нет в EVENT_SUBSCRIBERS → ошибка', () => {
    const bad = defineModule({
      moduleId: 'analytics',
      purpose: 'тест',
      version: '0.0.1',
      commands: {},
      queries: {},
      subscribes: ['CHAT_MESSAGE_PUBLIC'], // analytics в подписчиках не значится
    });
    expect(() => validateModulesRegistry(withContract(bad))).toThrowError(/EVENT_SUBSCRIBERS/);
  });

  it('цикл зависимостей → ошибка', () => {
    const inventory = defineModule({
      moduleId: 'inventory',
      purpose: 'тест',
      version: '0.0.1',
      commands: {},
      queries: {},
      dependencies: ['analytics'],
    });
    const analytics = defineModule({
      moduleId: 'analytics',
      purpose: 'тест',
      version: '0.0.1',
      commands: {},
      queries: {},
      dependencies: ['inventory'],
    });
    expect(() =>
      validateModulesRegistry([
        ...valid,
        { contract: inventory, stage1Implemented: true },
        { contract: analytics, stage1Implemented: true },
      ]),
    ).toThrowError(/цикл зависимостей/);
  });

  it('idempotentCommands со ссылкой на несуществующую команду → ошибка', () => {
    const bad = defineModule({
      moduleId: 'inventory',
      purpose: 'тест',
      version: '0.0.1',
      commands: {},
      queries: {},
      idempotentCommands: ['takeItem'],
    });
    expect(() => validateModulesRegistry(withContract(bad))).toThrowError(/неизвестную команду/);
  });

  it('дублирующая регистрация moduleId → ошибка', () => {
    expect(() => validateModulesRegistry([...valid, valid[0]!])).toThrowError(/дублирующая регистрация/);
  });
});

describe('modules-registry · boot-подписка subscribes→bus', () => {
  it('реальные обработчики вызываются; декларативные подписки не падают', async () => {
    const calls: string[] = [];
    const chat = {
      onTurnCommitted: async () => {
        calls.push('chat.TURN_COMMITTED');
      },
      onWorldEventFired: async () => {},
      onPlayerJoined: async () => {
        calls.push('chat.PLAYER_JOINED');
      },
      onPlayerLeft: async () => {},
      onSessionStatusChanged: async () => {},
    } as unknown as ChatService;
    const gm = {
      onTurnCommitted: async () => {
        calls.push('gm.TURN_COMMITTED');
      },
    } as unknown as GmService;
    const gmAudit = {
      onEvent: async () => {
        calls.push('gmAudit.onEvent');
      },
    } as unknown as GmAuditService;

    const bus = new InProcessEventBus();
    const registrations = buildStage1Registrations({ chat, gm, gmAudit });
    const detach = attachModulesRegistry(registrations, bus);

    const sessionId = '11111111-1111-4111-8111-111111111111';
    const turnId = '22222222-2222-4222-8222-222222222222';
    await bus.publish({
      type: 'TURN_COMMITTED',
      payload: { sessionId, turnId, version: 1 },
      emittedAt: '2026-10-14T00:00:00.000Z',
      traceId: 'trace-registry-test',
    });
    expect(calls).toContain('chat.TURN_COMMITTED');
    expect(calls).toContain('gm.TURN_COMMITTED');

    await bus.publish({
      type: 'GM_ACTION_PERFORMED',
      payload: {
        sessionId,
        gmPlayerId: '33333333-3333-4333-8333-333333333333',
        action: 'pauseSession',
        meta: {},
        idempotencyKey: null,
      },
      emittedAt: '2026-10-14T00:00:00.000Z',
      traceId: 'trace-registry-test-2',
    });
    expect(calls).toContain('gmAudit.onEvent');

    // декларативная подписка (story ← STATE_COMMITTED) — log-only, не падает
    const report = await bus.publish({
      type: 'STATE_COMMITTED',
      payload: { sessionId, version: 2, changedKeys: [] },
      emittedAt: '2026-10-14T00:00:00.000Z',
      traceId: 'trace-registry-test-3',
    });
    expect(report.failed).toBe(0);

    for (const off of detach) off();
  });
});
