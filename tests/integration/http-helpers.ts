import { mkdirSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

import { loadConfig, type AppConfig } from '@mnemosin/config';
import { createLogger, type Logger } from '@mnemosin/logging';
import { OutboxPublisher } from '@mnemosin/database';
import { InMemoryMetricsSink, InProcessEventBus, type CoreServices } from '@mnemosin/core';
import {
  buildAIStack,
  buildApp,
  buildModules,
  attachModulesRegistry,
  buildProjectionProvider,
  validateModulesRegistry,
  type AIStack,
} from '@mnemosin/server';
import { JwtService, type HttpGatewayDeps } from '@mnemosin/gateway-http';
import type { ChatService } from '@mnemosin/module-chat';
import type { StoryService } from '@mnemosin/module-story';
import type { GmService } from '@mnemosin/module-gm';
import type { GmAuditService } from '@mnemosin/module-gm-audit';
import type { TurnEngine } from '@mnemosin/module-turn';
import type { GmReviewService } from '@mnemosin/module-gm-review';

import { buildTestServices, openTempDb, type TempDb } from './helpers.js';

/**
 * HTTP-мир (промпт 1.10): ПУСТАЯ база (без pre-seeded сессии — D108 не даёт
 * второй живой сессии) + полный wiring модулей + реальный Fastify c gateway.
 * Запросы — app.inject (без порта); rate-limit-счётчики живут в экземпляре app,
 * поэтому на каждый тестовый блок — свой bootHttpWorld.
 */

const ROOT = process.cwd();
export const TEST_JWT_SECRET = 'http-test-secret-0123456789abcdef-XYZ'; // ≥32 символа

export interface HttpWorld {
  readonly db: TempDb;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly services: CoreServices;
  readonly bus: InProcessEventBus;
  readonly metrics: InMemoryMetricsSink;
  readonly publisher: OutboxPublisher;
  readonly ai: AIStack;
  readonly chat: ChatService;
  readonly story: StoryService;
  readonly gm: GmService;
  readonly gmAudit: GmAuditService;
  readonly turn: TurnEngine;
  readonly gmReview: GmReviewService;
  readonly app: Awaited<ReturnType<typeof buildApp>>;
  readonly jwt: JwtService;
  readonly gateway: HttpGatewayDeps;
  readonly mediaDir: string;
  readonly captured: Array<{ type: string; payload: Record<string, unknown>; traceId: string }>;
  drain(): Promise<void>;
  close(): Promise<void>;
}

export async function bootHttpWorld(label: string, options: { aiProvider?: string } = {}): Promise<HttpWorld> {
  const db = await openTempDb(label, { seed: false });
  const config = loadConfig({
    cwd: ROOT,
    ignoreDotenv: true,
    version: '0.0.0-test',
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: db.url,
      JWT_SECRET: TEST_JWT_SECRET,
      LOG_LEVEL: 'silent',
      AI_PROVIDER: options.aiProvider ?? 'scripted',
      AI_SCRIPTED_FIXTURE: resolvePath(ROOT, 'tools/fixtures/resolution.ok.json'),
    },
  });
  const logger = createLogger({ config, name: `http-${label}` });
  const services = buildTestServices(db);

  const bus = new InProcessEventBus();
  const metrics = new InMemoryMetricsSink();
  const captured: Array<{ type: string; payload: Record<string, unknown>; traceId: string }> = [];
  bus.subscribe('*', (event) => {
    captured.push({
      type: event.type,
      payload: event.payload as unknown as Record<string, unknown>,
      traceId: event.traceId,
    });
  });

  const ai = buildAIStack({ config, uow: db.boot.uow, bus, metrics, logger, root: ROOT });
  const modules = buildModules({ config, persistence: db.boot, services, ai, logger });
  validateModulesRegistry(modules.registrations);
  const detachHandles = attachModulesRegistry(modules.registrations, bus, logger.child({ component: 'registry' }));
  const publisher = new OutboxPublisher({ uow: db.boot.uow, bus, metrics });

  const jwt = new JwtService({
    secret: TEST_JWT_SECRET,
    accessTtlSeconds: 3600,
    refreshTtlSeconds: 86_400,
  });
  const mediaDir = join(db.dir, 'media');
  mkdirSync(mediaDir, { recursive: true });

  const gateway: HttpGatewayDeps = {
    jwt,
    players: db.boot.uow.repos().players,
    isProduction: false,
    sessions: services.sessions,
    turns: services.turns,
    chat: modules.chat,
    gm: modules.gm,
    gmReview: modules.gmReview,
    projections: buildProjectionProvider(db.boot.uow),
    getMetricsText: () => JSON.stringify(metrics.snapshot(), null, 2),
    mediaDir,
    limits: {
      authPerIpPerMin: config.limits.httpRateAuthPerIpPerMin,
      tokenPerMinute: config.limits.httpRatePerTokenPerMin,
      mutatingTurnPerMinute: config.limits.httpRateMutatingPerTokenPerMin,
    },
  };

  const app = await buildApp({
    config,
    logger,
    cwd: join(db.dir, 'no-client'), // client/dist отсутствует — статика пропускается
    persistence: db.boot,
    getCapabilities: () => ai.registry.snapshot(),
    httpGateway: gateway,
  });

  return {
    db,
    config,
    logger,
    services,
    bus,
    metrics,
    publisher,
    ai,
    chat: modules.chat,
    story: modules.story,
    gm: modules.gm,
    gmAudit: modules.gmAudit,
    turn: modules.turn,
    gmReview: modules.gmReview,
    app,
    jwt,
    gateway,
    mediaDir,
    captured,
    async drain() {
      await publisher.drain();
    },
    async close() {
      for (const detach of detachHandles) detach();
      await app.close();
      await db.close();
    },
  };
}

export interface SeededSession {
  readonly sessionId: string;
  readonly gmToken: string;
  readonly gmPlayerId: string;
  readonly gmRefreshToken: string;
  readonly playerA: { playerId: string; token: string; refreshToken: string };
  readonly playerB: { playerId: string; token: string; refreshToken: string };
}

/** Сессия + GM + два игрока через HTTP (POST /auth/session, /join). */
export async function seedHttpSession(http: HttpWorld): Promise<SeededSession> {
  const created = await http.app.inject({
    method: 'POST',
    url: '/auth/session',
    payload: { displayName: 'Гидеон', characterName: 'Архивариус', title: 'HTTP-партия' },
  });
  if (created.statusCode !== 200) throw new Error(`seed /auth/session: ${created.statusCode} ${created.body}`);
  const session = created.json() as {
    sessionId: string;
    playerId: string;
    token: string;
    refreshToken: string;
  };

  const join = async (displayName: string, characterName: string) => {
    const res = await http.app.inject({
      method: 'POST',
      url: `/sessions/${session.sessionId}/join`,
      payload: { displayName, characterName },
    });
    if (res.statusCode !== 200) throw new Error(`seed join ${displayName}: ${res.statusCode} ${res.body}`);
    return res.json() as { playerId: string; characterId: string; token: string; refreshToken: string };
  };

  return {
    sessionId: session.sessionId,
    gmToken: session.token,
    gmPlayerId: session.playerId,
    gmRefreshToken: session.refreshToken,
    playerA: await join('Ирма Векторова', 'Ирма'),
    playerB: await join('Каймен', 'Каймен'),
  };
}

export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/** Ожидание статуса хода (auto-resolve после lock — асинхронный, D253). */
export async function waitForTurnStatus(
  http: HttpWorld,
  turnId: string,
  expected: string[],
  token: string,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let status = 'UNKNOWN';
  while (Date.now() < deadline) {
    const res = await http.app.inject({ method: 'GET', url: `/turns/${turnId}`, headers: bearer(token) });
    if (res.statusCode === 200) {
      status = (res.json() as { status: string }).status;
      if (expected.includes(status)) return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`ход ${turnId} не достиг ${expected.join('|')} за ${timeoutMs}мс (status=${status})`);
}
