import { rmSafe } from '../integration/helpers.js';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { loadConfig, type AppConfig } from '@mnemosin/config';
import { createLogger, type Logger } from '@mnemosin/logging';
import { buildApp } from '@mnemosin/server';

/**
 * Промпт 1.1, критерий A1.1: сервер собирается, /health и /version отвечают,
 * неизвестный маршрут отдаёт единый формат ошибки.
 *
 * Тест поднимает приложение in-process через app.inject() — без сети и без порта.
 * Живой процесс проверяется в tools/verify/stage1.mjs.
 */

const ROOT = process.cwd();

function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    cwd: ROOT,
    ignoreDotenv: true,
    version: '0.0.0-test',
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'file:./data/unit-test.sqlite',
      JWT_SECRET: 'app-test-secret-0123456789abcdef0123456789abcdef',
      LOG_LEVEL: 'silent',
      ...overrides,
    },
  });
}

describe('HTTP каркас (A1.1)', () => {
  let app: FastifyInstance;
  let logger: Logger;

  beforeAll(async () => {
    const config = testConfig();
    logger = createLogger({ config, name: 'test' });
    app = await buildApp({ config, logger, cwd: ROOT });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /health без БД → 200, db:unknown, phase:no-db (сервер жив и без БД, A1.1)', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['env']).toBe('test');
    expect(body['capabilities']).toEqual({}); // заполняется в промпте 1.7
    expect(body['db']).toBe('unknown'); // БД не передана в buildApp
    expect(body['phase']).toBe('no-db');
    expect(body['schemaVersion']).toBeNull();
    expect(typeof body['contractsVersion']).toBe('string');
    expect(typeof body['uptime']).toBe('number');
  });

  it('GET /health с подключённой БД → db:ok и schemaVersion (промпт 1.4)', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { bootstrapDatabase } = await import('@mnemosin/database');

    const config = testConfig();
    const logger = createLogger({ config, name: 'test-health' });
    const dir = mkdtempSync(join(tmpdir(), 'mnemosin-health-'));
    const persistence = await bootstrapDatabase({ url: `file:${join(dir, 'health.sqlite')}` });
    const appWithDb = await buildApp({ config, logger, cwd: ROOT, persistence });
    await appWithDb.ready();

    const res = await appWithDb.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['db']).toBe('ok');
    expect(body['schemaVersion']).toBe(1);
    expect(['seeded', 'ready']).toContain(body['phase']);

    await appWithDb.close();
    await persistence.close();
    rmSafe(dir);
  });

  it('GET /version → version + contractsVersion + node', async () => {
    const res = await app.inject({ method: 'GET', url: '/version' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['version']).toBe('0.0.0-test');
    expect(body['node']).toBe(process.version);
  });

  it('неизвестный маршрут → 404 в едином формате ошибки', async () => {
    const res = await app.inject({ method: 'GET', url: '/no-such-route' });

    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string; message: string; requestId: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBeTruthy();
  });

  it('x-request-id клиента становится traceId и возвращается в ошибке', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/no-such-route',
      headers: { 'x-request-id': 'trace-id-from-client-0001' },
    });

    const body = res.json() as { error: { requestId: string } };
    expect(body.error.requestId).toBe('trace-id-from-client-0001');
  });

  it('в ответах /health и /version нет секретов', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    const version = await app.inject({ method: 'GET', url: '/version' });
    const combined = `${health.body}${version.body}`;

    expect(combined).not.toContain('app-test-secret');
    expect(combined.toLowerCase()).not.toContain('jwt_secret');
  });
});
