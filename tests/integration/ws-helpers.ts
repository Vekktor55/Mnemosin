import { randomUUID } from 'node:crypto';
import { join, resolve as resolvePath } from 'node:path';

import { WebSocket } from 'ws';

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
import { JwtService } from '@mnemosin/gateway-http';
import type { WsGatewayDeps, WsGatewayHandle, WsLimits } from '@mnemosin/gateway-ws';
import type { ChatService } from '@mnemosin/module-chat';
import type { StoryService } from '@mnemosin/module-story';
import type { GmService } from '@mnemosin/module-gm';
import type { GmAuditService } from '@mnemosin/module-gm-audit';
import type { TurnEngine } from '@mnemosin/module-turn';
import type { GmReviewService } from '@mnemosin/module-gm-review';

import { buildTestServices, openTempDb, testKey, type TempDb } from './helpers.js';

/**
 * WS-мир (промпт 1.11): пустая БД + полный wiring модулей + реальный Fastify
 * с HTTP- и WS-шлюзами на ЖИВОМ порту (127.0.0.1:0). Клиенты — реальный `ws`.
 *
 * restart() закрывает app и поднимает НОВЫЙ на той же БД/модулях/шине —
 * сценарий «kill сервера → реконнект» (A1.9) без отдельного процесса.
 */

const ROOT = process.cwd();
export const WS_TEST_JWT_SECRET = 'ws-test-secret-0123456789abcdef-XYZ'; // ≥32 символа

export interface WsClientOptions {
  /** 'subprotocol' (D123, основной) | 'query' (?token=) | 'none' (окно AUTH). */
  readonly mode?: 'subprotocol' | 'query' | 'none';
  /** additional query-токен (проверка приоритета: subprotocol важнее). */
  readonly queryToken?: string;
}

export interface ReceivedMessage {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly requestId?: string;
  readonly sessionId?: string;
  readonly ts: string;
  readonly at: number;
}

export class TestWsClient {
  readonly messages: ReceivedMessage[] = [];
  readonly sentRequestIds = new Set<string>();
  readonly label: string;
  closedEvent: { code: number; reason: string } | null = null;
  pingCount = 0;

  private readonly ws: WebSocket;
  private readonly openPromise: Promise<void>;
  private readonly closePromise: Promise<{ code: number; reason: string }>;

  private constructor(ws: WebSocket, label: string) {
    this.label = label;
    this.ws = ws;
    this.openPromise = new Promise((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    this.closePromise = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        this.closedEvent = { code, reason: reason.toString('utf8') };
        resolve(this.closedEvent);
      });
    });
    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
        this.messages.push({
          type: String(parsed['type'] ?? ''),
          payload: (parsed['payload'] ?? {}) as Record<string, unknown>,
          ...(typeof parsed['requestId'] === 'string' ? { requestId: parsed['requestId'] } : {}),
          ...(typeof parsed['sessionId'] === 'string' ? { sessionId: parsed['sessionId'] } : {}),
          ts: String(parsed['ts'] ?? ''),
          at: Date.now(),
        });
      } catch {
        /* не-JSON кадр игнорируем */
      }
    });
    ws.on('ping', () => {
      this.pingCount += 1;
    });
  }

  static async connect(
    url: string,
    options: { token?: string; label?: string } & WsClientOptions = {},
  ): Promise<TestWsClient> {
    const { token, label = 'client', mode = 'subprotocol', queryToken } = options;
    let target = url;
    if (queryToken !== undefined) target = `${url}?token=${encodeURIComponent(queryToken)}`;
    else if (mode === 'query' && token !== undefined) target = `${url}?token=${encodeURIComponent(token)}`;
    const protocols = mode === 'subprotocol' && token !== undefined ? [`mnemosin.v1.${token}`] : undefined;
    const ws = new WebSocket(target, protocols);
    const client = new TestWsClient(ws, label);
    await client.openPromise;
    return client;
  }

  get readyState(): number {
    return this.ws.readyState;
  }

  send(
    type: string,
    payload: Record<string, unknown> = {},
    extra: { requestId?: string; sessionId?: string } = {},
  ): void {
    const envelope: Record<string, unknown> = { type, payload, ts: new Date().toISOString() };
    if (extra.requestId !== undefined) {
      envelope['requestId'] = extra.requestId;
      this.sentRequestIds.add(extra.requestId);
    }
    if (extra.sessionId !== undefined) envelope['sessionId'] = extra.sessionId;
    this.ws.send(JSON.stringify(envelope));
  }

  /** Отправка с автогенерацией requestId (≥16 символов по RequestIdSchema). */
  sendReq(type: string, payload: Record<string, unknown> = {}, sessionId?: string): string {
    const requestId = `req-${randomUUID()}`;
    this.send(type, { ...payload, requestId }, { requestId, ...(sessionId === undefined ? {} : { sessionId }) });
    return requestId;
  }

  /** Ожидание сообщения: тип или предикат. Возвращает ПЕРВОЕ подходящее. */
  async waitFor(
    matcher: string | ((message: ReceivedMessage) => boolean),
    timeoutMs = 6000,
    fromIndex = 0,
  ): Promise<ReceivedMessage> {
    const predicate = typeof matcher === 'string' ? (m: ReceivedMessage): boolean => m.type === matcher : matcher;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let i = fromIndex; i < this.messages.length; i += 1) {
        const message = this.messages[i];
        if (message !== undefined && predicate(message)) return message;
      }
      if (Date.now() > deadline) {
        const seen = this.messages.map((m) => m.type).join(',');
        throw new Error(
          `[${this.label}] не дождались ${typeof matcher === 'string' ? matcher : 'predicate'} за ${timeoutMs}мс (получено: ${seen})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }

  /** Ожидание сообщения с конкретным requestId. */
  async waitForRequestId(type: string, requestId: string, timeoutMs = 6000): Promise<ReceivedMessage> {
    return this.waitFor((m) => m.type === type && m.requestId === requestId, timeoutMs);
  }

  async waitForClose(timeoutMs = 6000): Promise<{ code: number; reason: string }> {
    if (this.closedEvent !== null) return this.closedEvent;
    const timer = setTimeout(() => {
      throw new Error(`[${this.label}] соединение не закрылось за ${timeoutMs}мс`);
    }, timeoutMs);
    try {
      return await this.closePromise;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Мгновенный обрыв (аналог kill -9 для сокета). */
  terminate(): void {
    this.ws.terminate();
  }

  close(): void {
    if (this.ws.readyState <= 1) this.ws.close(1000, 'test done');
  }
}

export interface SeededWsSession {
  readonly sessionId: string;
  readonly turnId: string;
  readonly gm: { playerId: string; token: string; characterName: string };
  readonly players: Array<{ playerId: string; token: string; characterName: string }>;
}

export interface WsWorld {
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
  readonly jwt: JwtService;
  readonly captured: Array<{ type: string; payload: Record<string, unknown>; traceId: string }>;
  app: Awaited<ReturnType<typeof buildApp>>;
  wsUrl: string;
  wsLimits: WsLimits;
  connect(token: string | undefined, options?: { label?: string } & WsClientOptions): Promise<TestWsClient>;
  seedSession(playerCount: number): Promise<SeededWsSession>;
  drain(): Promise<void>;
  /** Закрыть текущий app и поднять новый (та же БД/модули/шина) — «kill+подъём». */
  restart(): Promise<void>;
  handle(): WsGatewayHandle | undefined;
  close(): Promise<void>;
}

function wsLimitsOf(config: AppConfig, overrides: Partial<WsLimits> = {}): WsLimits {
  return {
    wsAuthTimeoutMs: overrides.wsAuthTimeoutMs ?? config.limits.wsAuthTimeoutMs,
    wsMaxConnectionsPerIp: overrides.wsMaxConnectionsPerIp ?? config.limits.wsMaxConnectionsPerIp,
    wsMaxConnectionsPerPlayer: overrides.wsMaxConnectionsPerPlayer ?? config.limits.wsMaxConnectionsPerPlayer,
    wsMaxPayloadBytes: overrides.wsMaxPayloadBytes ?? config.limits.wsMaxPayloadBytes,
    heartbeat: overrides.heartbeat ?? {
      intervalMs: config.limits.heartbeat.intervalMs,
      idleTimeoutMs: config.limits.heartbeat.idleTimeoutMs,
    },
    wsRatePerConnection: overrides.wsRatePerConnection ?? {
      ACTION_SUBMIT: config.limits.wsRatePerConnection.ACTION_SUBMIT,
      CHAT_PUBLIC: config.limits.wsRatePerConnection.CHAT_PUBLIC,
      DEFAULT: config.limits.wsRatePerConnection.DEFAULT,
    },
    dedupeTtlMs: overrides.dedupeTtlMs ?? config.limits.dedupeTtlMs,
  };
}

export async function bootWsWorld(
  label: string,
  options: { aiProvider?: string; limits?: Partial<WsLimits> } = {},
): Promise<WsWorld> {
  const db = await openTempDb(`ws-${label}`, { seed: false });
  const config = loadConfig({
    cwd: ROOT,
    ignoreDotenv: true,
    version: '0.0.0-wstest',
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: db.url,
      JWT_SECRET: WS_TEST_JWT_SECRET,
      LOG_LEVEL: 'silent',
      AI_PROVIDER: options.aiProvider ?? 'scripted',
      AI_SCRIPTED_FIXTURE: resolvePath(ROOT, 'tools/fixtures/resolution.ok.json'),
    },
  });
  const logger = createLogger({ config, name: `ws-${label}` });
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

  const jwt = new JwtService({ secret: WS_TEST_JWT_SECRET, accessTtlSeconds: 3600, refreshTtlSeconds: 86_400 });
  const wsLimits = wsLimitsOf(config, options.limits);

  const buildWsGateway = (): WsGatewayDeps => ({
    jwt,
    players: db.boot.uow.repos().players,
    bus,
    serverVersion: config.version,
    getCapabilities: () => Object.values(ai.registry.snapshot().capabilities),
    sessions: services.sessions,
    turns: services.turns,
    chat: modules.chat,
    gm: modules.gm,
    gmReview: modules.gmReview,
    story: modules.story,
    projections: buildProjectionProvider(db.boot.uow),
    limits: wsLimits,
  });

  const bootApp = async (): Promise<Awaited<ReturnType<typeof buildApp>>> => {
    const app = await buildApp({
      config,
      logger,
      cwd: join(db.dir, 'no-client'),
      persistence: db.boot,
      getCapabilities: () => ai.registry.snapshot(),
      httpGateway: {
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
        mediaDir: join(db.dir, 'media'),
        limits: {
          authPerIpPerMin: config.limits.httpRateAuthPerIpPerMin,
          tokenPerMinute: config.limits.httpRatePerTokenPerMin,
          mutatingTurnPerMinute: config.limits.httpRateMutatingPerTokenPerMin,
        },
      },
      wsGateway: buildWsGateway(),
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    return app;
  };

  let app = await bootApp();
  const wsUrlOf = (instance: typeof app): string => {
    const address = instance.addresses()[0];
    if (address === undefined) throw new Error('сервер не имеет адреса');
    return `ws://127.0.0.1:${address.port}/ws`;
  };

  const world: WsWorld = {
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
    jwt,
    captured,
    app,
    wsUrl: wsUrlOf(app),
    wsLimits,
    async connect(token, opts = {}) {
      return TestWsClient.connect(world.wsUrl, { ...(token === undefined ? {} : { token }), ...opts });
    },
    async seedSession(playerCount) {
      const created = await app.inject({
        method: 'POST',
        url: '/auth/session',
        payload: { displayName: 'Ведущий', characterName: 'Ведущий', title: `WS-партия ${label}` },
      });
      if (created.statusCode !== 200) throw new Error(`seed /auth/session: ${created.statusCode} ${created.body}`);
      const session = created.json() as { sessionId: string; playerId: string; token: string };

      const players: Array<{ playerId: string; token: string; characterName: string }> = [];
      for (let i = 1; i <= playerCount; i += 1) {
        const characterName = `Игрок ${i}`;
        const res = await app.inject({
          method: 'POST',
          url: `/sessions/${session.sessionId}/join`,
          payload: { displayName: characterName, characterName },
        });
        if (res.statusCode !== 200) throw new Error(`seed join ${i}: ${res.statusCode} ${res.body}`);
        const joined = res.json() as { playerId: string; token: string };
        players.push({ playerId: joined.playerId, token: joined.token, characterName });
      }

      const started = await services.sessions.startSession({
        sessionId: session.sessionId as never,
        idempotencyKey: testKey('ws-start'),
      });
      return {
        sessionId: session.sessionId,
        turnId: started.turnId as string,
        gm: { playerId: session.playerId, token: session.token, characterName: 'Ведущий' },
        players,
      };
    },
    async drain() {
      await publisher.drain();
    },
    async restart() {
      // «kill сервера»: отписка от шины + закрытие соединений и app; клиенты
      // получают close (в verify-скрипте — настоящий kill -9 процесса).
      app.wsGateway?.detach();
      app.wsGateway?.closeAll();
      await app.close();
      app = await bootApp();
      world.app = app;
      world.wsUrl = wsUrlOf(app);
    },
    handle() {
      return app.wsGateway;
    },
    async close() {
      for (const detach of detachHandles) detach();
      app.wsGateway?.detach();
      app.wsGateway?.closeAll();
      await app.close();
      await db.close();
    },
  };
  return world;
}

/** Ожидание статуса хода (auto-resolve после lock — асинхронный, D253). */
export async function waitForTurnStatusWs(
  world: WsWorld,
  turnId: string,
  expected: string[],
  timeoutMs = 6000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let status = 'UNKNOWN';
  while (Date.now() < deadline) {
    const turn = await world.turn.getTurn({ turnId: turnId as never });
    status = turn.status;
    if (expected.includes(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`ход ${turnId} не достиг ${expected.join('|')} за ${timeoutMs}мс (status=${status})`);
}
