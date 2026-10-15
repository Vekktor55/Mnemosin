import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { Logger } from 'pino';

import { CONTRACTS_VERSION } from '@mnemosin/contracts';
import { ping, type BootstrapResult } from '@mnemosin/database';
import type { AppConfig } from '@mnemosin/config';
import { newTraceId } from '@mnemosin/logging';
import { createHttpErrorHandler, registerHttpRoutes, type HttpGatewayDeps } from '@mnemosin/gateway-http';
import { registerWsGateway, type WsGatewayDeps, type WsGatewayHandle } from '@mnemosin/gateway-ws';

import { buildHealthPayload, buildVersionPayload } from './health.js';

/**
 * HTTP-транспорт (v3 §VI.1). Промпт 1.1 — каркас:
 *   /health, /version, CORS, rate-limit (глобальный), error handler, статика.
 * Полный каталог маршрутов и JWT-auth — промпт 1.10 (docs/SPEC_STAGE1.md §7).
 *
 * Инвариант 14: транспорт не содержит игровой логики. Здесь — только
 * парсинг, авторизация, вызов команд модулей и сериализация.
 */

export interface BuildAppOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
  /** Корень проекта (для статики и client/dist). */
  readonly cwd?: string;
  /** Подключение к БД (промпт 1.4). Без него /health отдаёт db:'unknown' — сервер всё равно жив (A1.1). */
  readonly persistence?: BootstrapResult;
  /**
   * Срез Capability Registry для GET /health (промпт 1.7, A1.13).
   * Без него capabilities = {} (сервер без AI-контура — unit-тесты каркаса).
   */
  readonly getCapabilities?: () => Record<string, unknown>;
  /**
   * Зависимости HTTP-шлюза (промпт 1.10): с ними регистрируются ВСЕ маршруты
   * каталога HTTP_ROUTES + JWT-auth + единый error handler. Без них сервер
   * отдаёт только /health и /version (каркас 1.1, unit-тесты).
   */
  readonly httpGateway?: HttpGatewayDeps;
  /**
   * Зависимости WS-шлюза (промпт 1.11): /ws — handshake-auth, heartbeat,
   * router, проекции и доставка по WS_PRIVACY_POLICY. Handle доступен как
   * app.wsGateway (shutdown: closeAll до outbox drain).
   */
  readonly wsGateway?: WsGatewayDeps;
}

declare module 'fastify' {
  interface FastifyInstance {
    wsGateway?: WsGatewayHandle;
  }
}

export async function buildApp({
  config,
  logger,
  cwd = process.cwd(),
  persistence,
  getCapabilities,
  httpGateway,
  wsGateway,
}: BuildAppOptions) {
  const app = Fastify({
    loggerInstance: logger.child({ component: 'http' }),
    // traceId = x-request-id от клиента (если прислан) либо новый uuid.
    requestIdHeader: 'x-request-id',
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && incoming.length >= 8 && incoming.length <= 64 ? incoming : newTraceId();
    },
    // disableRequestLogging deprecated в fastify 5.12 (→ logController, будет удалён в fastify 6).
    // Не используем: подробность логов управляется LOG_LEVEL, а traceId проставляется через genReqId.
    trustProxy: config.isProduction,
    bodyLimit: 1_048_576, // 1 МБ (docs/SPEC_STAGE1.md §6.1)
  });

  await app.register(cors, {
    origin: corsOrigins(config),
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Глобальный лимит per IP; per-token и per-route лимиты — в промпте 1.10.
  await app.register(rateLimit, {
    global: true,
    max: config.limits.httpRatePerIpPerMin,
    timeWindow: '1 minute',
    // Заголовки x-ratelimit-* и Retry-After плагин добавляет сам.
    addHeadersOnExceeding: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true },
    errorResponseBuilder: (req, context) => ({
      error: {
        code: 'RATE_LIMIT',
        message: 'Too many requests',
        meta: { max: context.max, ttl: context.ttl },
        requestId: req.id,
      },
    }),
  });

  // Статика клиента (prod). В dev клиент отдаётся vite-сервером (промпт 1.12).
  const clientDist = resolve(cwd, 'client/dist');
  if (existsSync(clientDist)) {
    await app.register(fastifyStatic, { root: clientDist, prefix: '/' });
  }

  // Единый обработчик ошибок (промпт 1.10, п.3): AppError/ZodError →
  // HttpErrorBody по ERROR_TABLE, requestId всегда.
  app.setErrorHandler(createHttpErrorHandler(app.log));

  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `Route not found: ${req.method} ${req.url}`, requestId: req.id },
    });
  });

  app.get('/health', async () => {
    // db + schemaVersion — промпт 1.4; capabilities — registry.snapshot() (промпт 1.7, A1.13).
    const capabilities = getCapabilities ? getCapabilities() : {};
    if (!persistence) {
      return buildHealthPayload(config, CONTRACTS_VERSION, { capabilities, db: 'unknown', phase: 'no-db' });
    }
    const alive = await ping(persistence.handle.db);
    return buildHealthPayload(config, CONTRACTS_VERSION, {
      capabilities,
      db: alive ? 'ok' : 'degraded',
      schemaVersion: persistence.version.applied,
      phase: persistence.seed.created ? 'seeded' : 'ready',
    });
  });

  app.get('/version', async () => buildVersionPayload(config, CONTRACTS_VERSION));

  // Промпт 1.10: ВСЕ маршруты каталога HTTP_ROUTES (gateway), включая stage 2/3
  // заглушки (501) и /media/files/*. /health и /version остаются выше — они
  // владеют wiring-данными (db-ping, capabilities, версия пакета).
  if (httpGateway !== undefined) {
    // Каст типов: экземпляр создан с loggerInstance (pino) — его generic
    // логгера уже дефолтного FastifyBaseLogger; рантайм идентичен.
    await registerHttpRoutes(app as unknown as FastifyInstance, httpGateway);
  }

  // Промпт 1.11: WS-транспорт — /ws (auth-handshake, heartbeat, router,
  // broadcast по WS_PRIVACY_POLICY). Handle — для graceful shutdown (closeAll).
  if (wsGateway !== undefined) {
    app.wsGateway = await registerWsGateway(app as unknown as FastifyInstance, wsGateway);
  }

  return app;
}

function corsOrigins(config: AppConfig): string[] | boolean {
  const raw = config.env.CORS_ORIGIN;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (config.isProduction) {
    // В production без явного CORS_ORIGIN кросс-доменные запросы запрещены (v3 §VIII.3).
    return false;
  }
  return ['http://localhost:5173', 'http://127.0.0.1:5173'];
}
