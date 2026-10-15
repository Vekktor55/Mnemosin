import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import {
  FlagKey,
  TurnResolutionSchema,
  type ObjectId,
  type PlayerId,
  type SessionId,
  type TurnId,
  type TurnResolution,
} from '@mnemosin/contracts';
import { loadConfig } from '@mnemosin/config';
import { createLogger } from '@mnemosin/logging';
import { bootstrapDatabase, loadLocationFixtures } from '@mnemosin/database';
import {
  InMemoryMetricsSink,
  InProcessEventBus,
  createCoreServices,
  resolutionHashOf,
  type CoreServices,
  type UnitOfWork,
} from '@mnemosin/core';
import { CapabilityRegistry, FailingAI, ScriptedAI } from '@mnemosin/ai';
import { AiDirectorService } from '@mnemosin/module-ai-director';
import { GmReviewService } from '@mnemosin/module-gm-review';
import { TurnEngine, rulesStub } from '@mnemosin/module-turn';

/**
 * tools/verify/turn-probe.ts — проба Turn Engine для A1.6/A1.8 (промпт 1.8).
 *
 * Прогоняет НА ЖИВОМ ПРОЦЕССЕ с настоящей БД:
 *  - полный цикл OPEN→LOCKED→PROCESSING→REVIEW→COMMITTED (scripted-провайдер):
 *    resolveTurn → approve, версия +1, события outbox, журнал, D117 (ход не
 *    открывается автоматически), replay повторов (B-08.4);
 *  - editAndApprove: чужой hash → VERSION_CONFLICT c актуальным resolution в meta;
 *    свой → AI_THEN_GM_EDIT + применение правки (A1.8);
 *  - commit с устаревшей baseVersion → VERSION_CONFLICT (F-3.2);
 *  - reject → FAILED + TURN_FAILED{errorCode}; retry из FAILED → новый ход (D118);
 *  - FailingAI(timeout) → FAILED{PROVIDER_TIMEOUT} + journal ai_call_failed.
 *
 * Печатает одну JSON-строку отчёта — verify:stage1 разбирает её и ставит PASS/FAIL.
 * Запуск: npx tsx --conditions=development tools/verify/turn-probe.ts
 */

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FIXTURE_PATH = resolve(ROOT, 'tools/fixtures/resolution.ok.json');
const PANEL_OBJECT_ID = '504a3329-490b-4d6d-85f7-752f2a69a605' as ObjectId;

const config = loadConfig({
  cwd: ROOT,
  ignoreDotenv: true,
  version: '0.0.0-verify',
  env: {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: 'file::memory:', // перезаписывается ниже на temp-файл
    JWT_SECRET: 'turn-probe-secret-0123456789abcdef0123456789',
    LOG_LEVEL: 'silent',
    AI_PROVIDER: 'scripted',
  },
});
const logger = createLogger({ config, name: 'turn-probe' });

let keySeq = 0;
const key = (prefix: string): string => {
  keySeq += 1;
  return `${prefix}-${keySeq}-${randomUUID()}`.slice(0, 128);
};

interface ProbeWorld {
  services: CoreServices;
  engine: TurnEngine;
  gmReview: GmReviewService;
  bus: InProcessEventBus;
  sessionId: SessionId;
  gmPlayerId: PlayerId;
  playerIds: PlayerId[];
  turnId: TurnId;
  uow: UnitOfWork;
  close(): Promise<void>;
  dir: string;
}

function bootDb(dir: string) {
  return bootstrapDatabase({ url: `file:${join(dir, 'probe.sqlite')}`, seed: false });
}

async function makeWorld(label: string, provider: 'scripted' | 'failing'): Promise<ProbeWorld> {
  const dir = mkdtempSync(join(tmpdir(), `mnemosin-turn-probe-${label}-`));
  const boot = await bootDb(dir);
  const services = createCoreServices({
    uow: boot.uow,
    guard: boot.idempotency,
    pack: loadLocationFixtures(),
    limits: {
      maxPlayersPerSession: config.limits.maxPlayersPerSession,
      actionsPerPlayerPerTurn: config.limits.actionsPerPlayerPerTurn,
    },
  });
  const created = await services.sessions.createSession({
    title: `МНЕМОСИН · приёмка 1.8 (${label})`,
    gmDisplayName: 'Ведущий',
    idempotencyKey: key('create'),
  });
  const playerIds: PlayerId[] = [];
  for (const name of ['Игрок А', 'Игрок Б', 'Игрок В']) {
    const joined = await services.sessions.joinSession({
      sessionId: created.sessionId,
      displayName: name,
      idempotencyKey: key('join'),
    });
    playerIds.push(joined.playerId);
  }
  const started = await services.sessions.startSession({
    sessionId: created.sessionId,
    idempotencyKey: key('start'),
  });

  const bus = new InProcessEventBus();
  const metrics = new InMemoryMetricsSink();
  const providerId = provider;
  const registry = new CapabilityRegistry({
    chains: { TEXT_AI: { required: true, chain: [providerId] } },
    policies: [
      {
        providerId,
        capability: 'TEXT_AI',
        timeoutMs: provider === 'failing' ? 60 : 2_000,
        retries: { max: 0, backoffMs: 10, jitter: false },
        circuitBreaker: { failureThreshold: 5, cooldownMs: 60_000 },
        costPer1kTokens: { input: null, output: null },
      },
    ],
    bus,
    metrics,
  });
  registry.register({
    capability: 'TEXT_AI',
    providerId,
    provider:
      provider === 'scripted'
        ? new ScriptedAI({ fixturePath: FIXTURE_PATH })
        : new FailingAI({ mode: 'timeout', providerId: 'failing' }),
  });
  const director = new AiDirectorService({
    uow: boot.uow,
    registry,
    bus,
    metrics,
    logger: logger.child({ component: 'ai-director' }),
    directorInstructions: config.limits.aiDirectorInstructions,
  });
  const engine = new TurnEngine({
    uow: boot.uow,
    guard: boot.idempotency,
    services: { turns: services.turns, state: services.state, journal: services.journal },
    aiDirector: director,
    rules: rulesStub,
    limits: { aiMutableObjectKeys: config.limits.aiMutable.objectStateKeys },
    metrics,
    logger: logger.child({ component: 'turn-engine' }),
  });
  const gmReview = new GmReviewService({
    uow: boot.uow,
    guard: boot.idempotency,
    journal: services.journal,
    turnEngine: engine,
  });

  return {
    services,
    engine,
    gmReview,
    bus,
    sessionId: created.sessionId,
    gmPlayerId: created.gmPlayerId,
    playerIds,
    turnId: started.turnId,
    uow: boot.uow,
    dir,
    async close() {
      await boot.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function outboxNames(uow: ProbeWorld['uow']): Promise<string[]> {
  const records = await uow.repos().outbox.listPending(1000);
  return records.map((record) => record.eventName);
}

async function outboxPayloads(uow: ProbeWorld['uow'], name: string): Promise<Array<Record<string, unknown>>> {
  const records = await uow.repos().outbox.listPending(1000);
  return records
    .filter((record) => record.eventName === name)
    .map((record) => JSON.parse(record.payloadJson) as Record<string, unknown>);
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === 'string' ? code : 'UNKNOWN';
  }
}

/** Действия + lock — ход готов к resolveTurn. */
async function prepare(world: ProbeWorld, turnId: TurnId): Promise<void> {
  await world.services.turns.submitAction({
    turnId,
    playerId: world.playerIds[0]!,
    rawText: 'Осматриваюсь в шлюзе',
    idempotencyKey: key('act'),
  });
  await world.services.turns.submitAction({
    turnId,
    playerId: world.playerIds[1]!,
    rawText: 'Слушаю гул вентиляции',
    idempotencyKey: key('act'),
  });
  await world.services.turns.lockTurn({ turnId, idempotencyKey: key('lock') });
}

async function main(): Promise<void> {
  const checks: Record<string, unknown> = {};

  // ── A: scripted-мир — полный цикл, edit&approve, конфликт версии, reject, retry
  const world = await makeWorld('scripted', 'scripted');
  try {
    await prepare(world, world.turnId);
    const stateV0 = await world.services.state.get(world.sessionId);

    // 1) resolveTurn → REVIEW
    const resolved = await world.engine.resolveTurn({ turnId: world.turnId, traceId: 'verify-resolve' });
    const reviewTurn = await world.services.turns.getTurn(world.turnId);
    checks.resolveToReview =
      resolved.status === 'REVIEW' && reviewTurn.status === 'REVIEW' && reviewTurn.reviewReadyAt !== null;
    checks.resolveReplay =
      (await world.engine.resolveTurn({ turnId: world.turnId, traceId: 'verify-replay' })).replayed === true;

    // 2) approve → COMMITTED (версия +1, D117: новый ход не открывается)
    const approveKey = key('approve');
    const approved = await world.gmReview.approve({
      turnId: world.turnId,
      gmPlayerId: world.gmPlayerId,
      idempotencyKey: approveKey,
    });
    const committedTurn = await world.services.turns.getTurn(world.turnId);
    const stateV1 = await world.services.state.get(world.sessionId);
    checks.commitVersion = approved.version === stateV0.version + 1 && stateV1.version === approved.version;
    checks.commitStatus = committedTurn.status === 'COMMITTED' && committedTurn.committedAt !== null;
    checks.objectChangeApplied = stateV1.objectStates[PANEL_OBJECT_ID]?.state['cycleLight'] === 'red_to_amber';
    const turnsAfterCommit = await world.services.turns.listTurns(world.sessionId);
    checks.d117NoAutoOpen = turnsAfterCommit.length === 1;

    // повтор approve с тем же ключом → тот же version, без второго journal 'committed' (B-08.4/A1.4)
    const approvedAgain = await world.gmReview.approve({
      turnId: world.turnId,
      gmPlayerId: world.gmPlayerId,
      idempotencyKey: approveKey,
    });
    const journalKinds = (await world.services.journal.list(world.turnId)).map((entry) => entry.kind);
    checks.approveReplay =
      approvedAgain.version === approved.version &&
      approvedAgain.replayed === true &&
      journalKinds.filter((kind) => kind === 'committed').length === 1;

    const events = await outboxNames(world.uow);
    checks.outboxEvents = [
      'TURN_PROCESSING_STARTED',
      'TURN_DRAFT_READY',
      'AI_DRAFT_PROPOSED',
      'GM_REVIEW_DECIDED',
      'TURN_COMMITTED',
      'STATE_COMMITTED',
    ].every((name) => events.includes(name));
    checks.journalKinds = [
      'processing_started',
      'ai_call_finished',
      'rules_evaluated',
      'draft_ready',
      'gm_decision',
      'state_applied',
      'committed',
    ].every((kind) => journalKinds.includes(kind));

    // 3) ход №2: editAndApprove — чужой hash → 409; свой → применение правки (A1.8)
    const turn2 = await world.services.turns.openTurn({ sessionId: world.sessionId, idempotencyKey: key('open2') });
    await prepare(world, turn2.turnId);
    await world.engine.resolveTurn({ turnId: turn2.turnId, traceId: 'verify-resolve-2' });
    const draft2 = (await world.services.turns.getTurn(turn2.turnId)).resolution!;
    const baseHash = draft2.resolutionHash ?? resolutionHashOf(draft2);

    const conflictError = await world.gmReview
      .editAndApprove({
        turnId: turn2.turnId,
        gmPlayerId: world.gmPlayerId,
        editedResolution: draft2,
        baseResolutionHash: 'f'.repeat(64),
        idempotencyKey: key('edit-bad'),
      })
      .catch((cause: unknown) => cause);
    const conflictMeta = (conflictError as { meta?: Record<string, unknown> }).meta ?? {};
    checks.editHashConflict =
      (conflictError as { code?: string }).code === 'VERSION_CONFLICT' &&
      (conflictMeta['resolution'] as TurnResolution | undefined)?.turnId === turn2.turnId;

    const edited: TurnResolution = TurnResolutionSchema.parse({
      ...draft2,
      proposedObjectChanges: draft2.proposedObjectChanges.map((change) => ({
        ...change,
        patch: { cycleLight: 'green' },
        gmComment: 'правка ведущего',
      })),
    });
    const editResult = await world.gmReview.editAndApprove({
      turnId: turn2.turnId,
      gmPlayerId: world.gmPlayerId,
      editedResolution: edited,
      baseResolutionHash: baseHash,
      idempotencyKey: key('edit-ok'),
    });
    const turn2After = await world.services.turns.getTurn(turn2.turnId);
    const stateV2 = await world.services.state.get(world.sessionId);
    checks.editAndApprove =
      turn2After.status === 'COMMITTED' &&
      turn2After.resolution?.source === 'AI_THEN_GM_EDIT' &&
      turn2After.resolution?.editedAt !== null &&
      stateV2.objectStates[PANEL_OBJECT_ID]?.state['cycleLight'] === 'green' &&
      editResult.version === stateV2.version;

    // 4) ход №3: устаревшая baseVersion → VERSION_CONFLICT; reject → FAILED; retry → новый ход
    const turn3 = await world.services.turns.openTurn({ sessionId: world.sessionId, idempotencyKey: key('open3') });
    await prepare(world, turn3.turnId);
    await world.engine.resolveTurn({ turnId: turn3.turnId, traceId: 'verify-resolve-3' });
    const stateV3 = await world.services.state.get(world.sessionId);
    await world.services.state.apply({
      sessionId: world.sessionId,
      mutations: [{ kind: 'SET_FLAG', key: FlagKey.parse('probe_external'), value: true, setBy: 'GM' }],
      expectedVersion: stateV3.version,
      turnId: null,
      traceId: 'verify-external',
    });
    const staleCode = await codeOf(() =>
      world.gmReview.approve({
        turnId: turn3.turnId,
        gmPlayerId: world.gmPlayerId,
        idempotencyKey: key('approve-stale'),
      }),
    );
    checks.staleVersionConflict = staleCode === 'VERSION_CONFLICT';

    const rejected = await world.gmReview.reject({
      turnId: turn3.turnId,
      gmPlayerId: world.gmPlayerId,
      reason: 'черновик устарел — внешний конфликт версии',
      idempotencyKey: key('reject'),
    });
    const turn3After = await world.services.turns.getTurn(turn3.turnId);
    const failedEvents = await outboxPayloads(world.uow, 'TURN_FAILED');
    checks.rejectFlow =
      rejected.status === 'FAILED' &&
      turn3After.status === 'FAILED' &&
      turn3After.failed?.code === 'CONFLICT' &&
      failedEvents.some((payload) => payload['turnId'] === turn3.turnId && payload['errorCode'] === 'CONFLICT');

    const retried = await world.gmReview.retry({
      turnId: turn3.turnId,
      gmPlayerId: world.gmPlayerId,
      idempotencyKey: key('retry'),
    });
    const newTurnActions = await world.uow.repos().actions.listByTurn(retried.turnId);
    checks.retryFromFailed =
      retried.createdNewTurn === true &&
      retried.status === 'OPEN' &&
      retried.turnId !== turn3.turnId &&
      newTurnActions.length === 0; // D118: действия не копируются
  } finally {
    await world.close();
  }

  // ── B: failing-мир — деградация провайдера (п.9 промта 1.8)
  const failingWorld = await makeWorld('failing', 'failing');
  try {
    await prepare(failingWorld, failingWorld.turnId);
    const failedCode = await codeOf(() =>
      failingWorld.engine.resolveTurn({ turnId: failingWorld.turnId, traceId: 'verify-fail' }),
    );
    const turn = await failingWorld.services.turns.getTurn(failingWorld.turnId);
    const journal = (await failingWorld.services.journal.list(failingWorld.turnId)).map((entry) => entry.kind);
    const failedPayloads = await outboxPayloads(failingWorld.uow, 'TURN_FAILED');
    checks.providerFailure =
      failedCode === 'PROVIDER_UNAVAILABLE' &&
      turn.status === 'FAILED' &&
      turn.failed?.code === 'PROVIDER_TIMEOUT' &&
      journal.includes('ai_call_failed') &&
      failedPayloads.some((payload) => payload['errorCode'] === 'PROVIDER_TIMEOUT');

    const retried = await failingWorld.engine.retryTurn({
      turnId: failingWorld.turnId,
      idempotencyKey: key('retry-fail'),
      gmDecision: { gmPlayerId: failingWorld.gmPlayerId },
    });
    checks.retryAfterProviderFailure = retried.createdNewTurn === true && retried.status === 'OPEN';
  } finally {
    await failingWorld.close();
  }

  process.stdout.write(`${JSON.stringify({ probe: 'turn', checks })}\n`);
}

await main();
