import { randomUUID } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AIResponseSchema,
  FlagKey,
  ProviderError,
  nowIso,
  type AIResponse,
  type NoteId,
  type PlayerId,
  type SessionId,
  type TurnId,
} from '@mnemosin/contracts';
import type { CoreServices } from '@mnemosin/core';
import { InMemoryMetricsSink, InProcessEventBus } from '@mnemosin/core';
import type { AIPort } from '@mnemosin/core';
import { CapabilityRegistry, EchoAI, FailingAI, SCRIPTED_MODEL, ScriptedAI } from '@mnemosin/ai';
import type { AIProviderRegistry } from '@mnemosin/module-ai-director';
import { AiDirectorService, buildDirectorContext } from '@mnemosin/module-ai-director';

import { bootLobby, buildTestServices, errorCodeOf, openTempDb, testKey, type TempDb } from './helpers.js';

/**
 * AiDirectorService (промпт 1.7, п.7, критерии A1.12/A1.13 на уровне сервисов):
 * сборка DirectorContext из настоящей БД, генерация черновика через цепочку
 * провайдеров, repair при PROVIDER_SCHEMA (ровно один), fallback scripted→echo,
 * исчерпание цепочки → AI_GENERATION_FAILED + PROVIDER_UNAVAILABLE, журнал
 * ai_decisions, метрики, getDraft.
 */

const ROOT = process.cwd();
const FIXTURE_PATH = resolvePath(ROOT, 'tools/fixtures/resolution.ok.json');
const PANEL_OBJECT_ID = '504a3329-490b-4d6d-85f7-752f2a69a605'; // «Панель шлюза» (remap.stage1.json)
const START_LOCATION_ID = '6db81341-81a6-4996-8dd3-90ece139dc5a'; // «Шлюз»
const INSTRUCTIONS = 'Тестовые указания Директору.';

const VALID_RESPONSE: AIResponse = {
  narrative: 'Запасной валидный ответ тестового провайдера.',
  privateMessages: [],
  proposedEvents: [],
  proposedObjectChanges: [],
  visualSceneDescription: null,
};

interface Harness {
  readonly db: TempDb;
  readonly services: CoreServices;
  readonly sessionId: SessionId;
  readonly gmPlayerId: PlayerId;
  readonly playerIds: PlayerId[];
  readonly turnId: TurnId;
  readonly bus: InProcessEventBus;
  readonly metrics: InMemoryMetricsSink;
  readonly events: Array<{ type: string; payload: Record<string, unknown> }>;
}

async function setupWorld(label: string, options: { actions?: number } = {}): Promise<Harness> {
  const db = await openTempDb(label, { seed: false });
  const services = buildTestServices(db);
  const world = await bootLobby(services, { players: 3 });
  const turnId = world.turnId!;
  for (let i = 0; i < (options.actions ?? 2); i++) {
    await services.turns.submitAction({
      turnId,
      playerId: world.playerIds[i % world.playerIds.length]!,
      rawText: i === 0 ? 'Осматриваюсь в шлюзе' : 'Слушаю гул вентиляции',
      idempotencyKey: testKey('act'),
    });
  }
  await services.turns.lockTurn({ turnId, idempotencyKey: testKey('lock') });
  await services.turns.transition({ turnId, trigger: 'startProcessing' });

  const bus = new InProcessEventBus();
  const metrics = new InMemoryMetricsSink();
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  bus.subscribe('*', (event) => {
    events.push({ type: event.type, payload: event.payload as unknown as Record<string, unknown> });
  });
  return {
    db,
    services,
    sessionId: world.sessionId,
    gmPlayerId: world.gmPlayerId,
    playerIds: world.playerIds,
    turnId,
    bus,
    metrics,
    events,
  };
}

interface DirectorOptions {
  readonly chain: readonly string[];
  readonly providers: ReadonlyArray<{ id: string; port: AIPort; policy?: Record<string, unknown> }>;
  readonly schemaRepairAttempts?: number;
}

function makeDirector(
  harness: Harness,
  options: DirectorOptions,
): { director: AiDirectorService; registry: CapabilityRegistry } {
  const registry = new CapabilityRegistry({
    chains: { TEXT_AI: { required: true, chain: options.chain } },
    policies: options.providers.map((provider) => ({
      providerId: provider.id,
      capability: 'TEXT_AI',
      timeoutMs: 2_000,
      retries: { max: 0, backoffMs: 10, jitter: false },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60_000 },
      costPer1kTokens: { input: null, output: null },
      ...provider.policy,
    })),
    bus: harness.bus,
    metrics: harness.metrics,
  });
  for (const provider of options.providers) {
    registry.register({ capability: 'TEXT_AI', providerId: provider.id, provider: provider.port });
  }
  const director = new AiDirectorService({
    uow: harness.db.boot.uow,
    registry,
    bus: harness.bus,
    metrics: harness.metrics,
    directorInstructions: INSTRUCTIONS,
    ...(options.schemaRepairAttempts === undefined ? {} : { schemaRepairAttempts: options.schemaRepairAttempts }),
  });
  return { director, registry };
}

/** Провайдер-«флаки»: первый ответ невалиден, после repair — валидный. */
class FlakySchemaProvider implements AIPort {
  readonly capability = 'TEXT_AI' as const;
  readonly calls: Array<{ context: { directorInstructions: string } }> = [];

  constructor(readonly providerId: string) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async generate(input: {
    context: { directorInstructions: string };
    schema: unknown;
    deadline: { timeoutMs: number; attempt: number };
    signal?: AbortSignal;
  }): Promise<{ response: AIResponse; usage: null; durationMs: number }> {
    this.calls.push({ context: { directorInstructions: input.context.directorInstructions } });
    const invalid = this.calls.length === 1;
    return {
      response: invalid ? ({ narrative: '', privateMessages: 'не массив' } as unknown as AIResponse) : VALID_RESPONSE,
      usage: null,
      durationMs: 1,
    };
  }
}

/** Провайдер, который ВСЕГДА возвращает невалидный ответ (проверка «repair ровно один раз»). */
class AlwaysBadSchemaProvider extends FlakySchemaProvider {
  override async generate(input: {
    context: { directorInstructions: string };
    schema: unknown;
    deadline: { timeoutMs: number; attempt: number };
    signal?: AbortSignal;
  }): Promise<{ response: AIResponse; usage: null; durationMs: number }> {
    this.calls.push({ context: { directorInstructions: input.context.directorInstructions } });
    return { response: { narrative: 42 } as unknown as AIResponse, usage: null, durationMs: 1 };
  }
}

// ---------------------------------------------------------------------------

describe('buildDirectorContext — сборка контекста из БД (промпт 1.7, п.7)', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await setupWorld('ai-context');
  });

  afterAll(async () => {
    await harness?.db.close();
  });

  it('контекст проходит DirectorContextSchema и отражает состояние партии', async () => {
    const { context, baseVersion } = await buildDirectorContext(
      { uow: harness.db.boot.uow },
      { turnId: harness.turnId, directorInstructions: INSTRUCTIONS },
    );
    expect(context.sessionId).toBe(harness.sessionId);
    expect(context.turnId).toBe(harness.turnId);
    expect(context.turnNumber).toBe(1);
    expect(context.currentLocation.locationId).toBe(START_LOCATION_ID);
    expect(context.currentLocation.name).toBe('Шлюз');
    expect(context.visiblePlayerActions).toHaveLength(2);
    expect(context.visiblePlayerActions.map((action) => action.sequenceId)).toEqual([1, 2]);
    expect(context.directorInstructions).toBe(INSTRUCTIONS);
    expect(context.namePolicy).toBe('ALL'); // D157
    expect(context.tokensEstimate).toBeGreaterThan(0);
    // Этап 1: событий в world-pack нет (remap.stage1.json: events={})
    expect(context.allowedEventIds).toEqual([]);
    expect(context.allowedEvents).toEqual([]);
    const state = await harness.services.state.get(harness.sessionId);
    expect(baseVersion).toBe(state.version);
    // GM входит в characterNames (K13: состав партии для нарратива)
    expect(context.characterNames).toHaveLength(4);
    expect(context.characterNames.map((entry) => entry.playerId)).toContain(harness.gmPlayerId);
  });

  it('gmNotesForAI — только заметки visibility=AI_DIRECTOR', async () => {
    const repos = harness.db.boot.uow.repos();
    const notes = [
      { visibility: 'AI_DIRECTOR' as const, text: 'Директору: намекнуть на брелок' },
      { visibility: 'GM_ONLY' as const, text: 'Секрет: за дверью никто не живёт' },
      { visibility: 'PUBLIC_AFTER_COMMIT' as const, text: 'После коммита: объявить тревогу' },
    ];
    for (const note of notes) {
      await repos.gmNotes.insert({
        noteId: randomUUID() as NoteId,
        sessionId: harness.sessionId,
        turnId: null,
        visibility: note.visibility,
        text: note.text,
        createdAt: nowIso(),
      });
    }
    const { context } = await buildDirectorContext(
      { uow: harness.db.boot.uow },
      { turnId: harness.turnId, directorInstructions: INSTRUCTIONS },
    );
    expect(context.gmNotesForAI).toEqual(['Директору: намекнуть на брелок']);
  });

  it('флаги партии попадают в relevantState.activeFlags и storyFacts', async () => {
    const state = await harness.services.state.get(harness.sessionId);
    await harness.services.state.apply({
      sessionId: harness.sessionId,
      mutations: [{ kind: 'SET_FLAG', key: FlagKey.parse('lights_on'), value: true, setBy: 'GM' }],
      expectedVersion: state.version,
      turnId: null,
      traceId: 'test-flag',
    });
    const { context } = await buildDirectorContext(
      { uow: harness.db.boot.uow },
      { turnId: harness.turnId, directorInstructions: INSTRUCTIONS },
    );
    expect(context.relevantState.activeFlags['lights_on']).toBe(true);
    expect(context.storyFacts.some((fact) => fact.includes('lights_on'))).toBe(true);
  });

  it('неизвестный ход → CORE_NOT_FOUND', async () => {
    const code = await errorCodeOf(() =>
      buildDirectorContext(
        { uow: harness.db.boot.uow },
        { turnId: randomUUID() as TurnId, directorInstructions: INSTRUCTIONS },
      ),
    );
    expect(code).toBe('CORE_NOT_FOUND');
  });
});

describe('generateDraft — успешная генерация через ScriptedAI', () => {
  let harness: Harness;
  let director: AiDirectorService;

  beforeAll(async () => {
    harness = await setupWorld('ai-draft-ok');
    ({ director } = makeDirector(harness, {
      chain: ['scripted'],
      providers: [{ id: 'scripted', port: new ScriptedAI({ fixturePath: FIXTURE_PATH }) }],
    }));
  });

  afterAll(async () => {
    await harness?.db.close();
  });

  it('черновик: source=AI, все item’ы PROPOSED, aiResponseHash — sha256(64), baseVersion из состояния', async () => {
    const stateBefore = await harness.services.state.get(harness.sessionId);
    const output = await director.generateDraft({ turnId: harness.turnId, traceId: 'trace-draft-1' });

    expect(output.sessionId).toBe(harness.sessionId);
    const resolution = output.resolution;
    expect(resolution.source).toBe('AI');
    expect(resolution.aiResponseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(resolution.baseVersion).toBe(stateBefore.version);
    expect(resolution.resolutionHash).toBeNull(); // считает владелец записи (1.8)
    expect(resolution.editedAt).toBeNull();
    expect(resolution.visualScene).not.toBeNull();

    expect(resolution.segments.length).toBeGreaterThanOrEqual(1);
    for (const segment of resolution.segments) {
      expect(segment.status).toBe('PROPOSED');
      expect(segment.audience).toEqual({ kind: 'ALL' });
      expect(segment.text.length).toBeLessThanOrEqual(2000);
    }
    // связь со входом: 2 действия — число из фикстурного маркера {actionCount}
    expect(resolution.segments.map((segment) => segment.text).join(' ')).toContain('2');

    expect(resolution.privateMessages).toHaveLength(6);
    const memberIds = new Set<string>([...harness.playerIds, harness.gmPlayerId]);
    for (const message of resolution.privateMessages) {
      expect(message.status).toBe('PROPOSED');
      expect(memberIds.has(message.playerId)).toBe(true); // remap на реальных игроков
    }

    expect(resolution.proposedEvents).toEqual([]); // remap: событий нет
    expect(resolution.proposedObjectChanges).toHaveLength(1);
    expect(resolution.proposedObjectChanges[0]).toMatchObject({
      objectId: PANEL_OBJECT_ID,
      status: 'PROPOSED',
      ruleResults: [],
      gmComment: null,
    });
    expect(resolution.proposedWorldStatePatch).toEqual({});

    expect(resolution.diagnostics).toMatchObject({
      providerId: 'scripted',
      model: SCRIPTED_MODEL,
      attempts: 1,
      schemaRepairAttempts: 0,
      costUsd: null, // этап 2 (UNKNOWN#5)
      requiresGM: false,
    });
    expect(resolution.diagnostics.usage?.model).toBe(SCRIPTED_MODEL);
    expect(resolution.diagnostics.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('AI_DRAFT_PROPOSED: proposalHash === aiResponseHash черновика', async () => {
    const proposed = harness.events.filter((entry) => entry.type === 'AI_DRAFT_PROPOSED');
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.payload).toMatchObject({
      sessionId: harness.sessionId,
      turnId: harness.turnId,
    });
    const output = await director.getDraft({ turnId: harness.turnId });
    expect(proposed[0]!.payload['proposalHash']).toBe(output.resolution?.aiResponseHash);
  });

  it('ai_decisions: запись OK с promptHash, responseJson и latencyMs', async () => {
    const decisions = await harness.db.boot.uow.repos().aiDecisions.listByTurn(harness.turnId);
    expect(decisions).toHaveLength(1);
    const decision = decisions[0]!;
    expect(decision.status).toBe('OK');
    expect(decision.providerId).toBe('scripted');
    expect(decision.model).toBe(SCRIPTED_MODEL);
    expect(decision.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(decision.violationsCount).toBe(0);
    expect(decision.latencyMs).toBeGreaterThanOrEqual(0);
    expect(decision.errorCode).toBeNull();
    expect(decision.traceId).toBe('trace-draft-1');
    expect(AIResponseSchema.safeParse(JSON.parse(decision.responseJson!)).success).toBe(true);
  });

  it('метрики: ai.duration_ms учитывается MetricsSink', () => {
    const timings = harness.metrics.snapshot().timings;
    expect(timings['ai.duration_ms{providerId=scripted}']).toBeDefined();
  });

  it('getDraft: MEMORY с контекстом; после сохранения в turn — TURN_RECORD; неизвестный ход — not found', async () => {
    const fromMemory = await director.getDraft({ turnId: harness.turnId });
    expect(fromMemory.found).toBe(true);
    expect(fromMemory.source).toBe('MEMORY');
    expect(fromMemory.context?.turnId).toBe(harness.turnId);
    expect(fromMemory.resolution?.source).toBe('AI');

    // Имитация сохранения черновика turn engine'ом (промпт 1.8): новый сервис
    // без памяти процесса читает resolution из записи хода.
    const turn = await harness.services.turns.getTurn(harness.turnId);
    await harness.db.boot.uow.repos().turns.update({ ...turn, resolution: fromMemory.resolution });
    const noRegistry: AIProviderRegistry = {
      resolve: async () => [],
      withPolicy: async <T>(_providerId: string, _fn: unknown): Promise<T> => {
        throw new Error('не должно вызываться');
      },
    };
    const fresh = new AiDirectorService({
      uow: harness.db.boot.uow,
      registry: noRegistry,
      bus: harness.bus,
      directorInstructions: INSTRUCTIONS,
    });
    const fromRecord = await fresh.getDraft({ turnId: harness.turnId });
    expect(fromRecord.found).toBe(true);
    expect(fromRecord.source).toBe('TURN_RECORD');
    expect(fromRecord.context).toBeNull();
    expect(fromRecord.resolution?.aiResponseHash).toBe(fromMemory.resolution?.aiResponseHash);

    const missing = await director.getDraft({ turnId: randomUUID() as TurnId });
    expect(missing).toMatchObject({ found: false, resolution: null, context: null, source: null });
  });

  it('невалидный вход команды → ошибка валидации (Zod на границе, F-8.1)', async () => {
    await expect(director.generateDraft({ turnId: 'не-uuid' as TurnId, traceId: 'x' })).rejects.toThrowError();
  });
});

describe('generateDraft — деградации: repair, fallback, исчерпание цепочки', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await setupWorld('ai-draft-degrade');
  });

  afterAll(async () => {
    await harness?.db.close();
  });

  it('PROVIDER_SCHEMA → repair ровно один раз: второй вызов с указанием нарушения — успех', async () => {
    const flaky = new FlakySchemaProvider('flaky');
    const { director } = makeDirector(harness, {
      chain: ['flaky'],
      providers: [{ id: 'flaky', port: flaky }],
    });
    const output = await director.generateDraft({ turnId: harness.turnId, traceId: 'trace-repair' });

    expect(flaky.calls).toHaveLength(2); // исходный вызов + ОДИН repair
    expect(output.resolution.diagnostics.schemaRepairAttempts).toBe(1);
    expect(output.resolution.diagnostics.providerId).toBe('flaky');
    // repair-вызов получил дополненные directorInstructions с текстом ошибки
    expect(flaky.calls[1]!.context.directorInstructions).toContain(INSTRUCTIONS);
    expect(flaky.calls[1]!.context.directorInstructions).toContain('нарушил выходную схему');
    expect(harness.metrics.counterOf('ai.schema_errors_total', { providerId: 'flaky' })).toBe(1);
  });

  it('всегда невалидный ответ: вызовов ровно 2, AI_GENERATION_FAILED{PROVIDER_SCHEMA}, throw PROVIDER_UNAVAILABLE', async () => {
    // ход предыдущего теста остаётся в PROCESSING — используем его же
    const bad = new AlwaysBadSchemaProvider('always-bad');
    const { director } = makeDirector(harness, {
      chain: ['always-bad'],
      providers: [{ id: 'always-bad', port: bad }],
    });

    const error = await director
      .generateDraft({ turnId: harness.turnId, traceId: 'trace-bad' })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe('PROVIDER_UNAVAILABLE');

    expect(bad.calls).toHaveLength(2); // исходный + один repair — и всё
    const failed = harness.events.filter((entry) => entry.type === 'AI_GENERATION_FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({
      sessionId: harness.sessionId,
      turnId: harness.turnId,
      errorCode: 'PROVIDER_SCHEMA',
      providerId: 'always-bad',
    });

    const decisions = await harness.db.boot.uow.repos().aiDecisions.listByTurn(harness.turnId);
    const badDecision = decisions.find((decision) => decision.providerId === 'always-bad');
    expect(badDecision?.status).toBe('FAILED');
    expect(badDecision?.errorCode).toBe('PROVIDER_SCHEMA');
  });

  it('fallback scripted→echo при unavailable у scripted (A1.12 на уровне сервисов)', async () => {
    // новый ход: предыдущий в PROCESSING — доводим до FAILED и открываем следующий
    await harness.services.turns.transition({
      turnId: harness.turnId,
      trigger: 'processingFailed',
      failed: { code: 'PROVIDER_SCHEMA', message: 'тест деградации' },
    });
    const opened = await harness.services.turns.openTurn({
      sessionId: harness.sessionId,
      idempotencyKey: testKey('open-2'),
    });
    const turn2 = opened.turnId;
    await harness.services.turns.submitAction({
      turnId: turn2,
      playerId: harness.playerIds[0]!,
      rawText: 'Толкаю внутреннюю дверь',
      idempotencyKey: testKey('act-2'),
    });
    await harness.services.turns.lockTurn({ turnId: turn2, idempotencyKey: testKey('lock-2') });
    await harness.services.turns.transition({ turnId: turn2, trigger: 'startProcessing' });

    const { director } = makeDirector(harness, {
      chain: ['scripted-down', 'echo'],
      providers: [
        { id: 'scripted-down', port: new FailingAI({ mode: 'unavailable', providerId: 'scripted-down' }) },
        { id: 'echo', port: new EchoAI() },
      ],
    });
    const output = await director.generateDraft({ turnId: turn2, traceId: 'trace-fallback' });
    expect(output.resolution.diagnostics.providerId).toBe('echo');
    expect(output.resolution.diagnostics.attempts).toBe(1);
    // нарратив echo содержит текст действия
    expect(output.resolution.segments.map((segment) => segment.text).join(' ')).toContain('Толкаю внутреннюю дверь');
  });

  it('ошибка rate_limit у первого провайдера → fallback на echo, в журнале обе попытки', async () => {
    // предыдущий тест оставил turn2 в PROCESSING (черновик сгенерирован, статус не менялся)
    const latest = await harness.services.turns.listTurns(harness.sessionId, 10);
    const turn2 = latest.find((turn) => turn.status === 'PROCESSING');
    expect(turn2, 'ход в PROCESSING должен существовать').toBeDefined();

    const { director } = makeDirector(harness, {
      chain: ['limited', 'echo'],
      providers: [
        { id: 'limited', port: new FailingAI({ mode: 'rate_limit', providerId: 'limited' }) },
        { id: 'echo', port: new EchoAI() },
      ],
    });
    const output = await director.generateDraft({ turnId: turn2!.turnId, traceId: 'trace-ratelimit' });
    expect(output.resolution.diagnostics.providerId).toBe('echo');
    expect(output.resolution.diagnostics.attempts).toBe(2); // провал limited + успех echo

    // turn2 использовался и предыдущим fallback-тестом — берём только записи своего вызова
    const decisions = (await harness.db.boot.uow.repos().aiDecisions.listByTurn(turn2!.turnId)).filter(
      (decision) => decision.traceId === 'trace-ratelimit',
    );
    expect(decisions.map((decision) => decision.providerId).sort()).toEqual(['echo', 'limited']);
    expect(decisions.find((decision) => decision.providerId === 'limited')?.status).toBe('FAILED');
    expect(decisions.find((decision) => decision.providerId === 'limited')?.errorCode).toBe('PROVIDER_RATE_LIMIT');
  });

  it('timeout-стенд: AI_GENERATION_FAILED{PROVIDER_TIMEOUT}, throw PROVIDER_UNAVAILABLE, запись TIMEOUT', async () => {
    const latest = await harness.services.turns.listTurns(harness.sessionId, 10);
    const turn2 = latest.find((turn) => turn.status === 'PROCESSING')!;
    // новый ход для сценария
    await harness.services.turns.transition({
      turnId: turn2.turnId,
      trigger: 'processingFailed',
      failed: { code: 'PROVIDER_RATE_LIMIT', message: 'предыдущий сценарий' },
    });
    const opened = await harness.services.turns.openTurn({
      sessionId: harness.sessionId,
      idempotencyKey: testKey('open-3'),
    });
    const turn3 = opened.turnId;
    await harness.services.turns.lockTurn({ turnId: turn3, idempotencyKey: testKey('lock-3') });
    await harness.services.turns.transition({ turnId: turn3, trigger: 'startProcessing' });

    harness.events.length = 0;
    const { director, registry } = makeDirector(harness, {
      chain: ['failing'],
      providers: [
        {
          id: 'failing',
          port: new FailingAI({ mode: 'timeout', providerId: 'failing' }),
          policy: { timeoutMs: 60, circuitBreaker: { failureThreshold: 5, cooldownMs: 60_000 } },
        },
      ],
    });

    const error = await director
      .generateDraft({ turnId: turn3, traceId: 'trace-timeout' })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe('PROVIDER_UNAVAILABLE');

    const failed = harness.events.filter((entry) => entry.type === 'AI_GENERATION_FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ turnId: turn3, errorCode: 'PROVIDER_TIMEOUT', providerId: 'failing' });

    const decisions = await harness.db.boot.uow.repos().aiDecisions.listByTurn(turn3);
    expect(decisions[0]?.status).toBe('TIMEOUT');

    // breaker учёл провал; путь 1.8: turn engine переведёт ход в FAILED с кодом провайдера
    expect(registry.snapshot().providers[0]?.failures).toBe(1);
    const transitioned = await harness.services.turns.transition({
      turnId: turn3,
      trigger: 'processingFailed',
      failed: { code: 'PROVIDER_TIMEOUT', message: 'провайдер не ответил вовремя' },
    });
    expect(transitioned.status).toBe('FAILED');
    const failedTurn = await harness.services.turns.getTurn(turn3);
    expect(failedTurn.failed?.code).toBe('PROVIDER_TIMEOUT');
  });

  it('пустая цепочка (все провайдеры недоступны) → PROVIDER_UNAVAILABLE без вызовов generate', async () => {
    const latest = await harness.services.turns.listTurns(harness.sessionId, 10);
    const openTurnRecord = latest.find((turn) => turn.status === 'FAILED');
    expect(openTurnRecord).toBeDefined();
    await harness.services.turns.openTurn({ sessionId: harness.sessionId, idempotencyKey: testKey('open-4') });
    const newest = await harness.services.turns.listTurns(harness.sessionId, 10);
    const turn4 = newest.find((turn) => turn.status === 'OPEN')!;
    await harness.services.turns.lockTurn({ turnId: turn4.turnId, idempotencyKey: testKey('lock-4') });
    await harness.services.turns.transition({ turnId: turn4.turnId, trigger: 'startProcessing' });

    const down = new FailingAI({ mode: 'unavailable', providerId: 'down' });
    harness.events.length = 0;
    const { director } = makeDirector(harness, {
      chain: ['down'],
      providers: [{ id: 'down', port: down }],
    });
    const error = await director
      .generateDraft({ turnId: turn4.turnId, traceId: 'trace-empty' })
      .catch((cause: unknown) => cause);
    expect((error as ProviderError).code).toBe('PROVIDER_UNAVAILABLE');
    const failed = harness.events.filter((entry) => entry.type === 'AI_GENERATION_FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ errorCode: 'PROVIDER_UNAVAILABLE', providerId: null });
  });
});
