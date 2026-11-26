import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

import { PlayerId, SessionId } from '@mnemosin/contracts';
import { JwtService } from '@mnemosin/gateway-http';
import { registerDevQuickJoinRoute, type DevQuickJoinContext } from '@mnemosin/server';

/**
 * DEV-only `GET /dev/quick-join`.
 *
 * Проверяется ровно то, что важно локальному разработчику:
 *  - в dev маршрут отвечает 200 и выдаёт access-токены, которые проходят
 *    тот же `jwt.verify(token, 'access')`, что и WS handshake (`verifyWsToken`);
 *  - без seeded-сессии dev-маршрут отвечает 503, а не падает;
 *  - в production маршрут НЕ зарегистрирован (404) — секретов наружу нет.
 */

const SECRET = 'dev-quick-join-test-secret-0123456789abcdef0123456789';

const SESSION_ID = SessionId.parse('11111111-1111-4111-8111-111111111111');
const PLAYER_1 = PlayerId.parse('22222222-2222-4222-8222-222222222222');
const PLAYER_2 = PlayerId.parse('33333333-3333-4333-8333-333333333333');

function jwtService(): JwtService {
  return new JwtService({
    secret: SECRET,
    accessTtlSeconds: 3600,
    refreshTtlSeconds: 86_400,
  });
}

function context(): DevQuickJoinContext {
  return {
    sessionId: SESSION_ID,
    jwt: jwtService(),
    players: [
      { playerId: PLAYER_1, displayName: 'Игрок 1', characterName: 'Первый' },
      { playerId: PLAYER_2, displayName: 'Игрок 2', characterName: null },
    ],
  };
}

async function build(isProduction: boolean, devContext: DevQuickJoinContext | null): Promise<FastifyInstance> {
  const app = Fastify();
  registerDevQuickJoinRoute(app, { isProduction, context: devContext });
  await app.ready();
  return app;
}

describe('DEV-only GET /dev/quick-join', () => {
  it('в dev отвечает 200 и выдаёт валидные access-токены для двух игроков', async () => {
    const app = await build(false, context());
    try {
      const response = await app.inject({ method: 'GET', url: '/dev/quick-join' });
      expect(response.statusCode).toBe(200);

      const body = response.json() as {
        sessionId: string;
        players: { label: string; playerId: string; displayName: string; characterName: string; token: string }[];
      };
      expect(body.sessionId).toBe(SESSION_ID);
      expect(body.players).toHaveLength(2);
      expect(body.players[0]?.label).toBe('Player 1');
      expect(body.players[1]?.label).toBe('Player 2');
      expect(body.players[0]?.characterName).toBe('Первый');
      // characterName отсутствует у seeded-игрока → fallback на displayName.
      expect(body.players[1]?.characterName).toBe('Игрок 2');

      const jwt = jwtService();
      const claims1 = await jwt.verify(body.players[0]?.token ?? '', 'access');
      expect(claims1.sub).toBe(PLAYER_1);
      expect(claims1.sid).toBe(SESSION_ID);
      expect(claims1.gm).toBe(false);
      expect(claims1.typ).toBe('access');

      const claims2 = await jwt.verify(body.players[1]?.token ?? '', 'access');
      expect(claims2.sub).toBe(PLAYER_2);
      expect(claims2.sid).toBe(SESSION_ID);
      expect(claims2.gm).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('в dev без seeded-сессии отвечает 503 dev_seed_unavailable', async () => {
    const app = await build(false, null);
    try {
      const response = await app.inject({ method: 'GET', url: '/dev/quick-join' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'dev_seed_unavailable' });
    } finally {
      await app.close();
    }
  });

  it('в production маршрут не зарегистрирован — 404', async () => {
    const app = await build(true, context());
    try {
      const response = await app.inject({ method: 'GET', url: '/dev/quick-join' });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('регистрация в production возвращает false (маршрут не создан)', () => {
    const app = Fastify();
    expect(registerDevQuickJoinRoute(app, { isProduction: true, context: context() })).toBe(false);
    expect(registerDevQuickJoinRoute(app, { isProduction: false, context: null })).toBe(true);
  });
});
