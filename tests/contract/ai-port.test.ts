import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { AIResponseSchema, EVENT_NAMES, ModuleIdSchema, ProviderError } from '@mnemosin/contracts';
import {
  ACTION_COUNT_MARKER,
  EchoAI,
  ECHO_MODEL,
  FailingAI,
  PLACEHOLDER_PLAYER_PREFIX,
  SCRIPTED_MODEL,
  ScriptedAI,
  echoNarrative,
} from '@mnemosin/ai';
import { aiDirectorContract } from '@mnemosin/module-ai-director';

import { describeAIPortCompliance, makeGenerateInput, makeTestDirectorContext } from './ai-port-compliance.js';

/**
 * Contract-тесты промпта 1.7: три офлайн-стенда прогоняются через ОБЩИЙ набор
 * инвариантов AIPort (ai-port-compliance.ts — шаблон для OpenRouter в этапе 2)
 * + специфика стендов + контракт модуля ai-director.
 */

const ROOT = process.cwd();
const FIXTURE_PATH = resolve(ROOT, 'tools/fixtures/resolution.ok.json');

describeAIPortCompliance([
  {
    title: 'ScriptedAI (scripted)',
    providerId: 'scripted',
    available: true,
    outcome: 'valid',
    deterministic: true,
    respectsAbort: true,
    create: () => new ScriptedAI({ fixturePath: FIXTURE_PATH }),
  },
  {
    title: 'EchoAI (echo)',
    providerId: 'echo',
    available: true,
    outcome: 'valid',
    deterministic: true,
    respectsAbort: true,
    create: () => new EchoAI(),
  },
  {
    title: 'FailingAI (timeout)',
    providerId: 'failing',
    available: true,
    outcome: 'error',
    errorCode: 'PROVIDER_TIMEOUT',
    respectsAbort: true,
    generateTimeoutMs: 10, // стенд ждёт timeoutMs+1s: держим тест ~1с
    create: () => new FailingAI({ mode: 'timeout' }),
  },
  {
    title: 'FailingAI (schema)',
    providerId: 'failing',
    available: true,
    outcome: 'invalid',
    create: () => new FailingAI({ mode: 'schema' }),
  },
  {
    title: 'FailingAI (rate_limit)',
    providerId: 'failing',
    available: true,
    outcome: 'error',
    errorCode: 'PROVIDER_RATE_LIMIT',
    create: () => new FailingAI({ mode: 'rate_limit' }),
  },
  {
    title: 'FailingAI (unavailable)',
    providerId: 'failing',
    available: false,
    outcome: 'error',
    errorCode: 'PROVIDER_UNAVAILABLE',
    create: () => new FailingAI({ mode: 'unavailable' }),
  },
]);

describe('ScriptedAI — специфика стенда (промпт 1.7, п.2)', () => {
  it('фикстура валидна по AIResponseSchema и соответствует требованиям промта', () => {
    const fixture = AIResponseSchema.parse(JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')));
    expect(fixture.privateMessages).toHaveLength(6);
    expect(fixture.proposedObjectChanges).toHaveLength(1);
    expect(fixture.visualSceneDescription).not.toBeNull();
    // remap.stage1.json: events = {} → proposedEvents пусты (правило промта).
    expect(fixture.proposedEvents).toEqual([]);
    expect(fixture.narrative).toContain(ACTION_COUNT_MARKER);
  });

  it('подставляет число действий из context в narrative (связь со входом видна)', async () => {
    const port = new ScriptedAI({ fixturePath: FIXTURE_PATH });
    const context = makeTestDirectorContext(); // 2 действия
    const result = await port.generate(makeGenerateInput(context));
    expect(result.response.narrative).toContain('2');
    expect(result.response.narrative).not.toContain(ACTION_COUNT_MARKER);
  });

  it('заменяет плейсхолдер-playerId приватных сообщений на игроков из context (round-robin)', async () => {
    const port = new ScriptedAI({ fixturePath: FIXTURE_PATH });
    const context = makeTestDirectorContext();
    const knownIds = new Set(context.characterNames.map((entry) => entry.playerId));
    const result = await port.generate(makeGenerateInput(context));
    expect(result.response.privateMessages).toHaveLength(6);
    for (const message of result.response.privateMessages) {
      expect(message.playerId.startsWith(PLACEHOLDER_PLAYER_PREFIX)).toBe(false);
      expect(knownIds.has(message.playerId)).toBe(true);
    }
    // round-robin: каждый из двух игроков получил ровно 3 сообщения
    const counts = new Map<string, number>();
    for (const message of result.response.privateMessages) {
      counts.set(message.playerId, (counts.get(message.playerId) ?? 0) + 1);
    }
    expect([...counts.values()].sort()).toEqual([3, 3]);
  });

  it('usage — детерминированные псевдозначения: inputTokens = ⌈|JSON(context)|/4⌉', async () => {
    const port = new ScriptedAI({ fixturePath: FIXTURE_PATH });
    const context = makeTestDirectorContext();
    const result = await port.generate(makeGenerateInput(context));
    expect(result.usage).not.toBeNull();
    expect(result.usage?.inputTokens).toBe(Math.ceil(JSON.stringify(context).length / 4));
    expect(result.usage?.model).toBe(SCRIPTED_MODEL);
  });

  it('отсутствующая и битая фикстура → конструктор бросает (fail-fast)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mnemosin-scripted-'));
    try {
      expect(() => new ScriptedAI({ fixturePath: join(dir, 'missing.json') })).toThrow();

      writeFileSync(join(dir, 'not-json.json'), '{ это не JSON', 'utf8');
      expect(() => new ScriptedAI({ fixturePath: join(dir, 'not-json.json') })).toThrow();

      // Валидный JSON, но не AIResponse (narrative пуст) — тоже fail-fast.
      writeFileSync(join(dir, 'bad-schema.json'), JSON.stringify({ narrative: '' }), 'utf8');
      expect(() => new ScriptedAI({ fixturePath: join(dir, 'bad-schema.json') })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('EchoAI — специфика стенда (промпт 1.7, п.3)', () => {
  it('narrative собирается из rawText в порядке sequenceId, даже если массив перемешан', async () => {
    const port = new EchoAI();
    const context = makeTestDirectorContext();
    const shuffled = [context.visiblePlayerActions[1]!, context.visiblePlayerActions[0]!];
    const result = await port.generate(makeGenerateInput({ ...context, visiblePlayerActions: shuffled }));
    const first = shuffled[1]!.rawText;
    const second = shuffled[0]!.rawText;
    expect(result.response.narrative).toBe(`Вы делаете: ${first}; ${second}.`);
    expect(result.response.privateMessages).toEqual([]);
    expect(result.response.proposedEvents).toEqual([]);
    expect(result.response.proposedObjectChanges).toEqual([]);
    expect(result.response.visualSceneDescription).toBeNull();
    expect(result.usage?.model).toBe(ECHO_MODEL);
  });

  it('без действий narrative остаётся валидным (min 1 символ)', async () => {
    const port = new EchoAI();
    const result = await port.generate(makeGenerateInput(makeTestDirectorContext({ visiblePlayerActions: [] })));
    expect(AIResponseSchema.safeParse(result.response).success).toBe(true);
    expect(result.response.narrative.startsWith('Вы делаете:')).toBe(true);
  });

  it('echoNarrative обрезает склейку по лимиту схемы (6000)', () => {
    const long = 'очень длинное действие игрока '.repeat(40); // ~1160 символов
    const narrative = echoNarrative(Array.from({ length: 12 }, () => long));
    expect(narrative.length).toBeLessThanOrEqual(6000);
    expect(narrative.startsWith('Вы делаете: ')).toBe(true);
    expect(narrative.endsWith('…')).toBe(true);
  });
});

describe('FailingAI — специфика стенда (промпт 1.7, п.4)', () => {
  it('режим timeout ждёт deadline.timeoutMs + 1s и бросает PROVIDER_TIMEOUT', async () => {
    const port = new FailingAI({ mode: 'timeout' });
    const startedAt = Date.now();
    const error = await port
      .generate(makeGenerateInput(makeTestDirectorContext(), 10))
      .catch((cause: unknown) => cause);
    const elapsed = Date.now() - startedAt;
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe('PROVIDER_TIMEOUT');
    expect(elapsed).toBeGreaterThanOrEqual(1000);
  }, 10_000);

  it('режим schema отдаёт заведомо невалидный ответ (ловится схемой заказчика)', async () => {
    const port = new FailingAI({ mode: 'schema' });
    const result = await port.generate(makeGenerateInput(makeTestDirectorContext()));
    expect(AIResponseSchema.safeParse(result.response).success).toBe(false);
    expect(result.usage).toBeNull();
  });

  it('режим unavailable: isAvailable() → false, generate() → PROVIDER_UNAVAILABLE', async () => {
    const port = new FailingAI({ mode: 'unavailable' });
    await expect(port.isAvailable()).resolves.toBe(false);
    await expect(port.generate(makeGenerateInput(makeTestDirectorContext()))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });
});

describe('Контракт модуля ai-director (промпт 1.7, п.6)', () => {
  it('moduleId/emits/subscribes/ports/capabilities — по промту, события ⊆ каталога', () => {
    expect(aiDirectorContract.moduleId).toBe('ai-director');
    expect(ModuleIdSchema.safeParse(aiDirectorContract.moduleId).success).toBe(true);
    expect([...aiDirectorContract.emits].sort()).toEqual(['AI_DRAFT_PROPOSED', 'AI_GENERATION_FAILED']);
    expect(aiDirectorContract.subscribes).toEqual(['GM_NOTE_ADDED']);
    // D115/B-09: вызов только командой из Turn Engine — подписки на TURN_LOCKED нет.
    expect(aiDirectorContract.subscribes).not.toContain('TURN_LOCKED');
    expect(aiDirectorContract.ports).toEqual(['AIPort']);
    expect(aiDirectorContract.capabilities).toEqual(['TEXT_AI']);
    expect(aiDirectorContract.dependencies).toEqual([]); // D161
    for (const eventName of [...aiDirectorContract.emits, ...aiDirectorContract.subscribes]) {
      expect(EVENT_NAMES).toContain(eventName);
    }
  });

  it('commands.generateDraft и queries.getDraft описаны Zod-схемами (F-8.1)', () => {
    const generate = aiDirectorContract.commands['generateDraft'];
    expect(generate).toBeDefined();
    expect(generate!.input.safeParse({ turnId: randomUUID(), traceId: 'trace-1' }).success).toBe(true);
    expect(generate!.input.safeParse({ turnId: 'не-uuid' }).success).toBe(false);
    expect(generate!.input.safeParse({}).success).toBe(false);

    const getDraft = aiDirectorContract.queries['getDraft'];
    expect(getDraft).toBeDefined();
    expect(getDraft!.input.safeParse({ turnId: randomUUID() }).success).toBe(true);
    expect(
      getDraft!.output.safeParse({
        turnId: randomUUID(),
        found: false,
        resolution: null,
        context: null,
        source: null,
      }).success,
    ).toBe(true);
  });

  it('idempotentCommands пуст: идемпотентность — ключом владельца resolve:{turnId} (B-08/D115)', () => {
    expect(aiDirectorContract.idempotentCommands).toEqual([]);
  });
});
