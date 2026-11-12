import { resolve as resolvePath } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { resolutionHashOf, InMemoryMetricsSink, InProcessEventBus, type CoreServices } from '@mnemosin/core';
import type { ObjectId, PlayerId, SessionId, TurnId, TurnResolution } from '@mnemosin/contracts';
import { CapabilityRegistry, ScriptedAI } from '@mnemosin/ai';
import { AiDirectorService } from '@mnemosin/module-ai-director';
import { GmReviewService } from '@mnemosin/module-gm-review';
import { TurnEngine, rulesStub } from '@mnemosin/module-turn';

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
 * gm-review (промпт 1.8, п.6; критерий A1.8 на сервисном слое; D119/F-8.6/B-09).
 *
 * Проверяются: approve → commitTurn (REVIEW→COMMITTED + GM_REVIEW_DECIDED),
 * editAndApprove — чужой baseResolutionHash → 409 VERSION_CONFLICT c актуальным
 * resolution в meta; совпадение → сохранение AI_THEN_GM_EDIT (все item'ы EDITED)
 * → approve; повтор с тем же ключом → тот же {version} (B-08.4); reject → FAILED +
 * TURN_FAILED; retry → REVIEW→OPEN + GM_REVIEW_DECIDED{RETRY_AI}; pendingReviews.
 */

const ROOT = process.cwd();
const FIXTURE_PATH = resolvePath(ROOT, 'tools/fixtures/resolution.ok.json');
const PANEL_OBJECT_ID = '504a3329-490b-4d6d-85f7-752f2a69a605' as ObjectId;

interface World {
  readonly db: TempDb;
  readonly services: CoreServices;
  readonly engine: TurnEngine;
  readonly gmReview: GmReviewService;
  readonly sessionId: SessionId;
  readonly gmPlayerId: PlayerId;
  readonly playerIds: PlayerId[];
  readonly turnId: TurnId;
  close(): Promise<void>;
}

async function bootWorld(label: string): Promise<World> {
  const db = await openTempDb(label, { seed: false });
  const services = buildTestServices(db);
  const lobby = await bootLobby(services, { players: 3 });
  const turnId = lobby.turnId!;
  await services.turns.submitAction({
    turnId,
    playerId: lobby.playerIds[0]!,
    rawText: 'Осматриваюсь в шлюзе',
    idempotencyKey: testKey('act'),
  });
  await services.turns.lockTurn({ turnId, idempotencyKey: testKey('lock') });

  const bus = new InProcessEventBus();
  const metrics = new InMemoryMetricsSink();
  const registry = new CapabilityRegistry({
    chains: { TEXT_AI: { required: true, chain: ['scripted'] } },
    policies: [
      {
        providerId: 'scripted',
        capability: 'TEXT_AI',
        timeoutMs: 2_000,
        retries: { max: 0, backoffMs: 10, jitter: false },
        circuitBreaker: { failureThreshold: 3, cooldownMs: 60_000 },
        costPer1kTokens: { input: null, output: null },
      },
    ],
    bus,
    metrics,
  });
  registry.register({
    capability: 'TEXT_AI',
    providerId: 'scripted',
    provider: new ScriptedAI({ fixturePath: FIXTURE_PATH }),
  });
  const director = new AiDirectorService({
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
    aiDirector: director,
    rules: rulesStub,
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
    engine,
    gmReview,
    sessionId: lobby.sessionId,
    gmPlayerId: lobby.gmPlayerId,
    playerIds: lobby.playerIds,
    turnId,
    async close() {
      await db.close();
    },
  };
}

async function resolvedWorld(label: string): Promise<World> {
  const world = await bootWorld(label);
  await world.engine.resolveTurn({ turnId: world.turnId, traceId: `trace-${label}` });
  return world;
}

async function eventNames(db: TempDb): Promise<string[]> {
  return (await outboxEvents(db)).map((entry) => entry.eventName);
}

async function eventsOf(db: TempDb, name: string): Promise<Array<Record<string, unknown>>> {
  return (await outboxEvents(db)).filter((entry) => entry.eventName === name).map((entry) => entry.payload);
}

describe('approve → turn.commitTurn (D119: gm-review владеет REVIEW→COMMITTED)', () => {
  const worlds: World[] = [];
  afterAll(async () => {
    for (const world of worlds) await world.close();
  });

  it('approve коммитит черновик и пишет GM_REVIEW_DECIDED{APPROVE}', async () => {
    const world = await resolvedWorld('gmr-approve');
    worlds.push(world);
    const stateBefore = await world.services.state.get(world.sessionId);

    const result = await world.gmReview.approve({
      turnId: world.turnId,
      gmPlayerId: world.gmPlayerId,
      idempotencyKey: testKey('approve'),
    });
    expect(result.version).toBe(stateBefore.version + 1);
    expect(result.replayed).toBe(false);

    const turn = await world.services.turns.getTurn(world.turnId);
    expect(turn.status).toBe('COMMITTED');
    expect(turn.resolution?.source).toBe('AI');

    const decided = await eventsOf(world.db, 'GM_REVIEW_DECIDED');
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ turnId: world.turnId, gmPlayerId: world.gmPlayerId, decision: 'APPROVE' });
    expect(await eventNames(world.db)).toContain('TURN_COMMITTED');
  });

  it('approve вне REVIEW → CORE_INVALID_STATE_TRANSITION', async () => {
    const world = await bootWorld('gmr-approve-status');
    worlds.push(world);
    const code = await errorCodeOf(() =>
      world.gmReview.approve({
        turnId: world.turnId,
        gmPlayerId: world.gmPlayerId,
        idempotencyKey: testKey('approve-l'),
      }),
    );
    expect(code).toBe('CORE_INVALID_STATE_TRANSITION');
  });
});

describe('editAndApprove (F-3.2, A1.8)', () => {
  const worlds: World[] = [];
  afterAll(async () => {
    for (const world of worlds) await world.close();
  });

  it('чужой baseResolutionHash → VERSION_CONFLICT c актуальным resolution в meta', async () => {
    const world = await resolvedWorld('gmr-edit-conflict');
    worlds.push(world);
    const turn = await world.services.turns.getTurn(world.turnId);
    const edited: TurnResolution = turn.resolution!;

    const error = await world.gmReview
      .editAndApprove({
        turnId: world.turnId,
        gmPlayerId: world.gmPlayerId,
        editedResolution: edited,
        baseResolutionHash: 'f'.repeat(64), // хэш чужой/устаревшей версии
        idempotencyKey: testKey('edit-bad'),
      })
      .catch((cause: unknown) => cause);

    expect((error as { code?: string }).code).toBe('VERSION_CONFLICT');
    const meta = (error as { meta?: Record<string, unknown> }).meta ?? {};
    expect(meta['actualHash']).toBe(turn.resolution!.resolutionHash);
    // актуальный черновик — в meta (клиент перечитывает и правит поверх него)
    expect((meta['resolution'] as TurnResolution | undefined)?.turnId).toBe(world.turnId);
    // ход не закоммичен и не изменён
    const after = await world.services.turns.getTurn(world.turnId);
    expect(after.status).toBe('REVIEW');
    expect(after.resolution?.resolutionHash).toBe(turn.resolution!.resolutionHash);
  });

  it('совпадение hash → правка сохраняется (AI_THEN_GM_EDIT, все EDITED) и коммитится; версия растёт', async () => {
    const world = await resolvedWorld('gmr-edit-ok');
    worlds.push(world);
    const turn = await world.services.turns.getTurn(world.turnId);
    const base = turn.resolution!;
    const baseHash = base.resolutionHash ?? resolutionHashOf(base);

    // GM правит: меняет patch панели и выкидывает приватные сообщения
    const edited: TurnResolution = {
      ...base,
      privateMessages: [],
      proposedObjectChanges: base.proposedObjectChanges.map((change) => ({
        ...change,
        patch: { cycleLight: 'green', gmEdited: true },
        gmComment: 'поправил ведущий',
      })),
    };

    const result = await world.gmReview.editAndApprove({
      turnId: world.turnId,
      gmPlayerId: world.gmPlayerId,
      editedResolution: edited,
      baseResolutionHash: baseHash,
      idempotencyKey: testKey('edit-ok'),
    });
    expect(result.version).toBe(base.baseVersion + 1);
    expect(result.resolutionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.resolutionHash).not.toBe(baseHash);

    const committed = await world.services.turns.getTurn(world.turnId);
    expect(committed.status).toBe('COMMITTED');
    expect(committed.resolution?.source).toBe('AI_THEN_GM_EDIT');
    expect(committed.resolution?.editedAt).not.toBeNull();
    expect(committed.resolution?.privateMessages).toEqual([]);
    expect(committed.resolution?.proposedObjectChanges[0]?.status).toBe('APPLIED');
    expect(committed.resolution?.proposedObjectChanges[0]?.gmComment).toBe('поправил ведущий');

    // правка GM реально применена к состоянию
    const state = await world.services.state.get(world.sessionId);
    expect(state.objectStates[PANEL_OBJECT_ID]?.state['cycleLight']).toBe('green');
    expect(state.objectStates[PANEL_OBJECT_ID]?.state['gmEdited']).toBe(true);

    const decided = await eventsOf(world.db, 'GM_REVIEW_DECIDED');
    expect(decided.map((entry) => entry['decision'])).toEqual(['EDIT_AND_APPROVE']);
    expect(await eventNames(world.db)).toContain('TURN_COMMITTED');
  });

  it('повтор editAndApprove с тем же ключом → тот же {version}, без второй записи committed (B-08.4)', async () => {
    const world = await resolvedWorld('gmr-edit-replay');
    worlds.push(world);
    const turn = await world.services.turns.getTurn(world.turnId);
    const base = turn.resolution!;
    const input = {
      turnId: world.turnId,
      gmPlayerId: world.gmPlayerId,
      editedResolution: base,
      baseResolutionHash: base.resolutionHash ?? resolutionHashOf(base),
      idempotencyKey: testKey('edit-replay'),
    };
    const first = await world.gmReview.editAndApprove(input);
    const second = await world.gmReview.editAndApprove(input);
    expect(second.version).toBe(first.version);
    expect(second.replayed).toBe(true);

    const committedCount = (await world.services.journal.list(world.turnId)).filter(
      (entry) => entry.kind === 'committed',
    ).length;
    expect(committedCount).toBe(1);
    expect(await eventsOf(world.db, 'TURN_COMMITTED')).toHaveLength(1);
  });

  it('editAndApprove не из REVIEW → CORE_INVALID_STATE_TRANSITION', async () => {
    const world = await bootWorld('gmr-edit-status');
    worlds.push(world);
    // ход LOCKED (не REVIEW); editedResolution — валиден по схеме, чтобы дойти до проверки статуса
    const validResolution: TurnResolution = {
      turnId: world.turnId,
      sessionId: world.sessionId,
      source: 'GM_MANUAL',
      aiResponseHash: null,
      baseVersion: 0,
      resolutionHash: null,
      segments: [],
      privateMessages: [],
      proposedEvents: [],
      proposedObjectChanges: [],
      proposedWorldStatePatch: {},
      visualScene: null,
      diagnostics: { providerId: 'none', model: null, attempts: 0, usage: null, costUsd: null, durationMs: null },
      createdAt: '2026-10-14T00:00:00.000Z',
      editedAt: null,
    };
    const code = await errorCodeOf(() =>
      world.gmReview.editAndApprove({
        turnId: world.turnId,
        gmPlayerId: world.gmPlayerId,
        editedResolution: validResolution,
        baseResolutionHash: '0'.repeat(64),
        idempotencyKey: testKey('edit-status'),
      }),
    );
    expect(code).toBe('CORE_INVALID_STATE_TRANSITION');
  });
});

describe('reject / retry через gm-review', () => {
  const worlds: World[] = [];
  afterAll(async () => {
    for (const world of worlds) await world.close();
  });

  it('reject → FAILED + TURN_FAILED{errorCode} + GM_REVIEW_DECIDED{REJECT}', async () => {
    const world = await resolvedWorld('gmr-reject');
    worlds.push(world);
    const result = await world.gmReview.reject({
      turnId: world.turnId,
      gmPlayerId: world.gmPlayerId,
      reason: 'нарратив противоречит канону',
      idempotencyKey: testKey('reject'),
    });
    expect(result.status).toBe('FAILED');
    const turn = await world.services.turns.getTurn(world.turnId);
    expect(turn.status).toBe('FAILED');
    expect(turn.failed?.message).toBe('нарратив противоречит канону');
    expect(turn.failed?.code).toBe('CONFLICT'); // default D223

    const failed = await eventsOf(world.db, 'TURN_FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ turnId: world.turnId, errorCode: 'CONFLICT' });
    const decided = await eventsOf(world.db, 'GM_REVIEW_DECIDED');
    expect(decided[0]).toMatchObject({ decision: 'REJECT', gmPlayerId: world.gmPlayerId });
  });

  it('retry → REVIEW→OPEN + GM_REVIEW_DECIDED{RETRY_AI}; retry из FAILED → новый ход (D118)', async () => {
    const world = await resolvedWorld('gmr-retry');
    worlds.push(world);
    const fromReview = await world.gmReview.retry({
      turnId: world.turnId,
      gmPlayerId: world.gmPlayerId,
      idempotencyKey: testKey('retry-review'),
    });
    expect(fromReview.createdNewTurn).toBe(false);
    expect(fromReview.status).toBe('OPEN');
    expect((await world.services.turns.getTurn(world.turnId)).resolution).toBeNull();
    const decided = await eventsOf(world.db, 'GM_REVIEW_DECIDED');
    expect(decided[0]).toMatchObject({ decision: 'RETRY_AI' });

    // доводим до FAILED и ретраим — создаётся НОВЫЙ ход
    // (после retry ход OPEN; cancelTurn применим только из OPEN — D223)
    await world.services.turns.cancelTurn({
      turnId: world.turnId,
      reason: 'тест',
      idempotencyKey: testKey('cancel'),
    });
    const fromFailed = await world.gmReview.retry({
      turnId: world.turnId,
      gmPlayerId: world.gmPlayerId,
      idempotencyKey: testKey('retry-failed'),
    });
    expect(fromFailed.createdNewTurn).toBe(true);
    expect(fromFailed.number).toBe(2);
    expect(fromFailed.status).toBe('OPEN');
  });
});

describe('pendingReviews', () => {
  const worlds: World[] = [];
  afterAll(async () => {
    for (const world of worlds) await world.close();
  });

  it('REVIEW-ход с черновиком в очереди; после approve — пустая', async () => {
    const world = await resolvedWorld('gmr-pending');
    worlds.push(world);
    const pending = await world.gmReview.pendingReviews({ sessionId: world.sessionId });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ turnId: world.turnId, status: 'REVIEW' });
    expect(pending[0]?.resolution?.source).toBe('AI');
    expect(pending[0]?.reviewReadyAt).not.toBeNull();

    await world.gmReview.approve({
      turnId: world.turnId,
      gmPlayerId: world.gmPlayerId,
      idempotencyKey: testKey('approve-pending'),
    });
    expect(await world.gmReview.pendingReviews({ sessionId: world.sessionId })).toHaveLength(0);
  });
});
