import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

import { FlagKey, nowIso, type PlayerId } from '@mnemosin/contracts';
import { loadConfig } from '@mnemosin/config';
import { createLogger } from '@mnemosin/logging';
import { bootstrapDatabase, loadLocationFixtures, OutboxPublisher } from '@mnemosin/database';
import { InMemoryMetricsSink, InProcessEventBus, createCoreServices, type CoreServices } from '@mnemosin/core';
import { attachModulesRegistry, buildAIStack, buildModules, validateModulesRegistry } from '@mnemosin/server';

/**
 * tools/verify/chat-probe.ts — проба модулей промпта 1.9 для A1.10 (чат).
 *
 * Сервисный слой на ЖИВОМ процессе (HTTP/WS-доставка — промпты 1.10/1.11):
 * видимости (public/private/GM/system), history-фильтры, sanitize, rate limit,
 * доставка черновика по TURN_COMMITTED (D238) и PUBLIC_AFTER_COMMIT (F-3.8) —
 * ровно один раз, аудит GM-действий append-only + дедупликация, story.setFlag.
 *
 * Печатает одну JSON-строку отчёта — verify:stage1 разбирает её и ставит PASS/FAIL.
 * Запуск: npx tsx --conditions=development tools/verify/chat-probe.ts
 */

const ROOT = resolve(process.cwd());
const dir = mkdtempSync(join(tmpdir(), 'mnemosin-chat-probe-'));
const config = loadConfig({
  cwd: ROOT,
  ignoreDotenv: true,
  version: '0.0.0-verify',
  env: {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: `file:${join(dir, 'chat-probe.sqlite')}`,
    JWT_SECRET: 'chat-probe-secret-0123456789abcdef01234567',
    LOG_LEVEL: 'silent',
    AI_PROVIDER: 'scripted',
    CONFIG_DIR: './config',
  },
});
const logger = createLogger({ config, name: 'chat-probe' });
const boot = await bootstrapDatabase({ url: config.env.DATABASE_URL, seed: false });
const services: CoreServices = createCoreServices({
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
const ai = buildAIStack({ config, uow: boot.uow, bus, metrics, logger, root: ROOT });
const modules = buildModules({ config, persistence: boot, services, ai, logger });
validateModulesRegistry(modules.registrations);
const detach = attachModulesRegistry(modules.registrations, bus, logger);
const publisher = new OutboxPublisher({ uow: boot.uow, bus, metrics });

let keySeq = 0;
const key = (prefix: string): string => {
  keySeq += 1;
  return `${prefix}-${keySeq}-${randomUUID()}`.slice(0, 128);
};

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === 'string' ? code : 'UNKNOWN';
  }
}

async function main(): Promise<void> {
  const checks: Record<string, unknown> = {};

  // ── лобби ──────────────────────────────────────────────────────────────
  const created = await services.sessions.createSession({
    title: 'МНЕМОСИН · приёмка 1.9 (чат)',
    gmDisplayName: 'Ведущий',
    idempotencyKey: key('create'),
  });
  const sessionId = created.sessionId;
  const playerIds: PlayerId[] = [];
  for (const name of ['Игрок А', 'Игрок Б', 'Игрок В']) {
    const joined = await services.sessions.joinSession({
      sessionId,
      displayName: name,
      idempotencyKey: key('join'),
    });
    playerIds.push(joined.playerId);
  }
  const [p0, p1, p2] = playerIds as [PlayerId, PlayerId, PlayerId];
  const started = await services.sessions.startSession({ sessionId, idempotencyKey: key('start') });
  const turnId = started.turnId;
  const chat = modules.chat;
  const gm = modules.gm;
  const story = modules.story;
  const gmAudit = modules.gmAudit;

  // ── A1.10: видимости ───────────────────────────────────────────────────
  await chat.sendPublicMessage({ sessionId, playerId: p0, text: 'Публичная реплика' });
  await chat.sendPrivateMessage({ sessionId, fromPlayerId: p0, toPlayerId: p1, text: 'Приватная реплика' });
  await chat.sendGMMessage({ sessionId, gmPlayerId: created.gmPlayerId, text: 'GM-реплика' });
  await chat.sendSystemMessage({ sessionId, text: 'Системная реплика' });

  const textsOf = async (playerId: PlayerId) =>
    (await boot.uow.repos().chat.listForPlayer(sessionId, playerId, 500)).map((message) => message.text);
  const p1Texts = await textsOf(p1);
  const p2Texts = await textsOf(p2);
  const gmTexts = await textsOf(created.gmPlayerId);
  checks.visibility =
    p1Texts.includes('Публичная реплика') &&
    p2Texts.includes('Публичная реплика') &&
    p1Texts.includes('Приватная реплика') &&
    p2Texts.includes('Приватная реплика') === false &&
    gmTexts.includes('Приватная реплика') === false && // чужая приватка GM не видна
    gmTexts.includes('GM-реплика') &&
    p1Texts.includes('GM-реплика') === false &&
    p1Texts.includes('Системная реплика');

  // history-фильтры
  const publicFeed = await chat.history({ sessionId, visibility: 'PUBLIC' });
  const privateP1 = await chat.history({ sessionId, visibility: 'PRIVATE', playerId: p1 });
  const gmFeed = await chat.history({ sessionId, visibility: 'GM' });
  const privateWithoutPlayer = await codeOf(() => chat.history({ sessionId, visibility: 'PRIVATE' }));
  checks.history =
    publicFeed.every((message) => message.visibility === 'PUBLIC') &&
    publicFeed.some((message) => message.text === 'Публичная реплика') &&
    privateP1.length === 1 &&
    privateP1[0]?.text === 'Приватная реплика' &&
    gmFeed.length === 1 &&
    privateWithoutPlayer === 'VALIDATION';

  // sanitize + rate limit
  const normalized = await chat.sendPublicMessage({ sessionId, playerId: p1, text: '  две\r\nстроки  ' });
  const stored = await boot.uow.repos().chat.findById(normalized.messageId);
  const tooLong = await codeOf(() =>
    chat.sendPublicMessage({ sessionId, playerId: p1, text: 'а'.repeat(config.limits.maxMessageLen + 1) }),
  );
  const controlChars = await codeOf(() => chat.sendPublicMessage({ sessionId, playerId: p1, text: 'злой\u0000текст' }));
  const capacity = config.limits.chat.publicPerSecond * config.limits.chat.burstSeconds;
  let rateLimited = false;
  for (let i = 0; i < capacity + 1; i++) {
    const code = await codeOf(() => chat.sendPublicMessage({ sessionId, playerId: p2, text: `флуд ${i}` }));
    if (code === 'RATE_LIMIT') rateLimited = true;
  }
  checks.sanitizeAndLimits =
    stored?.text === 'две\nстроки' && tooLong === 'VALIDATION' && controlChars === 'VALIDATION' && rateLimited;

  // ── story (D120) ───────────────────────────────────────────────────────
  const stateBefore = await services.state.get(sessionId);
  const flagged = await story.setFlag({
    sessionId,
    key: FlagKey.parse('probe_flag'),
    value: true,
    setBy: 'GM',
    turnId,
  });
  const stateAfter = await services.state.get(sessionId);
  checks.storySetFlag =
    flagged.version === stateBefore.version + 1 &&
    stateAfter.version === stateBefore.version + 1 &&
    stateAfter.storyFlags['probe_flag']?.value === true;

  // ── TURN_COMMITTED: нарратив + PUBLIC_AFTER_COMMIT ровно один раз ──────
  await services.turns.submitAction({ turnId, playerId: p0, rawText: 'Осматриваюсь', idempotencyKey: key('act') });
  await services.turns.lockTurn({ turnId, idempotencyKey: key('lock') });
  await gm.addNote({
    sessionId,
    gmPlayerId: created.gmPlayerId,
    turnId,
    visibility: 'PUBLIC_AFTER_COMMIT',
    text: 'Объявление после коммита',
    idempotencyKey: key('note'),
  });
  await modules.turn.resolveTurn({ turnId, traceId: 'probe-resolve' });
  await modules.gmReview.approve({ turnId, gmPlayerId: created.gmPlayerId, idempotencyKey: key('approve') });
  await publisher.drain();

  const systemFeed = await chat.history({ sessionId, visibility: 'SYSTEM', limit: 500 });
  const noteMessages = systemFeed.filter((message) => message.text.includes('Объявление после коммита'));
  const narrativeMessages = systemFeed.filter((message) => message.text.includes('Лампа над внутренней дверью'));
  // приватные сообщения ЧЕРНОВИКА — у них turnId хода (ранние p2p-сообщения — turnId=null)
  const privateAll = await chat.history({ sessionId, visibility: 'PRIVATE', playerId: p0 });
  const privateFromDraft = privateAll.filter((message) => message.turnId === turnId);
  checks.commitDelivery =
    noteMessages.length === 1 && // F-3.8: ровно один раз
    narrativeMessages.length >= 1 && // нарратив фикстуры доставлен SYSTEM-сообщениями
    privateFromDraft.length >= 1 && // приватные сообщения черновика — адресатам
    privateFromDraft.every((message) => message.fromPlayerId === created.gmPlayerId); // от GM/Директора

  // повторная доставка TURN_COMMITTED — без дублей
  await bus.publish({
    type: 'TURN_COMMITTED',
    payload: { sessionId, turnId, version: stateAfter.version + 1 },
    emittedAt: nowIso(),
    traceId: 'probe-redelivery',
  });
  const afterRedelivery = await chat.history({ sessionId, visibility: 'SYSTEM', limit: 500 });
  checks.redeliveryNoDuplicates =
    afterRedelivery.filter((message) => message.text.includes('Объявление после коммита')).length === 1;

  // ── gm-audit: append-only + дедупликация + GameState не мутирует ───────
  const versionBeforeAudit = (await services.state.get(sessionId)).version;
  await gm.pauseSession({ sessionId, gmPlayerId: created.gmPlayerId, idempotencyKey: key('pause') });
  await publisher.drain();
  const auditRows = await gmAudit.listAudit({ sessionId });
  const pauseRows = auditRows.filter((row) => row.action === 'pauseSession');
  const approveRows = auditRows.filter((row) => row.action === 'approve');
  const versionAfterAudit = (await services.state.get(sessionId)).version;
  checks.gmAudit = pauseRows.length === 1 && approveRows.length === 1 && versionBeforeAudit === versionAfterAudit;

  // ── реестр: 9 модулей (F-8.3) ──────────────────────────────────────────
  checks.registry = modules.registrations.length === 9;

  process.stdout.write(`${JSON.stringify({ probe: 'chat', checks })}\n`);
}

try {
  await main();
} finally {
  for (const off of detach) off();
  await boot.close();
  rmSync(dir, { recursive: true, force: true });
}
