import { createHash, randomUUID } from 'node:crypto';

import {
  AppError,
  type GmAuditEntry,
  type JournalEntry,
  type PlayerId,
  type SessionId,
  type TurnId,
} from '@mnemosin/contracts';
import { HTTP_ROUTES, routeKey, type RouteContract, type RouteKey } from '@mnemosin/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { makeAuthHook, assertSameSession, requireAuthOf, type RequestAuth } from './auth/middleware.js';
import type { HttpGatewayDeps } from './deps.js';
import { TokenRateLimiter } from './rate-limit.js';
import { registerMediaFilesRoute } from './media.js';

/**
 * Регистрация ВСЕХ маршрутов из contracts HTTP_ROUTES (промпт 1.10, п.2).
 *
 * Маршруты НЕ объявляются заново: перебирается каталог HTTP_ROUTES, для каждого
 * берутся method/path/auth/request/response; обработка — единая (п.2):
 *   requireAuth(route.auth) → Zod-парсинг входа (params/query/body) → вызов
 *   команды модуля с idempotencyKey → Zod-парсинг ответа → reply.
 * Маршруты stage 2/3 зарегистрированы, но отдают 501 NOT_IMPLEMENTED
 * («маршруты объявлены» — до реализации в этапах 2–3).
 * /health и /version владеет app.ts (wiring: db-ping, capabilities, версия).
 *
 * Инвариант 14: здесь только парсинг, авторизация, вызов команд и сериализация.
 */

interface RouteContext {
  readonly req: FastifyRequest;
  readonly reply: FastifyReply;
  readonly deps: HttpGatewayDeps;
  /** null на маршрутах auth:'none' (там handlers его не используют). */
  readonly auth: RequestAuth | null;
  readonly traceId: string;
  readonly input: Record<string, unknown>;
  readonly params: Record<string, string>;
}

interface RouteResult {
  readonly body: unknown;
  readonly status?: number;
}

type RouteImpl = (ctx: RouteContext) => Promise<RouteResult>;

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** Маршруты с отдельным лимитом 10 req/min per IP (F-6.6: /auth/* и join). */
const AUTH_IP_LIMITED: ReadonlySet<RouteKey> = new Set<RouteKey>([
  'POST /auth/session',
  'POST /auth/refresh',
  'POST /sessions/:id/join',
]);

/** Мутирующие turn-маршруты: 30 req/min на токен. */
const MUTATING_TURN = /^\/turns\/[^/]+\/(action|lock|unlock|cancel|commit|edit-approve|reject|retry)/;

/** Аутентификация маршрута (гарантирована preHandler'ом для player/gm). */
function authOf(ctx: RouteContext): RequestAuth {
  if (ctx.auth === null) {
    throw new AppError('AUTH_INVALID', 'маршрут требует аутентификации', { reason: 'no_auth' });
  }
  return ctx.auth;
}

const ok = (body: unknown): RouteResult => ({ body });
const EMPTY = ok({});

// ---------------------------------------------------------------- handlers

const ROUTE_IMPL: Readonly<Partial<Record<RouteKey, RouteImpl>>> = {
  // --- auth / сессия -------------------------------------------------------
  'POST /auth/session': async (ctx) => {
    const input = ctx.input as { displayName: string; characterName: string; title?: string };
    // Клиентского ключа нет (неаутентифицированный маршрут) — уникальный серверный;
    // защита от дублей — D108 (вторая живая сессия → CONFLICT).
    const created = await ctx.deps.sessions.createSession({
      title: (input.title ?? `Партия ${input.displayName}`).slice(0, 120),
      gmDisplayName: input.displayName,
      characterName: input.characterName,
      idempotencyKey: `auth-session:${randomUUID()}`,
      traceId: ctx.traceId,
    });
    const tokens = await ctx.deps.jwt.issue({
      playerId: created.gmPlayerId,
      sessionId: created.sessionId,
      isGM: true,
    });
    return ok({
      sessionId: created.sessionId,
      playerId: created.gmPlayerId,
      token: tokens.token,
      refreshToken: tokens.refreshToken,
    });
  },

  'POST /auth/refresh': async (ctx) => {
    const input = ctx.input as { refreshToken: string };
    const claims = await ctx.deps.jwt.verify(input.refreshToken, 'refresh');
    const player = await ctx.deps.players.findById(claims.sub as PlayerId);
    if (player === null || player.sessionId !== claims.sid) {
      throw new AppError('AUTH_INVALID', 'refresh-токен: игрок или сессия не найдены', { reason: 'unknown_subject' });
    }
    if (player.revokedBefore !== null && claims.iat * 1000 < Date.parse(player.revokedBefore)) {
      throw new AppError('AUTH_INVALID', 'refresh-токен отозван', { reason: 'revoked' });
    }
    const token = await ctx.deps.jwt.issueAccess({
      playerId: player.playerId,
      sessionId: player.sessionId,
      isGM: player.isGM,
    });
    return ok({ token });
  },

  // D122: /auth/session — основной маршрут создания (без токена, создаёт GM);
  // POST /sessions — алиас для уже аутентифицированного GM (например, архивация
  // и новая партия тем же ведущим). Различие задокументировано в ARCHITECTURE §1.13.
  'POST /sessions': async (ctx) => {
    const input = ctx.input as { title: string; idempotencyKey: string };
    const player = await ctx.deps.players.findById(authOf(ctx).playerId);
    if (player === null) {
      throw new AppError('AUTH_INVALID', 'игрок токена не найден', { reason: 'unknown_subject' });
    }
    const created = await ctx.deps.sessions.createSession({
      title: input.title,
      gmDisplayName: player.displayName,
      idempotencyKey: input.idempotencyKey,
      traceId: ctx.traceId,
    });
    return ok({ sessionId: created.sessionId });
  },

  'POST /sessions/:id/join': async (ctx) => {
    const sessionId = ctx.params['id'] as SessionId;
    const input = ctx.input as { displayName: string; characterName: string };
    // Ключ детерминирован из содержимого: двойной клик не создаёт второго игрока.
    const joined = await ctx.deps.sessions.joinSession({
      sessionId,
      displayName: input.displayName,
      characterName: input.characterName,
      idempotencyKey: `join:${sha1(`${sessionId}:${input.displayName}:${input.characterName}`)}`,
      traceId: ctx.traceId,
    });
    const tokens = await ctx.deps.jwt.issue({ playerId: joined.playerId, sessionId, isGM: false });
    return ok({
      playerId: joined.playerId,
      characterId: joined.characterId,
      token: tokens.token,
      refreshToken: tokens.refreshToken,
    });
  },

  'GET /sessions/:id': async (ctx) => {
    const sessionId = ctx.params['id'] as SessionId;
    assertSameSession(authOf(ctx), sessionId);
    return ok(await ctx.deps.projections.sessionView(sessionId));
  },

  'POST /sessions/:id/start': async (ctx) => {
    const sessionId = ctx.params['id'] as SessionId;
    assertSameSession(authOf(ctx), sessionId);
    const input = ctx.input as { idempotencyKey: string };
    const started = await ctx.deps.gm.startSession({
      sessionId,
      gmPlayerId: authOf(ctx).playerId,
      idempotencyKey: input.idempotencyKey,
      traceId: ctx.traceId,
    });
    return ok({ turnId: started.turnId });
  },

  'POST /sessions/:id/pause': async (ctx) => {
    const sessionId = ctx.params['id'] as SessionId;
    assertSameSession(authOf(ctx), sessionId);
    const input = ctx.input as { idempotencyKey: string };
    await ctx.deps.gm.pauseSession({
      sessionId,
      gmPlayerId: authOf(ctx).playerId,
      idempotencyKey: input.idempotencyKey,
      traceId: ctx.traceId,
    });
    return EMPTY;
  },

  'POST /sessions/:id/resume': async (ctx) => {
    const sessionId = ctx.params['id'] as SessionId;
    assertSameSession(authOf(ctx), sessionId);
    const input = ctx.input as { idempotencyKey: string };
    await ctx.deps.gm.resumeSession({
      sessionId,
      gmPlayerId: authOf(ctx).playerId,
      idempotencyKey: input.idempotencyKey,
      traceId: ctx.traceId,
    });
    return EMPTY;
  },

  'POST /sessions/:id/end': async (ctx) => {
    const sessionId = ctx.params['id'] as SessionId;
    assertSameSession(authOf(ctx), sessionId);
    const input = ctx.input as { idempotencyKey: string };
    await ctx.deps.gm.endSession({
      sessionId,
      gmPlayerId: authOf(ctx).playerId,
      reason: 'сессия завершена ведущим через HTTP',
      idempotencyKey: input.idempotencyKey,
      traceId: ctx.traceId,
    });
    return EMPTY;
  },

  'DELETE /sessions/:id/me': async (ctx) => {
    const sessionId = ctx.params['id'] as SessionId;
    assertSameSession(authOf(ctx), sessionId);
    await ctx.deps.sessions.leaveSession({
      sessionId,
      playerId: authOf(ctx).playerId,
      idempotencyKey: `leave:${sessionId}:${authOf(ctx).playerId}`,
      traceId: ctx.traceId,
    });
    return EMPTY;
  },

  'DELETE /sessions/:id/player/:pid': async (ctx) => {
    const sessionId = ctx.params['id'] as SessionId;
    assertSameSession(authOf(ctx), sessionId);
    const playerId = ctx.params['pid'] as PlayerId;
    await ctx.deps.gm.kickPlayer({
      sessionId,
      gmPlayerId: authOf(ctx).playerId,
      playerId,
      idempotencyKey: `kick:${sessionId}:${playerId}`,
      traceId: ctx.traceId,
    });
    return EMPTY;
  },

  'POST /sessions/:id/move': async (ctx) => {
    const sessionId = ctx.params['id'] as SessionId;
    assertSameSession(authOf(ctx), sessionId);
    const input = ctx.input as { playerIds: PlayerId[]; toLocationId: string; idempotencyKey: string };
    await ctx.deps.gm.moveGroup({
      sessionId,
      gmPlayerId: authOf(ctx).playerId,
      playerIds: input.playerIds,
      toLocationId: input.toLocationId,
      idempotencyKey: input.idempotencyKey,
      traceId: ctx.traceId,
    });
    return EMPTY;
  },

  // --- ход ------------------------------------------------------------------
  'POST /sessions/:id/turns': async (ctx) => {
    const sessionId = ctx.params['id'] as SessionId;
    assertSameSession(authOf(ctx), sessionId);
    const input = ctx.input as { idempotencyKey: string };
    const opened = await ctx.deps.gm.openTurn({
      sessionId,
      gmPlayerId: authOf(ctx).playerId,
      idempotencyKey: input.idempotencyKey,
      traceId: ctx.traceId,
    });
    return ok({ turnId: opened.turnId, number: opened.number });
  },

  'POST /turns/:id/action': async (ctx) => {
    const turnId = ctx.params['id'] as TurnId;
    const input = ctx.input as { rawText: string; meta?: Record<string, unknown>; idempotencyKey: string };
    const submitted = await ctx.deps.turns.submitAction({
      turnId,
      playerId: authOf(ctx).playerId,
      rawText: input.rawText,
      ...(input.meta === undefined ? {} : { meta: input.meta as never }),
      idempotencyKey: input.idempotencyKey,
      traceId: ctx.traceId,
    });
    return ok({ actionId: submitted.actionId, sequenceId: submitted.sequenceId });
  },

  'POST /turns/:id/lock': async (ctx) => {
    const turnId = ctx.params['id'] as TurnId;
    await assertTurnSession(ctx, turnId);
    const input = ctx.input as { idempotencyKey: string };
    await ctx.deps.gm.lockTurn({
      turnId,
      gmPlayerId: authOf(ctx).playerId,
      idempotencyKey: input.idempotencyKey,
      traceId: ctx.traceId,
    });
    return EMPTY;
  },

  'POST /turns/:id/unlock': async (ctx) => {
    const turnId = ctx.params['id'] as TurnId;
    await assertTurnSession(ctx, turnId);
    const input = ctx.input as { idempotencyKey: string };
    await ctx.deps.gm.unlockTurn({
      turnId,
      gmPlayerId: authOf(ctx).playerId,
      idempotencyKey: input.idempotencyKey,
      traceId: ctx.traceId,
    });
    return EMPTY;
  },

  'POST /turns/:id/cancel': async (ctx) => {
    const turnId = ctx.params['id'] as TurnId;
    await assertTurnSession(ctx, turnId);
    const input = ctx.input as { reason: string; idempotencyKey: string };
    await ctx.deps.gm.cancelTurn({
      turnId,
      gmPlayerId: authOf(ctx).playerId,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      traceId: ctx.traceId,
    });
    return EMPTY;
  },

  'POST /turns/:id/commit': async (ctx) => {
    const turnId = ctx.params['id'] as TurnId;
    await assertTurnSession(ctx, turnId);
    const input = ctx.input as { idempotencyKey: string };
    const committed = await ctx.deps.gmReview.approve({
      turnId,
      gmPlayerId: authOf(ctx).playerId,
      idempotencyKey: input.idempotencyKey,
      traceId: ctx.traceId,
    });
    return ok({ version: committed.version });
  },

  'POST /turns/:id/edit-approve': async (ctx) => {
    const turnId = ctx.params['id'] as TurnId;
    await assertTurnSession(ctx, turnId);
    const input = ctx.input as { editedResolution: unknown; baseResolutionHash: string; idempotencyKey: string };
    const result = await ctx.deps.gmReview.editAndApprove({
      turnId,
      gmPlayerId: authOf(ctx).playerId,
      editedResolution: input.editedResolution,
      baseResolutionHash: input.baseResolutionHash,
      idempotencyKey: input.idempotencyKey,
      traceId: ctx.traceId,
    });
    return ok({ version: result.version });
  },

  'POST /turns/:id/reject': async (ctx) => {
    const turnId = ctx.params['id'] as TurnId;
    await assertTurnSession(ctx, turnId);
    const input = ctx.input as { reason: string; idempotencyKey: string };
    await ctx.deps.gmReview.reject({
      turnId,
      gmPlayerId: authOf(ctx).playerId,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      traceId: ctx.traceId,
    });
    return EMPTY;
  },

  'POST /turns/:id/retry': async (ctx) => {
    const turnId = ctx.params['id'] as TurnId;
    await assertTurnSession(ctx, turnId);
    const input = ctx.input as { idempotencyKey: string };
    const retried = await ctx.deps.gmReview.retry({
      turnId,
      gmPlayerId: authOf(ctx).playerId,
      idempotencyKey: input.idempotencyKey,
      traceId: ctx.traceId,
    });
    return ok({ turnId: retried.turnId });
  },

  'GET /turns/:id': async (ctx) => {
    const turnId = ctx.params['id'] as TurnId;
    await assertTurnSession(ctx, turnId);
    return ok(await ctx.deps.turns.getTurnView(turnId, authOf(ctx).isGM ? null : authOf(ctx).playerId));
  },

  // --- чат -------------------------------------------------------------------
  'GET /chat/history': async (ctx) => {
    const query = ctx.input as { sessionId: SessionId; since?: string; limit?: number; visibility?: string };
    assertSameSession(authOf(ctx), query.sessionId);
    const messages = await ctx.deps.chat.history({
      sessionId: query.sessionId,
      playerId: authOf(ctx).playerId,
      ...(query.since === undefined ? {} : { since: query.since }),
      ...(query.visibility === undefined ? {} : { visibility: query.visibility }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
    return ok(messages);
  },

  // --- gm --------------------------------------------------------------------
  'POST /gm/inspect/state': async (ctx) => {
    const input = ctx.input as { sessionId: SessionId };
    assertSameSession(authOf(ctx), input.sessionId);
    return ok(await ctx.deps.gm.inspectState({ sessionId: input.sessionId }));
  },

  'POST /gm/inspect/context': async (ctx) => {
    const input = ctx.input as { turnId: TurnId };
    await assertTurnSession(ctx, input.turnId);
    return ok(await ctx.deps.gm.inspectAIContext({ turnId: input.turnId }));
  },

  'POST /gm/inspect/journal': async (ctx) => {
    const input = ctx.input as { turnId: TurnId };
    await assertTurnSession(ctx, input.turnId);
    const entries = await ctx.deps.gm.inspectJournal({ turnId: input.turnId });
    return ok(entries.map(toJournalEntryView));
  },

  'POST /gm/note': async (ctx) => {
    const input = ctx.input as { sessionId: SessionId; turnId?: TurnId | null; visibility: string; text: string };
    assertSameSession(authOf(ctx), input.sessionId);
    // Ключ детерминирован из содержимого: двойная отправка одной заметки — replay.
    const added = await ctx.deps.gm.addNote({
      sessionId: input.sessionId,
      gmPlayerId: authOf(ctx).playerId,
      turnId: input.turnId ?? null,
      visibility: input.visibility,
      text: input.text,
      idempotencyKey: `gm-note:${sha1(`${input.sessionId}:${authOf(ctx).playerId}:${input.visibility}:${input.turnId ?? ''}:${input.text}`)}`,
      traceId: ctx.traceId,
    });
    return ok({ noteId: added.noteId });
  },

  'GET /gm/audit': async (ctx) => {
    const query = ctx.input as { sessionId: SessionId; since?: string; limit?: number };
    assertSameSession(authOf(ctx), query.sessionId);
    const entries = await ctx.deps.gm.listAudit({
      sessionId: query.sessionId,
      ...(query.since === undefined ? {} : { since: query.since }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
    return ok(entries.map(toGmAuditEntryView));
  },

  // --- состояние / сервис ------------------------------------------------------
  'GET /state/projection': async (ctx) => {
    const query = ctx.input as { sessionId: SessionId; view: 'public' | 'private' };
    assertSameSession(authOf(ctx), query.sessionId);
    if (query.view === 'private') {
      return ok(await ctx.deps.projections.playerGameState(query.sessionId, authOf(ctx).playerId));
    }
    return ok(await ctx.deps.projections.publicGameState(query.sessionId));
  },

  // A1.7/F-6.1: ai/gm-виды — отдельный маршрут ТОЛЬКО для GM (auth: 'gm');
  // player-токен → 403 AUTH_FORBIDDEN ещё до чтения состояния (B-10).
  'GET /state/projection/gm': async (ctx) => {
    const query = ctx.input as { sessionId: SessionId; view: 'ai' | 'gm' };
    assertSameSession(authOf(ctx), query.sessionId);
    if (query.view === 'gm') {
      return ok(await ctx.deps.gm.inspectState({ sessionId: query.sessionId }));
    }
    const session = await ctx.deps.sessions.getSession(query.sessionId);
    if (session.currentTurnId === null) {
      throw new AppError('NOT_FOUND', 'у сессии нет текущего хода — AI-контекст не собран', {
        reason: 'no_current_turn',
      });
    }
    return ok(await ctx.deps.gm.inspectAIContext({ turnId: session.currentTurnId }));
  },

  'GET /metrics': async (ctx) => {
    ctx.reply.header('content-type', 'text/plain; charset=utf-8');
    return ok(ctx.deps.getMetricsText());
  },
};

// ---------------------------------------------------------------- регистрация

export async function registerHttpRoutes(app: FastifyInstance, deps: HttpGatewayDeps): Promise<void> {
  const authHook = makeAuthHook({ jwt: deps.jwt, players: deps.players, isProduction: deps.isProduction });
  const limiter = new TokenRateLimiter(deps.limits.tokenPerMinute, deps.limits.mutatingTurnPerMinute);

  for (const route of HTTP_ROUTES) {
    // /health и /version — во владении app.ts (wiring БД/capabilities/версии).
    if (route.path === '/health' || route.path === '/version') continue;
    const key = routeKey(route);
    const impl = ROUTE_IMPL[key];
    const authenticated = route.auth === 'player' || route.auth === 'gm';

    app.route({
      method: route.method,
      url: route.path,
      ...(AUTH_IP_LIMITED.has(key)
        ? { config: { rateLimit: { max: deps.limits.authPerIpPerMin, timeWindow: '1 minute' } } }
        : {}),
      preHandler: async (req) => {
        await authHook(route.auth, req);
      },
      handler: async (req, reply) => {
        if (authenticated) {
          const header = req.headers.authorization;
          if (typeof header === 'string') {
            const bucketKey = TokenRateLimiter.keyOf(header);
            limiter.checkToken(bucketKey);
            if (route.method === 'POST' && MUTATING_TURN.test(req.url ?? '')) {
              limiter.checkMutatingTurn(bucketKey);
            }
          }
        }
        const source: Record<string, unknown> =
          route.method === 'GET' || route.method === 'DELETE'
            ? { ...((req.query as Record<string, unknown>) ?? {}) }
            : { ...((req.body as Record<string, unknown>) ?? {}) };
        const input = route.request.parse(source) as Record<string, unknown>;
        const ctx: RouteContext = {
          req,
          reply,
          deps,
          auth: authenticated ? requireAuthOf(req) : null,
          traceId: req.id.slice(0, 64),
          input,
          params: (req.params as Record<string, string>) ?? {},
        };
        const result: RouteResult = impl !== undefined ? await impl(ctx) : notImplemented(route);
        const body = route.response.parse(result.body);
        reply.status(result.status ?? 200);
        return typeof body === 'string' ? body : (body as Record<string, unknown>);
      },
    });
  }

  // /media/files/* — вне каталога (промпт 1.10, п.6): статика media c auth player.
  registerMediaFilesRoute(app, deps);
}

/** Маршруты stage 2/3 объявлены, но не реализованы — честные 501 (NOT_IMPLEMENTED). */
function notImplemented(route: RouteContract): never {
  throw new AppError('NOT_IMPLEMENTED', `${route.method} ${route.path} появится в этапе ${route.stage}`, {
    stage: route.stage,
  });
}

async function assertTurnSession(ctx: RouteContext, turnId: TurnId): Promise<void> {
  const turn = await ctx.deps.turns.getTurn(turnId);
  assertSameSession(authOf(ctx), turn.sessionId);
}

function toJournalEntryView(entry: JournalEntry) {
  return {
    id: entry.id,
    kind: entry.kind,
    traceId: entry.traceId,
    payload: entry.payload,
    createdAt: entry.createdAt,
  };
}

function toGmAuditEntryView(entry: GmAuditEntry) {
  return {
    auditId: entry.auditId,
    gmPlayerId: entry.gmPlayerId,
    action: entry.action,
    meta: entry.meta,
    at: entry.at,
  };
}
