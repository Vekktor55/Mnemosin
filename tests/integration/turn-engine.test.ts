import { randomUUID } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import {
  FlagKey,
  ProviderError,
  TurnResolutionSchema,
  type ObjectId,
  type PlayerId,
  type RuleResult,
  type RuleSubject,
  type SessionId,
  type TurnId,
  type TurnResolution,
} from '@mnemosin/contracts';
import {
  InMemoryMetricsSink,
  InProcessEventBus,
  resolutionHashOf,
  type AIPort,
  type CoreServices,
  type RulesEvaluationContext,
  type RulesPort,
} from '@mnemosin/core';
import { CapabilityRegistry, FailingAI, ScriptedAI, type RegistrySnapshot } from '@mnemosin/ai';
import { AiDirectorService } from '@mnemosin/module-ai-director';
import { GmReviewService } from '@mnemosin/module-gm-review';
import { TurnEngine, rulesStub, type DraftGeneratorPort } from '@mnemosin/module-turn';

import {
  bootLobby,
  buildTestServices,
  errorCodeOf,
  openTempDb,
  outboxEvents,
  testKey,
  type TempDb,
} from './helpers.js';

/**
 * Turn Engine (промпт 1.8, критерии A1.6/A1.8; закрывает B-09, F-3.1, F-3.2).
 *
 * Проверяются: полный цикл OPEN→LOCKED→PROCESSING→REVIEW→COMMITTED cо scripted-
 * провайдером; идемпотентность resolve/commit (B-08.4); optimistic lock
 * (VERSION_CONFLICT); rules-ветки (REJECT/SOFT_REJECT/WARN, D116-интерфейс);
 * деградация провайдера → FAILED{PROVIDER_TIMEOUT} → retryTurn (D118);
 * retry из REVIEW → OPEN с очисткой черновика; applyResolution применяет
 * ТОЛЬКО APPROVED/EDITED item'ы; D117 — следующий ход автоматически НЕ открывается.
 */

const ROOT = process.cwd();
const FIXTURE_PATH = resolvePath(ROOT, 'tools/fixtures/resolution.ok.json');
const PANEL_OBJECT_ID = '504a3329-490b-4d6d-85f7-752f2a69a605' as ObjectId;

interface World {
  readonly db: TempDb;
  readonly services: CoreServices;
  readonly bus: InProcessEventBus;
  readonly metrics: InMemoryMetricsSink;
  readonly engine: TurnEngine;
  readonly gmReview: GmReviewService;
  readonly registry: CapabilityRegistry;
  readonly sessionId: SessionId;
  readonly gmPlayerId: PlayerId;
  readonly playerIds: PlayerId[];
  readonly turnId: TurnId;
  close(): Promise<void>;
}

interface WorldOptions {
  readonly providerId?: string;
  readonly provider?: { providerId: string; port: AIPort };
  readonly policy?: Record<string, unknown>;
  readonly rules?: RulesPort;
  readonly aiDirector?: DraftGeneratorPort;
  readonly actions?: number;
}

async function bootWorld(label: string, options: WorldOptions = {}): Promise<World> {
  const db = await openTempDb(label, { seed: false });
  const services = buildTestServices(db);
  const lobby = await bootLobby(services, { players: 3 });
  const turnId = lobby.turnId!;
  for (let i = 0; i < (options.actions ?? 2); i++) {
    await services.turns.submitAction({
      turnId,
      playerId: lobby.playerIds[i % lobby.playerIds.length]!,
      rawText: i === 0 ? 'Осматриваюсь в шлюзе' : 'Слушаю гул вентиляции',
      idempotencyKey: testKey('act'),
    });
  }
  await services.turns.lockTurn({ turnId, idempotencyKey: testKey('lock') });

  const bus = new InProcessEventBus();
  const metrics = new InMemoryMetricsSink();
  const providerId = options.provider?.providerId ?? options.providerId ?? 'scripted';
  const registry = new CapabilityRegistry({
    chains: { TEXT_AI: { required: true, chain: [providerId] } },
    policies: [
      {
        providerId,
        capability: 'TEXT_AI',
        timeoutMs: 2_000,
        retries: { max: 0, backoffMs: 10, jitter: false },
        circuitBreaker: { failureThreshold: 3, cooldownMs: 60_000 },
        costPer1kTokens: { input: null, output: null },
        ...options.policy,
      },
    ],
    bus,
    metrics,
  });
  if (options.provider !== undefined) {
    registry.register({
      capability: 'TEXT_AI',
      providerId: options.provider.providerId,
      provider: options.provider.port,
    });
  } else if (options.aiDirector === undefined) {
    registry.register({
      capability: 'TEXT_AI',
      providerId: 'scripted',
      provider: new ScriptedAI({ fixturePath: FIXTURE_PATH }),
    });
  }

  const aiDirector: DraftGeneratorPort =
    options.aiDirector ??
    new AiDirectorService({
      uow: db.boot.uow,
      registry,
      bus,
      metrics,
      directorInstructions: 'Тестовые указания.',
    });

  const engine = new TurnEngine({
    uow: db.boot.uow,
    guard: db.boot.idempotency,
    services: { turns: services.turns, state: services.state, journal: services.journal },
    aiDirector,
    rules: options.rules ?? rulesStub,
    limits: { aiMutableObjectKeys: ['*'] },
    metrics,
  });
  const gmReview = new GmReviewService({
    uow: db.boot.uow,
    guard: db.boot.idempotency,
    journal: services.journal,
    turnEngine: engine,
  });

  return {
    db,
    services,
    bus,
    metrics,
    engine,
    gmReview,
    registry,
    sessionId: lobby.sessionId,
    gmPlayerId: lobby.gmPlayerId,
    playerIds: lobby.playerIds,
    turnId,
    async close() {
      await db.close();
    },
  };
}

async function journalKinds(world: World, turnId: TurnId): Promise<string[]> {
  return (await world.services.journal.list(turnId)).map((entry) => entry.kind);
}

async function eventNames(world: World): Promise<string[]> {
  return (await outboxEvents(world.db)).map((entry) => entry.eventName);
}

// ---------------------------------------------------------------------------

describe('resolveTurn → REVIEW (v3 §III.1; B-08/B-09)', () => {
  const worlds: World[] = [];
  afterAll(async () => {
    for (const world of worlds) await world.close();
  });

  it('LOCKED → PROCESSING → REVIEW: журнал, outbox, черновик с resolutionHash и baseVersion', async () => {
    const world = await bootWorld('turn-resolve-ok');
    worlds.push(world);

    const stateBefore = await world.services.state.get(world.sessionId);
    const output = await world.engine.resolveTurn({ turnId: world.turnId, traceId: 'trace-resolve' });

    expect(output.status).toBe('REVIEW');
    expect(output.replayed).toBe(false);
    expect(output.resolutionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(output.requiresGM).toBe(false);

    const turn = await world.services.turns.getTurn(world.turnId);
    expect(turn.status).toBe('REVIEW');
    expect(turn.reviewReadyAt).not.toBeNull();
    expect(turn.resolution).not.toBeNull();
    expect(turn.resolution?.source).toBe('AI');
    expect(turn.resolution?.baseVersion).toBe(stateBefore.version);
    expect(turn.resolution?.resolutionHash).toBe(output.resolutionHash);
    // все item'ы черновика PROPOSED (решение — за GM)
    expect(turn.resolution?.proposedObjectChanges.every((change) => change.status === 'PROPOSED')).toBe(true);

    const kinds = await journalKinds(world, world.turnId);
    for (const expected of [
      'turn_opened',
      'turn_locked',
      'processing_started',
      'ai_call_started',
      'ai_call_finished',
      'rules_evaluated',
      'draft_ready',
    ]) {
      expect(kinds, `журнал обязан содержать ${expected}`).toContain(expected);
    }

    const events = await eventNames(world);
    expect(events).toContain('TURN_PROCESSING_STARTED');
    expect(events).toContain('TURN_DRAFT_READY');
    expect(events).toContain('AI_DRAFT_PROPOSED');
    expect(events).not.toContain('TURN_COMMITTED');

    // resolveTurn НЕ применяет состояние и НЕ коммитит (v3 §III.1)
    const stateAfter = await world.services.state.get(world.sessionId);
    expect(stateAfter.version).toBe(stateBefore.version);
    expect(world.metrics.snapshot().timings['turn.duration_ms{outcome=review}']).toBeDefined();
  });

  it('повтор resolveTurn с тем же ходом → replayed, без второй записи draft_ready (B-08.4)', async () => {
    const world = await bootWorld('turn-resolve-replay');
    worlds.push(world);
    const first = await world.engine.resolveTurn({ turnId: world.turnId, traceId: 'trace-r1' });
    const second = await world.engine.resolveTurn({ turnId: world.turnId, traceId: 'trace-r2' });
    expect(second.replayed).toBe(true);
    expect(second).toMatchObject({ status: 'REVIEW', resolutionHash: first.resolutionHash });
    const kinds = await journalKinds(world, world.turnId);
    expect(kinds.filter((kind) => kind === 'draft_ready')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'processing_started')).toHaveLength(1);
  });

  it('resolveTurn не из LOCKED → CORE_INVALID_STATE_TRANSITION', async () => {
    const world = await bootWorld('turn-resolve-status');
    worlds.push(world);
    // возвращаем ход в OPEN (unlockTurn из 1.6)
    await world.services.turns.unlockTurn({ turnId: world.turnId, idempotencyKey: testKey('unlock') });
    const code = await errorCodeOf(() => world.engine.resolveTurn({ turnId: world.turnId }));
    expect(code).toBe('CORE_INVALID_STATE_TRANSITION');
    const turn = await world.services.turns.getTurn(world.turnId);
    expect(turn.status).toBe('OPEN'); // статус не сдвинулся
  });
});

describe('commitTurn → COMMITTED (v3 §III.2; A1.6, F-3.2)', () => {
  const worlds: World[] = [];
  afterAll(async () => {
    for (const world of worlds) await world.close();
  });

  it('полный цикл OPEN→…→COMMITTED: approve применяет черновик, версия +1, события и журнал', async () => {
    const world = await bootWorld('turn-commit-cycle');
    worlds.push(world);

    const stateBefore = await world.services.state.get(world.sessionId);
    await world.engine.resolveTurn({ turnId: world.turnId });
    const committed = await world.gmReview.approve({
      turnId: world.turnId,
      gmPlayerId: world.gmPlayerId,
      idempotencyKey: testKey('approve'),
    });

    expect(committed.version).toBe(stateBefore.version + 1);
    const turn = await world.services.turns.getTurn(world.turnId);
    expect(turn.status).toBe('COMMITTED');
    expect(turn.committedAt).not.toBeNull();

    // objectChange из фикстуры применён (статусы APPROVED→APPLIED)
    const stateAfter = await world.services.state.get(world.sessionId);
    expect(stateAfter.objectStates[PANEL_OBJECT_ID]?.state['cycleLight']).toBe('red_to_amber');
    expect(turn.resolution?.proposedObjectChanges[0]?.status).toBe('APPLIED');
    expect(turn.resolution?.segments.every((segment) => segment.status === 'APPLIED')).toBe(true);

    const events = await eventNames(world);
    expect(events).toContain('GM_REVIEW_DECIDED');
    expect(events).toContain('TURN_COMMITTED');
    expect(events).toContain('STATE_COMMITTED'); // единственный эмитент — StateService.apply
    expect(events.filter((name) => name === 'STATE_COMMITTED')).toHaveLength(1);

    const kinds = await journalKinds(world, world.turnId);
    expect(kinds).toContain('gm_decision');
    expect(kinds).toContain('state_applied');
    expect(kinds).toContain('committed');

    // D117: следующий ход автоматически НЕ открывается
    const turns = await world.services.turns.listTurns(world.sessionId);
    expect(turns).toHaveLength(1);
    const session = await world.services.sessions.getSession(world.sessionId);
    expect(session.currentTurnId).toBe(world.turnId);
  });

  it('повторный commit с тем же ключом → тот же {version}, без второй записи в journal (тест A1.4)', async () => {
    const world = await bootWorld('turn-commit-twice');
    worlds.push(world);
    await world.engine.resolveTurn({ turnId: world.turnId });
    const key = testKey('approve-twice');
    const first = await world.gmReview.approve({
      turnId: world.turnId,
      gmPlayerId: world.gmPlayerId,
      idempotencyKey: key,
    });
    const second = await world.gmReview.approve({
      turnId: world.turnId,
      gmPlayerId: world.gmPlayerId,
      idempotencyKey: key,
    });
    expect(second.version).toBe(first.version);
    expect(second.replayed).toBe(true);
    const kinds = await journalKinds(world, world.turnId);
    expect(kinds.filter((kind) => kind === 'committed')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'gm_decision')).toHaveLength(1);
    const events = await eventNames(world);
    expect(events.filter((name) => name === 'TURN_COMMITTED')).toHaveLength(1);
  });

  it('состояние ушло вперёд → VERSION_CONFLICT c expectedVersion/actualVersion', async () => {
    const world = await bootWorld('turn-commit-conflict');
    worlds.push(world);
    await world.engine.resolveTurn({ turnId: world.turnId });

    // Внешняя мутация между draftReady и commit (например, GM-флаг через story в 1.9)
    const state = await world.services.state.get(world.sessionId);
    await world.services.state.apply({
      sessionId: world.sessionId,
      mutations: [{ kind: 'SET_FLAG', key: FlagKey.parse('external_change'), value: true, setBy: 'GM' }],
      expectedVersion: state.version,
      turnId: null,
      traceId: 'trace-external',
    });

    const error = await world.engine
      .commitTurn({ turnId: world.turnId, idempotencyKey: testKey('commit-stale') })
      .catch((cause: unknown) => cause);
    expect((error as { code?: string }).code).toBe('VERSION_CONFLICT');
    expect((error as { meta?: Record<string, unknown> }).meta).toMatchObject({
      expectedVersion: state.version,
      actualVersion: state.version + 1,
    });
    const turn = await world.services.turns.getTurn(world.turnId);
    expect(turn.status).toBe('REVIEW'); // не закоммичен
  });

  it('applyResolution применяет ТОЛЬКО APPROVED/EDITED item’ы (PROPOSED → SKIPPED)', async () => {
    // Черновик со смешанными статусами — через подставной DraftGenerator.
    // Идентификаторы партии неизвестны до bootWorld — черновик кладётся в holder
    // после создания мира, generateDraft читает его в момент вызова.
    const holder: { draft: TurnResolution | null } = { draft: null };
    const fakeDirector: DraftGeneratorPort = {
      generateDraft: async ({ turnId }) => {
        const draft = holder.draft;
        if (draft === null) throw new Error('черновик не подготовлен');
        return {
          turnId: draft.turnId === turnId ? turnId : draft.turnId,
          sessionId: draft.sessionId,
          resolution: draft,
        };
      },
    };
    const world = await bootWorld('turn-commit-statuses', { aiDirector: fakeDirector });
    worlds.push(world);
    const otherObjectId = randomUUID() as ObjectId;

    holder.draft = TurnResolutionSchema.parse({
      turnId: world.turnId,
      sessionId: world.sessionId,
      source: 'AI',
      aiResponseHash: 'b'.repeat(64),
      baseVersion: (await world.services.state.get(world.sessionId)).version,
      resolutionHash: null,
      segments: [],
      privateMessages: [],
      proposedEvents: [],
      proposedObjectChanges: [
        {
          objectId: PANEL_OBJECT_ID,
          patch: { applied: 'yes' },
          rationale: 'одобрено GM',
          status: 'APPROVED',
          ruleResults: [],
          gmComment: null,
        },
        {
          objectId: otherObjectId,
          patch: { applied: 'no' },
          rationale: 'без решения',
          status: 'PROPOSED',
          ruleResults: [],
          gmComment: null,
        },
      ],
      proposedWorldStatePatch: {},
      visualScene: null,
      diagnostics: { providerId: 'fake', model: null, attempts: 1, usage: null, costUsd: null, durationMs: 1 },
      createdAt: '2026-10-14T00:00:00.000Z',
      editedAt: null,
    });

    await world.engine.resolveTurn({ turnId: world.turnId });
    // commit БЕЗ gmDecision: PROPOSED не одобрен → не применяется
    const committed = await world.engine.commitTurn({ turnId: world.turnId, idempotencyKey: testKey('commit-raw') });
    expect(committed.version).toBeGreaterThan(0);

    const turn = await world.services.turns.getTurn(world.turnId);
    const byObject = new Map(turn.resolution!.proposedObjectChanges.map((change) => [change.objectId, change.status]));
    expect(byObject.get(PANEL_OBJECT_ID)).toBe('APPLIED');
    expect(byObject.get(otherObjectId)).toBe('SKIPPED');

    const state = await world.services.state.get(world.sessionId);
    expect(state.objectStates[PANEL_OBJECT_ID]?.state['applied']).toBe('yes');
    expect(state.objectStates[otherObjectId]?.state['applied']).toBeUndefined();
  });

  it('commit не из REVIEW → CORE_INVALID_STATE_TRANSITION', async () => {
    const world = await bootWorld('turn-commit-status');
    worlds.push(world);
    const code = await errorCodeOf(() =>
      world.engine.commitTurn({ turnId: world.turnId, idempotencyKey: testKey('commit-open') }),
    );
    expect(code).toBe('CORE_INVALID_STATE_TRANSITION');
  });
});

describe('RulesPort (D116: интерфейс полный, rulesStub → PASS)', () => {
  const worlds: World[] = [];
  afterAll(async () => {
    for (const world of worlds) await world.close();
  });

  const ruleResult = (outcome: RuleResult['outcome'], checkId: string): RuleResult => ({
    checkId,
    passed: outcome === 'PASS',
    outcome,
    message: `${checkId}: ${outcome}`,
    requiresGM: outcome === 'SOFT_REJECT',
  });

  it('REJECT → FAILED + TURN_FAILED{CORE_RULE_REJECTED}; повтор resolve → failed_before (D201)', async () => {
    const rejecting: RulesPort = {
      async evaluate(subject: RuleSubject): Promise<RuleResult[]> {
        return subject.kind === 'OBJECT_CHANGE' ? [ruleResult('REJECT', 'no-panel-changes')] : [];
      },
    };
    const world = await bootWorld('turn-rules-reject', { rules: rejecting });
    worlds.push(world);

    const code = await errorCodeOf(() => world.engine.resolveTurn({ turnId: world.turnId, traceId: 'trace-reject' }));
    expect(code).toBe('CORE_RULE_REJECTED');

    const turn = await world.services.turns.getTurn(world.turnId);
    expect(turn.status).toBe('FAILED');
    expect(turn.failed?.code).toBe('CORE_RULE_REJECTED');

    const events = await outboxEvents(world.db);
    const failed = events.filter((entry) => entry.eventName === 'TURN_FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ errorCode: 'CORE_RULE_REJECTED', turnId: world.turnId });
    expect(await journalKinds(world, world.turnId)).toContain('failed');

    // Перманентный отказ зафиксирован: повтор с тем же (детерминированным) ключом
    // НЕ выполняет команду заново — failed_before с прежним кодом (D201).
    const second = await errorCodeOf(() =>
      world.engine.resolveTurn({ turnId: world.turnId, traceId: 'trace-reject-2' }),
    );
    expect(second).toBe('CORE_RULE_REJECTED');
    expect((await outboxEvents(world.db)).filter((entry) => entry.eventName === 'TURN_FAILED')).toHaveLength(1);
  });

  it('SOFT_REJECT/WARN → ход в REVIEW c requiresGM=true и diagnostics (п.7)', async () => {
    const soft: RulesPort = {
      async evaluate(subject: RuleSubject, _ctx: RulesEvaluationContext): Promise<RuleResult[]> {
        if (subject.kind === 'ACTION') return [ruleResult('SOFT_REJECT', 'action-needs-gm')];
        if (subject.kind === 'OBJECT_CHANGE') return [ruleResult('WARN', 'object-careful')];
        return [];
      },
    };
    const world = await bootWorld('turn-rules-soft', { rules: soft });
    worlds.push(world);

    const output = await world.engine.resolveTurn({ turnId: world.turnId });
    expect(output.status).toBe('REVIEW');
    expect(output.requiresGM).toBe(true);

    const turn = await world.services.turns.getTurn(world.turnId);
    const diagnostics = turn.resolution!.diagnostics;
    expect(diagnostics.requiresGM).toBe(true);
    expect(diagnostics.softRejects.map((r) => r.checkId)).toContain('action-needs-gm');
    expect(diagnostics.warnings.map((r) => r.checkId)).toContain('object-careful');
    // ruleResults прикреплены к item'у
    expect(turn.resolution!.proposedObjectChanges[0]?.ruleResults.map((r) => r.checkId)).toContain('object-careful');
  });
});

describe('Деградации провайдера и retry (п.9; D118)', () => {
  const worlds: World[] = [];
  afterAll(async () => {
    for (const world of worlds) await world.close();
  });

  it('FailingAI(timeout) → FAILED + TURN_FAILED{PROVIDER_TIMEOUT} + journal ai_call_failed; retry создаёт НОВЫЙ ход', async () => {
    const world = await bootWorld('turn-failing', {
      provider: { providerId: 'failing', port: new FailingAI({ mode: 'timeout', providerId: 'failing' }) },
      policy: { timeoutMs: 60, circuitBreaker: { failureThreshold: 5, cooldownMs: 60_000 } },
    });
    worlds.push(world);

    const error = await world.engine
      .resolveTurn({ turnId: world.turnId, traceId: 'trace-fail' })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe('PROVIDER_UNAVAILABLE');

    const turn = await world.services.turns.getTurn(world.turnId);
    expect(turn.status).toBe('FAILED');
    expect(turn.failed?.code).toBe('PROVIDER_TIMEOUT');

    const events = await outboxEvents(world.db);
    expect(events.filter((entry) => entry.eventName === 'TURN_FAILED')[0]!.payload).toMatchObject({
      errorCode: 'PROVIDER_TIMEOUT',
    });
    expect(events.some((entry) => entry.eventName === 'AI_GENERATION_FAILED')).toBe(false); // AI_GENERATION_FAILED — шина (1.7), не outbox
    expect(await journalKinds(world, world.turnId)).toContain('ai_call_failed');

    // retryTurn из FAILED → НОВЫЙ ход (номер+1), действия НЕ копируются (D118)
    const retried = await world.engine.retryTurn({
      turnId: world.turnId,
      idempotencyKey: testKey('retry-failed'),
      gmDecision: { gmPlayerId: world.gmPlayerId },
    });
    expect(retried.createdNewTurn).toBe(true);
    expect(retried.number).toBe(2);
    expect(retried.status).toBe('OPEN');
    expect(retried.turnId).not.toBe(world.turnId);

    const newActions = await world.db.boot.uow.repos().actions.listByTurn(retried.turnId);
    expect(newActions).toHaveLength(0);
    const oldActions = await world.db.boot.uow.repos().actions.listByTurn(world.turnId);
    expect(oldActions).toHaveLength(2);

    const session = await world.services.sessions.getSession(world.sessionId);
    expect(session.currentTurnId).toBe(retried.turnId);
    expect(await eventNames(world)).toContain('TURN_OPENED');
  });

  it('retry из REVIEW → OPEN, черновик очищен; повторный resolve генерирует ЗАНОВО (D235)', async () => {
    const world = await bootWorld('turn-retry-review');
    worlds.push(world);
    await world.engine.resolveTurn({ turnId: world.turnId });
    expect((await world.services.turns.getTurn(world.turnId)).resolution).not.toBeNull();

    const retried = await world.engine.retryTurn({ turnId: world.turnId, idempotencyKey: testKey('retry-review') });
    expect(retried.createdNewTurn).toBe(false);
    expect(retried.status).toBe('OPEN');
    const cleared = await world.services.turns.getTurn(world.turnId);
    expect(cleared.resolution).toBeNull();

    // повторный цикл: lock → resolve — кэш ключа `resolve:{turnId}` инвалидирован,
    // поэтому генерация выполняется заново (replayed=false, новый черновик сохранён)
    await world.services.turns.lockTurn({ turnId: world.turnId, idempotencyKey: testKey('relock') });
    const again = await world.engine.resolveTurn({ turnId: world.turnId });
    expect(again.replayed).toBe(false);
    expect(again.status).toBe('REVIEW');
    expect((await world.services.turns.getTurn(world.turnId)).resolution).not.toBeNull();
    const kinds = await journalKinds(world, world.turnId);
    expect(kinds.filter((kind) => kind === 'draft_ready')).toHaveLength(2);
  });

  it('пустая цепочка провайдеров → FAILED{PROVIDER_UNAVAILABLE} без AI-вызова', async () => {
    const world = await bootWorld('turn-no-providers', {
      provider: { providerId: 'down', port: new FailingAI({ mode: 'unavailable', providerId: 'down' }) },
      policy: { timeoutMs: 60 },
    });
    worlds.push(world);
    const code = await errorCodeOf(() => world.engine.resolveTurn({ turnId: world.turnId }));
    expect(code).toBe('PROVIDER_UNAVAILABLE');
    const turn = await world.services.turns.getTurn(world.turnId);
    expect(turn.status).toBe('FAILED');
    expect(turn.failed?.code).toBe('PROVIDER_UNAVAILABLE');
  });
});

describe('Согласованность хэша черновика (F-3.2)', () => {
  const worlds: World[] = [];
  afterAll(async () => {
    for (const world of worlds) await world.close();
  });

  it('resolutionHash = resolutionHashOf(resolution без поля hash) — ядро считает одинаково', async () => {
    const world = await bootWorld('turn-hash');
    worlds.push(world);
    const output = await world.engine.resolveTurn({ turnId: world.turnId });
    const turn = await world.services.turns.getTurn(world.turnId);
    const stored = turn.resolution!;
    expect(stored.resolutionHash).toBe(output.resolutionHash);
    expect(resolutionHashOf({ ...stored, resolutionHash: null })).toBe(output.resolutionHash);
    const snapshot: RegistrySnapshot = world.registry.snapshot();
    expect(snapshot.capabilities['TEXT_AI']?.available).toBe(true);
  });
});
