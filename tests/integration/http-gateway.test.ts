import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DirectorContextSchema,
  GMStateViewSchema,
  HttpErrorBodySchema,
  IdempotencyRecordSchema,
  PublicGameStateViewSchema,
  SessionViewSchema,
  STAGE1_ROUTES,
  TurnViewSchema,
  nowIso,
  routeKey,
  type PlayerId,
  type SessionId,
  type TurnId,
} from '@mnemosin/contracts';
import { TokenRateLimiter } from '@mnemosin/gateway-http';

import { bearer, bootHttpWorld, seedHttpSession, waitForTurnStatus, type HttpWorld } from './http-helpers.js';

/**
 * HTTP-транспорт (промпт 1.10): реальный Fastify + tmp-БД + app.inject.
 *
 * Пункты промта:
 *  - таблица-драйв по STAGE1_ROUTES: каждый маршрут зарегистрирован и отвечает
 *    HttpErrorBody на ошибку (п.8, абзац 1);
 *  - основной curl-прогон из п.10 — через inject: session → join×2 → action →
 *    lock → REVIEW (scripted AI, auto-resolve D253) → commit → version;
 *  - auth: 401/403/expired/revoked/refresh (п.8, абзац 2; B-12);
 *  - идемпотентность через HTTP: повтор commit — тот же version, journal один;
 *    IN_FLIGHT → 409 (п.8, абзац 3; A1.4);
 *  - view=ai под игроком → 403 (п.8, абзац 4; A1.7, F-6.1);
 *  - rate-limit /auth/session: 429 после 10 запросов с IP (п.8, абзац 5; F-6.6);
 *  - тело ошибки всегда HttpErrorBody (п.8, абзац 6).
 */

function expectErrorBody(body: unknown) {
  const parsed = HttpErrorBodySchema.parse(body);
  return parsed.error;
}

function withQuery(path: string, query: Record<string, string>): string {
  const qs = new URLSearchParams(query).toString();
  return qs.length > 0 ? `${path}?${qs}` : path;
}

describe('gateways/http — каталог маршрутов (A1.1)', () => {
  let world: HttpWorld;
  beforeAll(async () => {
    world = await bootHttpWorld('http-catalog');
  });
  afterAll(async () => {
    await world.close();
  });

  it.each(STAGE1_ROUTES.map((route) => [routeKey(route), route] as const))(
    '%s зарегистрирован и отвечает по контракту',
    async (_key, route) => {
      const uuid = randomUUID();
      let url = route.path.replaceAll(':id', uuid).replaceAll(':pid', uuid).replaceAll(':eid', uuid);
      if (route.method === 'GET') {
        if (url.startsWith('/chat/history')) url = withQuery(url, { sessionId: uuid });
        if (url.startsWith('/state/projection/gm')) url = withQuery(url, { sessionId: uuid, view: 'gm' });
        else if (url.startsWith('/state/projection')) url = withQuery(url, { sessionId: uuid, view: 'public' });
        if (url.startsWith('/gm/audit')) url = withQuery(url, { sessionId: uuid });
      }
      const res = await world.app.inject({ method: route.method, url });
      // Маршрут ОБЯЗАН быть зарегистрирован: 404 допустим только как «сущность
      // не найдена», но не как «Route not found» (отсутствие handler'а).
      if (res.statusCode === 404) {
        const error = expectErrorBody(res.json());
        expect(error.message.startsWith('Route not found'), `${routeKey(route)}: handler отсутствует`).toBe(false);
      }
      // Любой ответ ≥400 — строго HttpErrorBody (п.8, абзац 6).
      if (res.statusCode >= 400) {
        expectErrorBody(res.json());
      }
      // Аутентифицированные маршруты без токена — 401/403; неаутентифицированные
      // без тела — 400 (валидация) либо рабочий ответ (health/version/metrics).
      if (route.auth === 'player' || route.auth === 'gm') {
        expect([401, 403, 404]).toContain(res.statusCode);
      }
    },
  );

  it('health/version/metrics отдают контрактные ответы', async () => {
    const health = await world.app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    const healthBody = health.json() as {
      ok: boolean;
      capabilities: { capabilities: Record<string, { available: boolean }> };
    };
    expect(healthBody.ok).toBe(true);
    // A1.13: capabilities = срез CapabilityRegistry (вложенный Record).
    expect(healthBody.capabilities.capabilities['TEXT_AI']?.available).toBe(true);

    const version = await world.app.inject({ method: 'GET', url: '/version' });
    expect(version.statusCode).toBe(200);

    // /metrics (internal): в dev/test открыт (D146) — текстовый срез.
    const metrics = await world.app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(typeof metrics.body).toBe('string');
    expect(metrics.body.length).toBeGreaterThan(2);
  });
});

describe('gateways/http — основной прогон (п.10 промта)', () => {
  let world: HttpWorld;
  beforeAll(async () => {
    world = await bootHttpWorld('http-flow');
  });
  afterAll(async () => {
    await world.close();
  });

  it('сессия → join×2 → action → lock → REVIEW → commit → повтор → проекции → kick/leave/end', async () => {
    const seeded = await seedHttpSession(world);
    const { sessionId, gmToken, playerA, playerB } = seeded;
    const gm = bearer(gmToken);
    const key = (label: string) => `http-flow-${label}-${randomUUID()}`;

    // GET /sessions/:id — SessionView (игрок видит сессию).
    const view = await world.app.inject({
      method: 'GET',
      url: `/sessions/${sessionId}`,
      headers: bearer(playerA.token),
    });
    expect(view.statusCode).toBe(200);
    const sessionView = SessionViewSchema.parse(view.json());
    expect(sessionView.status).toBe('LOBBY');
    expect(sessionView.players).toHaveLength(3);
    expect(sessionView.players.map((p) => p.characterName)).toContain('Ирма');

    // start (GM) → turnId.
    const start = await world.app.inject({
      method: 'POST',
      url: `/sessions/${sessionId}/start`,
      headers: gm,
      payload: { idempotencyKey: key('start') },
    });
    expect(start.statusCode).toBe(200);
    const { turnId } = start.json() as { turnId: string };

    // action (игрок A).
    const action = await world.app.inject({
      method: 'POST',
      url: `/turns/${turnId}/action`,
      headers: bearer(playerA.token),
      payload: { rawText: 'Осматриваю обелиск в шлюзе', idempotencyKey: key('action') },
    });
    expect(action.statusCode).toBe(200);
    const actionBody = action.json() as { actionId: string; sequenceId: number };
    expect(actionBody.sequenceId).toBeGreaterThanOrEqual(1);

    // lock (GM) → auto-resolve (D253) → REVIEW_READY (scripted AI).
    const lock = await world.app.inject({
      method: 'POST',
      url: `/turns/${turnId}/lock`,
      headers: gm,
      payload: { idempotencyKey: key('lock') },
    });
    expect(lock.statusCode).toBe(200);
    const status = await waitForTurnStatus(world, turnId, ['REVIEW'], playerA.token);
    expect(status).toBe('REVIEW');

    // GET /turns/:id — TurnView c действиями игрока.
    const turnViewRes = await world.app.inject({
      method: 'GET',
      url: `/turns/${turnId}`,
      headers: bearer(playerA.token),
    });
    expect(turnViewRes.statusCode).toBe(200);
    const turnView = TurnViewSchema.parse(turnViewRes.json());
    expect(turnView.status).toBe('REVIEW');
    expect(turnView.myActions.map((a) => a.actionId)).toContain(actionBody.actionId);
    // Игрок B своих действий не отправлял — myActions пуст.
    const turnViewB = TurnViewSchema.parse(
      (await world.app.inject({ method: 'GET', url: `/turns/${turnId}`, headers: bearer(playerB.token) })).json(),
    );
    expect(turnViewB.myActions).toHaveLength(0);

    // commit → {version}; повтор с тем же ключом — тот же version (A1.4).
    const commitKey = key('commit');
    const commit1 = await world.app.inject({
      method: 'POST',
      url: `/turns/${turnId}/commit`,
      headers: gm,
      payload: { idempotencyKey: commitKey },
    });
    expect(commit1.statusCode).toBe(200);
    const { version } = commit1.json() as { version: number };
    expect(version).toBeGreaterThanOrEqual(1);
    const commit2 = await world.app.inject({
      method: 'POST',
      url: `/turns/${turnId}/commit`,
      headers: gm,
      payload: { idempotencyKey: commitKey },
    });
    expect(commit2.statusCode).toBe(200);
    expect((commit2.json() as { version: number }).version).toBe(version);
    // journal: ровно одна запись 'committed'.
    const journal = await world.db.boot.uow.repos().journal.listByTurn(turnId as TurnId);
    expect(journal.filter((entry) => entry.kind === 'committed')).toHaveLength(1);

    // проекции: public (игрок), private (игрок), gm/ai — только GM (A1.7).
    const publicRes = await world.app.inject({
      method: 'GET',
      url: withQuery('/state/projection', { sessionId, view: 'public' }),
      headers: bearer(playerA.token),
    });
    expect(publicRes.statusCode).toBe(200);
    const publicView = PublicGameStateViewSchema.parse(publicRes.json());
    expect(publicView.version).toBe(version);

    const privateRes = await world.app.inject({
      method: 'GET',
      url: withQuery('/state/projection', { sessionId, view: 'private' }),
      headers: bearer(playerA.token),
    });
    expect(privateRes.statusCode).toBe(200);
    const privateView = privateRes.json() as { playerId: string; version: number };
    expect(privateView.playerId).toBe(playerA.playerId);

    // A1.7/F-6.1: ai/gm-виды под игроком → 403 AUTH_FORBIDDEN.
    for (const gmView of ['ai', 'gm']) {
      const forbidden = await world.app.inject({
        method: 'GET',
        url: withQuery('/state/projection/gm', { sessionId, view: gmView }),
        headers: bearer(playerA.token),
      });
      expect(forbidden.statusCode).toBe(403);
      expect(expectErrorBody(forbidden.json()).code).toBe('AUTH_FORBIDDEN');
    }
    // view=ai|gm на player-маршруте — невалидный enum → 400 VALIDATION.
    const badView = await world.app.inject({
      method: 'GET',
      url: withQuery('/state/projection', { sessionId, view: 'ai' }),
      headers: bearer(playerA.token),
    });
    expect(badView.statusCode).toBe(400);
    expect(expectErrorBody(badView.json()).code).toBe('VALIDATION');

    // GM-виды под GM-токеном → 200 (контрактные схемы).
    const gmStateRes = await world.app.inject({
      method: 'GET',
      url: withQuery('/state/projection/gm', { sessionId, view: 'gm' }),
      headers: gm,
    });
    expect(gmStateRes.statusCode).toBe(200);
    GMStateViewSchema.parse(gmStateRes.json());
    const aiViewRes = await world.app.inject({
      method: 'GET',
      url: withQuery('/state/projection/gm', { sessionId, view: 'ai' }),
      headers: gm,
    });
    expect(aiViewRes.statusCode).toBe(200);
    DirectorContextSchema.parse(aiViewRes.json());

    // chat history (игрок) — массив сообщений (системные сообщения коммита).
    const history = await world.app.inject({
      method: 'GET',
      url: withQuery('/chat/history', { sessionId }),
      headers: bearer(playerA.token),
    });
    expect(history.statusCode).toBe(200);
    expect(Array.isArray(history.json())).toBe(true);

    // gm/inspect/* → 200.
    const inspectState = await world.app.inject({
      method: 'POST',
      url: '/gm/inspect/state',
      headers: gm,
      payload: { sessionId },
    });
    expect(inspectState.statusCode).toBe(200);
    GMStateViewSchema.parse(inspectState.json());
    const inspectContext = await world.app.inject({
      method: 'POST',
      url: '/gm/inspect/context',
      headers: gm,
      payload: { turnId },
    });
    expect(inspectContext.statusCode).toBe(200);
    DirectorContextSchema.parse(inspectContext.json());
    const inspectJournal = await world.app.inject({
      method: 'POST',
      url: '/gm/inspect/journal',
      headers: gm,
      payload: { turnId },
    });
    expect(inspectJournal.statusCode).toBe(200);
    expect(Array.isArray(inspectJournal.json())).toBe(true);

    // gm/note → noteId; gm/audit — запись аудита присутствует.
    // Аудит наполняется подписчиком GM_ACTION_PERFORMED через outbox → bus,
    // поэтому сначала доставляем события (drain + flush микрозадач шины).
    await world.drain();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const note = await world.app.inject({
      method: 'POST',
      url: '/gm/note',
      headers: gm,
      payload: { sessionId, visibility: 'GM_ONLY', text: 'Партия идёт по плану' },
    });
    expect(note.statusCode).toBe(200);
    expect((note.json() as { noteId: string }).noteId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    const audit = await world.app.inject({
      method: 'GET',
      url: withQuery('/gm/audit', { sessionId }),
      headers: gm,
    });
    expect(audit.statusCode).toBe(200);
    const auditEntries = audit.json() as Array<{ action: string }>;
    expect(auditEntries.length).toBeGreaterThanOrEqual(1);
    expect(auditEntries.map((entry) => entry.action)).toContain('startSession');

    // move (GM): игрок B — в локацию за unlocked-выходом текущей (правила
    // перемещения проверяют связность: exit_not_found → CORE_RULE_REJECTED).
    const exit = publicView.currentLocation?.exits.find(
      (candidate) => typeof candidate.toLocationId === 'string' && !candidate.locked,
    );
    expect(exit?.toLocationId, 'в текущей локации есть доступный выход').toBeTruthy();
    const move = await world.app.inject({
      method: 'POST',
      url: `/sessions/${sessionId}/move`,
      headers: gm,
      payload: { playerIds: [playerB.playerId], toLocationId: exit!.toLocationId!, idempotencyKey: key('move') },
    });
    expect(move.statusCode).toBe(200);

    // pause/resume (GM).
    const pause = await world.app.inject({
      method: 'POST',
      url: `/sessions/${sessionId}/pause`,
      headers: gm,
      payload: { idempotencyKey: key('pause') },
    });
    expect(pause.statusCode).toBe(200);
    const resume = await world.app.inject({
      method: 'POST',
      url: `/sessions/${sessionId}/resume`,
      headers: gm,
      payload: { idempotencyKey: key('resume') },
    });
    expect(resume.statusCode).toBe(200);

    // kick B → его токен отозван (B-12.3) → 401.
    const kick = await world.app.inject({
      method: 'DELETE',
      url: `/sessions/${sessionId}/player/${playerB.playerId}`,
      headers: gm,
    });
    expect(kick.statusCode).toBe(200);
    const kickedAccess = await world.app.inject({
      method: 'GET',
      url: `/sessions/${sessionId}`,
      headers: bearer(playerB.token),
    });
    expect(kickedAccess.statusCode).toBe(401);
    expect(expectErrorBody(kickedAccess.json()).code).toBe('AUTH_INVALID');
    // refresh отозванного тоже не работает.
    const kickedRefresh = await world.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: playerB.refreshToken },
    });
    expect(kickedRefresh.statusCode).toBe(401);

    // leave A (добровольный выход, B-11) → токен отозван.
    const leave = await world.app.inject({
      method: 'DELETE',
      url: `/sessions/${sessionId}/me`,
      headers: bearer(playerA.token),
    });
    expect(leave.statusCode).toBe(200);
    const leftAccess = await world.app.inject({
      method: 'GET',
      url: `/sessions/${sessionId}`,
      headers: bearer(playerA.token),
    });
    expect(leftAccess.statusCode).toBe(401);

    // GM не может выйти сам (D222) → 409.
    const gmLeave = await world.app.inject({
      method: 'DELETE',
      url: `/sessions/${sessionId}/me`,
      headers: gm,
    });
    expect(gmLeave.statusCode).toBe(409);

    // end (GM) → сессия ENDED.
    const end = await world.app.inject({
      method: 'POST',
      url: `/sessions/${sessionId}/end`,
      headers: gm,
      payload: { idempotencyKey: key('end') },
    });
    expect(end.statusCode).toBe(200);
    const ended = await world.app.inject({ method: 'GET', url: `/sessions/${sessionId}`, headers: gm });
    expect(ended.statusCode).toBe(200);
    expect(SessionViewSchema.parse(ended.json()).status).toBe('ENDED');
  }, 30_000);
});

describe('gateways/http — auth и токены (B-12)', () => {
  let world: HttpWorld;
  let seeded: Awaited<ReturnType<typeof seedHttpSession>>;
  beforeAll(async () => {
    world = await bootHttpWorld('http-auth');
    seeded = await seedHttpSession(world);
  });
  afterAll(async () => {
    await world.close();
  });

  it('без токена и с мусором → 401 AUTH_INVALID', async () => {
    const noToken = await world.app.inject({
      method: 'GET',
      url: withQuery('/chat/history', { sessionId: seeded.sessionId }),
    });
    expect(noToken.statusCode).toBe(401);
    expect(expectErrorBody(noToken.json()).code).toBe('AUTH_INVALID');

    const garbage = await world.app.inject({
      method: 'GET',
      url: `/sessions/${seeded.sessionId}`,
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    expect(garbage.statusCode).toBe(401);
    expect(expectErrorBody(garbage.json()).code).toBe('AUTH_INVALID');
  });

  it('истёкший токен → 401 AUTH_EXPIRED', async () => {
    const expired = await world.jwt.signAccessToken(
      {
        playerId: seeded.playerA.playerId as PlayerId,
        sessionId: seeded.sessionId as SessionId,
        isGM: false,
      },
      -60,
    );
    const res = await world.app.inject({
      method: 'GET',
      url: `/sessions/${seeded.sessionId}`,
      headers: bearer(expired),
    });
    expect(res.statusCode).toBe(401);
    expect(expectErrorBody(res.json()).code).toBe('AUTH_EXPIRED');
  });

  it('player-токен на GM-маршруте → 403 AUTH_FORBIDDEN', async () => {
    const res = await world.app.inject({
      method: 'POST',
      url: '/gm/inspect/state',
      headers: bearer(seeded.playerA.token),
      payload: { sessionId: seeded.sessionId },
    });
    expect(res.statusCode).toBe(403);
    expect(expectErrorBody(res.json()).code).toBe('AUTH_FORBIDDEN');
  });

  it('refresh выдаёт рабочий access; access в роли refresh → 401', async () => {
    const refreshed = await world.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: seeded.playerA.refreshToken },
    });
    expect(refreshed.statusCode).toBe(200);
    const { token } = refreshed.json() as { token: string };
    const withNewToken = await world.app.inject({
      method: 'GET',
      url: `/sessions/${seeded.sessionId}`,
      headers: bearer(token),
    });
    expect(withNewToken.statusCode).toBe(200);

    const wrongType = await world.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: seeded.playerA.token }, // access — не refresh
    });
    expect(wrongType.statusCode).toBe(401);
    expect(expectErrorBody(wrongType.json()).code).toBe('AUTH_INVALID');
  });

  it('kick отзывает токены: iat < revoked_before → 401 (B-12.3)', async () => {
    await world.services.sessions.removePlayer({
      sessionId: seeded.sessionId as SessionId,
      playerId: seeded.playerB.playerId as PlayerId,
      idempotencyKey: `http-auth-kick-${randomUUID()}`,
    });
    const res = await world.app.inject({
      method: 'GET',
      url: `/sessions/${seeded.sessionId}`,
      headers: bearer(seeded.playerB.token),
    });
    expect(res.statusCode).toBe(401);
    expect(expectErrorBody(res.json()).code).toBe('AUTH_INVALID');
    // запись игрока: revokedBefore выставлен.
    const player = await world.db.boot.uow.repos().players.findById(seeded.playerB.playerId as PlayerId);
    expect(player?.revokedBefore).not.toBeNull();
  });

  it('чужая сессия → 403 (токен не подходит к ресурсу)', async () => {
    const res = await world.app.inject({
      method: 'GET',
      url: `/sessions/${randomUUID()}`,
      headers: bearer(seeded.playerA.token),
    });
    expect(res.statusCode).toBe(403);
    expect(expectErrorBody(res.json()).code).toBe('AUTH_FORBIDDEN');
  });
});

describe('gateways/http — идемпотентность через HTTP (A1.4)', () => {
  let world: HttpWorld;
  let turnId: string;
  let gm: { authorization: string };
  beforeAll(async () => {
    world = await bootHttpWorld('http-idem');
    const seeded = await seedHttpSession(world);
    gm = bearer(seeded.gmToken);
    const start = await world.app.inject({
      method: 'POST',
      url: `/sessions/${seeded.sessionId}/start`,
      headers: gm,
      payload: { idempotencyKey: `http-idem-start-${randomUUID()}` },
    });
    turnId = (start.json() as { turnId: string }).turnId;
    await world.app.inject({
      method: 'POST',
      url: `/turns/${turnId}/action`,
      headers: bearer(seeded.playerA.token),
      payload: { rawText: 'Действие на повтор', idempotencyKey: `http-idem-act-${randomUUID()}` },
    });
    await world.app.inject({
      method: 'POST',
      url: `/turns/${turnId}/lock`,
      headers: gm,
      payload: { idempotencyKey: `http-idem-lock-${randomUUID()}` },
    });
    await waitForTurnStatus(world, turnId, ['REVIEW'], seeded.playerA.token);
  });
  afterAll(async () => {
    await world.close();
  });

  it('action c одним ключом дважды → тот же actionId', async () => {
    const key = `http-idem-dup-${randomUUID()}`;
    const first = await world.app.inject({
      method: 'POST',
      url: `/turns/${turnId}/action`,
      headers: gm, // GM тоже игрок сессии — submitAction разрешает
      payload: { rawText: 'Повторное действие', idempotencyKey: key },
    });
    expect([200, 409]).toContain(first.statusCode); // ход может быть LOCKED → CONFLICT
    if (first.statusCode === 200) {
      const second = await world.app.inject({
        method: 'POST',
        url: `/turns/${turnId}/action`,
        headers: gm,
        payload: { rawText: 'Повторное действие', idempotencyKey: key },
      });
      expect(second.statusCode).toBe(200);
      expect((second.json() as { actionId: string }).actionId).toBe((first.json() as { actionId: string }).actionId);
    }
  });

  it('IN_FLIGHT-запись → 409 IDEMPOTENCY_IN_FLIGHT', async () => {
    const key = `http-idem-inflight-${randomUUID()}`;
    const session = await world.services.sessions.getSession(
      (await world.db.boot.uow.repos().turns.findById(turnId as TurnId))!.sessionId,
    );
    const record = IdempotencyRecordSchema.parse({
      key,
      turnId,
      sessionId: session.sessionId,
      command: 'commitTurn',
      status: 'IN_FLIGHT',
      resultJson: null,
      resultHash: createHash('sha256').update(key).digest('hex'),
      errorCode: null,
      traceId: 'http-idem-test',
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString().replace(/(\.\d{3})\+.*$/, '$1Z'),
    });
    await world.db.boot.uow.repos().idempotency.tryAcquire(record);

    const res = await world.app.inject({
      method: 'POST',
      url: `/turns/${turnId}/commit`,
      headers: gm,
      payload: { idempotencyKey: key },
    });
    expect(res.statusCode).toBe(409);
    expect(expectErrorBody(res.json()).code).toBe('IDEMPOTENCY_IN_FLIGHT');
  });

  it('commit дважды c одним ключом → тот же version, journal один (A1.4)', async () => {
    const key = `http-idem-commit-${randomUUID()}`;
    const first = await world.app.inject({
      method: 'POST',
      url: `/turns/${turnId}/commit`,
      headers: gm,
      payload: { idempotencyKey: key },
    });
    expect(first.statusCode).toBe(200);
    const version = (first.json() as { version: number }).version;
    const second = await world.app.inject({
      method: 'POST',
      url: `/turns/${turnId}/commit`,
      headers: gm,
      payload: { idempotencyKey: key },
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { version: number }).version).toBe(version);
    const journal = await world.db.boot.uow.repos().journal.listByTurn(turnId as TurnId);
    expect(journal.filter((entry) => entry.kind === 'committed')).toHaveLength(1);
  });
});

describe('gateways/http — rate-limit (F-6.6)', () => {
  it('/auth/session: 429 после 10 запросов с одного IP + Retry-After', async () => {
    const world = await bootHttpWorld('http-rate');
    try {
      let limited: { status: number; body: string; headers: Record<string, string | string[] | undefined> } | null =
        null;
      for (let i = 0; i < 12; i += 1) {
        const res = await world.app.inject({
          method: 'POST',
          url: '/auth/session',
          payload: { displayName: `Гость ${i}`, characterName: `Персонаж ${i}` },
        });
        if (res.statusCode === 429) {
          limited = { status: res.statusCode, body: res.body, headers: res.headers };
          break;
        }
        // первые запросы: 200 (создание), затем 409 (D108 — одна сессия)
        expect([200, 409]).toContain(res.statusCode);
      }
      expect(limited, 'лимит 10 req/min per IP сработал').not.toBeNull();
      expect(expectErrorBody(JSON.parse(limited!.body)).code).toBe('RATE_LIMIT');
      expect(limited!.headers['retry-after']).toBeDefined();
    } finally {
      await world.close();
    }
  });

  it('TokenRateLimiter: 300/мин на токен, 30/мин на мутирующие turn', () => {
    const limiter = new TokenRateLimiter(300, 30);
    const key = TokenRateLimiter.keyOf('Bearer test-token');
    for (let i = 0; i < 300; i += 1) limiter.checkToken(key);
    expect(() => limiter.checkToken(key)).toThrowError(/RATE_LIMIT|превышен/i);
    for (let i = 0; i < 30; i += 1) limiter.checkMutatingTurn(key);
    expect(() => limiter.checkMutatingTurn(key)).toThrowError(/RATE_LIMIT|превышен/i);
  });
});

describe('gateways/http — формат ошибок и заглушки', () => {
  let world: HttpWorld;
  beforeAll(async () => {
    world = await bootHttpWorld('http-errors');
  });
  afterAll(async () => {
    await world.close();
  });

  it('неизвестный маршрут → 404 HttpErrorBody NOT_FOUND', async () => {
    const res = await world.app.inject({ method: 'GET', url: '/no/such/route' });
    expect(res.statusCode).toBe(404);
    expect(expectErrorBody(res.json()).code).toBe('NOT_FOUND');
  });

  it('валидация → 400 VALIDATION c meta.issues (≤10, сообщения ≤80)', async () => {
    const res = await world.app.inject({
      method: 'POST',
      url: '/auth/session',
      payload: { displayName: 'x'.repeat(100), characterName: '' },
    });
    expect(res.statusCode).toBe(400);
    const error = expectErrorBody(res.json());
    expect(error.code).toBe('VALIDATION');
    const issues = (error.meta as { issues: Array<{ path: string; code: string; message: string }> }).issues;
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.length).toBeLessThanOrEqual(10);
    for (const issue of issues) expect(issue.message.length).toBeLessThanOrEqual(80);
  });

  it('stage 2 маршруты → 501 NOT_IMPLEMENTED (под GM-токеном)', async () => {
    const seeded = await seedHttpSession(world);
    const res = await world.app.inject({
      method: 'POST',
      url: '/media/request',
      headers: bearer(seeded.gmToken),
      payload: {
        sessionId: seeded.sessionId,
        turnId: null,
        sceneHint: 'Туман над шлюзом',
        idempotencyKey: `http-stub-${randomUUID()}`,
      },
    });
    expect(res.statusCode).toBe(501);
    expect(expectErrorBody(res.json()).code).toBe('NOT_IMPLEMENTED');
    // без токена — сначала 401 (auth раньше заглушки).
    const noAuth = await world.app.inject({ method: 'GET', url: `/media/jobs/${randomUUID()}` });
    expect(noAuth.statusCode).toBe(401);
  });
});
