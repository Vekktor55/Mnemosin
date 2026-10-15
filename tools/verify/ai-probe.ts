import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { ProviderError, type DomainEvent, type PlayerId, type TurnId } from '@mnemosin/contracts';
import { loadConfig } from '@mnemosin/config';
import { createLogger } from '@mnemosin/logging';
import { bootstrapDatabase, loadLocationFixtures } from '@mnemosin/database';
import { InMemoryMetricsSink, InProcessEventBus, createCoreServices } from '@mnemosin/core';
import { buildAIStack } from '@mnemosin/server';

/**
 * tools/verify/ai-probe.ts — проба AI-контура для switch-provider.mjs (промпт 1.7).
 *
 * Один прогон = один сценарий (env AI_PROVIDER + CONFIG_DIR задаёт оркестратор):
 *  - scripted — ход доходит до REVIEW, нарратив из фикстуры (маркер {actionCount}
 *    заменён числом действий), приватные сообщения ремэппятся на игроков партии;
 *  - echo     — ход доходит до REVIEW, нарратив содержит тексты действий;
 *  - failing  — три провала generateDraft: AI_GENERATION_FAILED{PROVIDER_TIMEOUT},
 *    breaker OPEN, CAPABILITY_CHANGED{TEXT_AI,false}, ход → FAILED{PROVIDER_TIMEOUT}
 *    (эквивалент TURN_FAILED этапа 1.7: событие TURN_FAILED эмитит turn engine в 1.8).
 *
 * Wiring — НАСТОЯЩИЙ (buildAIStack из apps/server): проба проверяет тот же код,
 * который запускается в сервере. Печатает одну JSON-строку отчёта.
 *
 * Запуск: npx tsx --conditions=development tools/verify/ai-probe.ts --scenario=scripted|echo|failing
 */

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const scenario = (process.argv.find((arg) => arg.startsWith('--scenario=')) ?? '--scenario=scripted').slice(
  '--scenario='.length,
);

const dir = mkdtempSync(join(tmpdir(), 'mnemosin-ai-probe-'));
const config = loadConfig({
  cwd: ROOT,
  ignoreDotenv: true,
  version: '0.0.0-verify',
  env: {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: `file:${join(dir, 'ai-probe.sqlite')}`,
    JWT_SECRET: 'ai-probe-secret-0123456789abcdef0123456789',
    LOG_LEVEL: 'silent',
  },
});

const boot = await bootstrapDatabase({ url: config.env.DATABASE_URL, seed: false });
const services = createCoreServices({
  uow: boot.uow,
  guard: boot.idempotency,
  pack: loadLocationFixtures(),
  limits: {
    maxPlayersPerSession: config.limits.maxPlayersPerSession,
    actionsPerPlayerPerTurn: config.limits.actionsPerPlayerPerTurn,
  },
});

const bus = new InProcessEventBus();
const metrics = new InMemoryMetricsSink();
const logger = createLogger({ config, name: 'ai-probe' });
const ai = buildAIStack({ config, uow: boot.uow, bus, metrics, logger, root: ROOT });
await ai.registry.probeOnce();

const captured: Array<{ type: string; payload: Record<string, unknown> }> = [];
bus.subscribe('*', (event: DomainEvent) => {
  captured.push({ type: event.type, payload: event.payload as unknown as Record<string, unknown> });
});

const traceId = `verify-ai-${scenario}`;
let keySeq = 0;
const key = (prefix: string): string => {
  keySeq += 1;
  return `${prefix}-${keySeq}-${randomUUID()}`.slice(0, 128);
};

async function rejectionCode(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (cause) {
    if (cause instanceof ProviderError) return cause.code;
    const code = (cause as { code?: unknown }).code;
    return typeof code === 'string' ? code : 'UNKNOWN';
  }
}

/** Лобби → ход №1 в PROCESSING с двумя действиями. */
async function bootTurn(): Promise<{ turnId: TurnId; playerIds: PlayerId[]; gmPlayerId: PlayerId }> {
  const created = await services.sessions.createSession({
    title: `МНЕМОСИН · приёмка 1.7 (${scenario})`,
    gmDisplayName: 'Ведущий',
    idempotencyKey: key('create'),
    traceId,
  });
  const playerIds: PlayerId[] = [];
  for (const name of ['Игрок А', 'Игрок Б', 'Игрок В']) {
    const joined = await services.sessions.joinSession({
      sessionId: created.sessionId,
      displayName: name,
      idempotencyKey: key('join'),
      traceId,
    });
    playerIds.push(joined.playerId);
  }
  const started = await services.sessions.startSession({
    sessionId: created.sessionId,
    idempotencyKey: key('start'),
    traceId,
  });
  const turnId = started.turnId;
  await services.turns.submitAction({
    turnId,
    playerId: playerIds[0]!,
    rawText: 'Осматриваюсь в шлюзе',
    idempotencyKey: key('act'),
    traceId,
  });
  await services.turns.submitAction({
    turnId,
    playerId: playerIds[1]!,
    rawText: 'Слушаю гул вентиляции',
    idempotencyKey: key('act'),
    traceId,
  });
  await services.turns.lockTurn({ turnId, idempotencyKey: key('lock'), traceId });
  await services.turns.transition({ turnId, trigger: 'startProcessing', traceId });
  return { turnId, playerIds, gmPlayerId: created.gmPlayerId };
}

async function main(): Promise<void> {
  const report: Record<string, unknown> = { scenario, aiProvider: config.env.AI_PROVIDER };

  if (scenario === 'scripted' || scenario === 'echo') {
    const { turnId, playerIds, gmPlayerId } = await bootTurn();
    const output = await ai.director.generateDraft({ turnId, traceId });
    const review = await services.turns.transition({ turnId, trigger: 'draftReady', traceId });
    const narrative = output.resolution.segments.map((segment) => segment.text).join(' ');
    // K13/D157: characterNames включает GM — приватные сообщения могут адресоваться ему.
    const memberIds = new Set<string>([...playerIds, gmPlayerId]);

    report.checks = {
      draftProposed: captured.some((entry) => entry.type === 'AI_DRAFT_PROPOSED'),
      turnReachedReview: review.status === 'REVIEW',
      reviewReadyAtSet: (await services.turns.getTurn(turnId)).reviewReadyAt !== null,
      providerId: output.resolution.diagnostics.providerId,
      sourceAI: output.resolution.source === 'AI',
      allProposed: [...output.resolution.segments, ...output.resolution.privateMessages].every(
        (item) => item.status === 'PROPOSED',
      ),
      ...(scenario === 'scripted'
        ? {
            narrativeFromFixture: narrative.includes('Лампа над внутренней дверью'),
            actionCountSubstituted: narrative.includes('2') && !narrative.includes('{actionCount}'),
            privateMessagesRemapped:
              output.resolution.privateMessages.length === 6 &&
              output.resolution.privateMessages.every((message) => memberIds.has(message.playerId)),
            objectChangeFromRemap:
              output.resolution.proposedObjectChanges[0]?.objectId === '504a3329-490b-4d6d-85f7-752f2a69a605',
            visualScenePresent: output.resolution.visualScene !== null,
          }
        : {
            narrativeFromActions:
              narrative.includes('Вы делаете:') &&
              narrative.includes('Осматриваюсь в шлюзе') &&
              narrative.includes('Слушаю гул вентиляции'),
            emptyProposals:
              output.resolution.privateMessages.length === 0 &&
              output.resolution.proposedEvents.length === 0 &&
              output.resolution.proposedObjectChanges.length === 0,
          }),
    };
  } else if (scenario === 'failing') {
    const { turnId } = await bootTurn();
    const codes: Array<string | null> = [];
    for (let round = 0; round < 3; round += 1) {
      codes.push(await rejectionCode(() => ai.director.generateDraft({ turnId, traceId })));
    }
    const snapshot = ai.registry.snapshot();
    const provider = snapshot.providers.find((entry) => entry.providerId === 'failing');
    const changed = captured.filter((entry) => entry.type === 'CAPABILITY_CHANGED');
    const failedEvents = captured.filter((entry) => entry.type === 'AI_GENERATION_FAILED');
    const broken = await services.turns.transition({
      turnId,
      trigger: 'processingFailed',
      failed: { code: 'PROVIDER_TIMEOUT', message: 'провайдер не ответил вовремя (приёмка 1.7)' },
      traceId,
    });
    const turn = await services.turns.getTurn(turnId);
    const decisions = await boot.uow.repos().aiDecisions.listByTurn(turnId);

    report.checks = {
      threeRejectionsUnavailable: codes.every((code) => code === 'PROVIDER_UNAVAILABLE'),
      failedEventEveryRound:
        failedEvents.length === 3 && failedEvents.every((entry) => entry.payload['errorCode'] === 'PROVIDER_TIMEOUT'),
      failedEventTurn: failedEvents.every((entry) => entry.payload['turnId'] === turnId),
      breakerOpen: provider?.breaker === 'OPEN',
      breakerFailures: provider?.failures ?? -1,
      capabilityChangedFalse: changed.some(
        (entry) => entry.payload['capability'] === 'TEXT_AI' && entry.payload['available'] === false,
      ),
      textAiUnavailableNow: (await ai.registry.isAvailable('TEXT_AI')) === false,
      healthSnapshotDegraded: snapshot.capabilities['TEXT_AI']?.available === false,
      turnFailedWithProviderTimeout: broken.status === 'FAILED' && turn.failed?.code === 'PROVIDER_TIMEOUT',
      decisionsTimeout: decisions.length === 3 && decisions.every((decision) => decision.status === 'TIMEOUT'),
    };
  } else {
    throw new Error(`неизвестный сценарий: ${scenario}`);
  }

  process.stdout.write(`${JSON.stringify(report)}\n`);
}

try {
  await main();
} finally {
  await boot.close();
  rmSync(dir, { recursive: true, force: true });
}
