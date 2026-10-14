import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { Logger } from 'pino';

import { CONTRACTS_VERSION } from '@mnemosin/contracts';
import { ping, type BootstrapResult } from '@mnemosin/database';
import type { AppConfig } from '@mnemosin/config';
import { newTraceId } from '@mnemosin/logging';

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
}

export async function buildApp({ config, logger, cwd = process.cwd(), persistence }: BuildAppOptions) {
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

  app.setErrorHandler((error: FastifyError, req, reply) => {
    const status = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    req.log.error({ err: error, traceId: req.id }, 'request_failed');
    void reply.status(status).send({
      error: {
        code: status === 500 ? 'INTERNAL' : 'VALIDATION',
        message: status === 500 ? 'Internal error' : error.message,
        requestId: req.id,
      },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `Route not found: ${req.method} ${req.url}`, requestId: req.id },
    });
  });

  app.get('/health', async () => {
    // db + schemaVersion — промпт 1.4; capabilities — промпт 1.7.
    if (!persistence) {
      return buildHealthPayload(config, CONTRACTS_VERSION, { db: 'unknown', phase: 'no-db' });
    }
    const alive = await ping(persistence.handle.db);
    return buildHealthPayload(config, CONTRACTS_VERSION, {
      db: alive ? 'ok' : 'degraded',
      schemaVersion: persistence.version.applied,
      phase: persistence.seed.created ? 'seeded' : 'ready',
    });
  });

  app.get('/version', async () => buildVersionPayload(config, CONTRACTS_VERSION));

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
