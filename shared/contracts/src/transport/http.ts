import { z } from 'zod';
import { IsoDateTime } from '../time.js';
import { type ErrorCode } from '../errors.js';
import { IdempotencyKey, LocationId, PlayerId, SessionId, TurnId } from '../ids.js';
import { TurnResolutionSchema } from '../domain/resolution.js';
import { GMNoteVisibility } from '../domain/gm.js';
import { CapabilityAvailabilitySchema } from '../capability.js';
import {
  ChatMessageViewSchema,
  GmAuditEntryViewSchema,
  GMStateViewSchema,
  JournalEntryViewSchema,
  MediaJobViewSchema,
  PublicGameStateViewSchema,
  SessionViewSchema,
  TurnViewSchema,
} from './views.js';
import { DirectorContextSchema } from '../ai.js';

/**
 * HTTP-каталог как код (v3 §VI.2–VI.4 + аудит §8.5: половина GM-операций
 * не имела маршрутов — блокер B-11).
 *
 * Каждый маршрут описан объектом RouteContract: транспорт перебирает этот
 * массив и регистрирует handler'ы, поэтому «забыть» маршрут или оставить
 * ответ без схемы невозможно (проверяется contract-тестом).
 */

export const AuthLevel = z.enum(['none', 'player', 'gm', 'internal']);
export type AuthLevel = z.infer<typeof AuthLevel>;

export const IdempotentBodySchema = z.object({ idempotencyKey: IdempotencyKey });

export interface RouteContract {
  readonly method: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  readonly path: string;
  readonly auth: AuthLevel;
  readonly stage: 1 | 2 | 3;
  readonly request: z.ZodTypeAny;
  readonly response: z.ZodTypeAny;
  readonly errors: readonly ErrorCode[];
  readonly note?: string;
}

const empty = z.object({});
const idKey = IdempotentBodySchema;

const auth = {
  createSession: z.object({
    displayName: z.string().min(1).max(60),
    characterName: z.string().min(1).max(60),
    title: z.string().min(1).max(120).optional(),
  }),
  createSessionResult: z.object({
    sessionId: SessionId,
    playerId: PlayerId,
    token: z.string(),
    refreshToken: z.string(),
  }),
  refresh: z.object({ refreshToken: z.string().min(16) }),
  refreshResult: z.object({ token: z.string() }),
  join: z.object({ displayName: z.string().min(1).max(60), characterName: z.string().min(1).max(60) }),
  joinResult: z.object({
    playerId: PlayerId,
    characterId: z.string().uuid(),
    token: z.string(),
    refreshToken: z.string(),
  }),
};

const turn = {
  action: z.object({
    rawText: z.string().min(1).max(4000),
    meta: z
      .object({
        targetObjectId: z.string().uuid().nullable().optional(),
        targetPlayerId: z.string().uuid().nullable().optional(),
        intent: z.enum(['SPEAK', 'ACT', 'MOVE', 'USE', 'OBSERVE', 'WAIT', 'CUSTOM']).nullable().optional(),
        customLabel: z.string().max(80).nullable().optional(),
      })
      .optional(),
    idempotencyKey: IdempotencyKey,
  }),
  actionResult: z.object({ actionId: z.string().uuid(), sequenceId: z.number().int().positive() }),
  reject: z.object({ reason: z.string().min(1).max(1000), idempotencyKey: IdempotencyKey }),
  editApprove: z.object({
    editedResolution: TurnResolutionSchema,
    baseResolutionHash: z.string().length(64),
    idempotencyKey: IdempotencyKey,
  }),
  versionResult: z.object({ version: z.number().int().nonnegative() }),
  openResult: z.object({ turnId: TurnId, number: z.number().int().nonnegative() }),
};

export const HTTP_ROUTES: readonly RouteContract[] = Object.freeze([
  // --- auth / session
  {
    method: 'POST',
    path: '/auth/session',
    auth: 'none',
    stage: 1,
    request: auth.createSession,
    response: auth.createSessionResult,
    errors: ['VALIDATION', 'RATE_LIMIT'],
    note: 'создаёт сессию и GM-игрока (D122)',
  },
  {
    method: 'POST',
    path: '/auth/refresh',
    auth: 'none',
    stage: 1,
    request: auth.refresh,
    response: auth.refreshResult,
    errors: ['AUTH_INVALID', 'AUTH_EXPIRED', 'VALIDATION'],
  },
  {
    method: 'POST',
    path: '/sessions',
    auth: 'gm',
    stage: 1,
    request: z.object({ title: z.string().min(1).max(120), idempotencyKey: IdempotencyKey }),
    response: z.object({ sessionId: SessionId }),
    errors: ['VALIDATION', 'AUTH_FORBIDDEN'],
    note: 'алиас /auth/session для GM-токена',
  },
  {
    method: 'POST',
    path: '/sessions/:id/join',
    auth: 'none',
    stage: 1,
    request: auth.join,
    response: auth.joinResult,
    errors: ['NOT_FOUND', 'CONFLICT', 'VALIDATION', 'RATE_LIMIT'],
  },
  {
    method: 'GET',
    path: '/sessions/:id',
    auth: 'player',
    stage: 1,
    request: empty,
    response: SessionViewSchema,
    errors: ['NOT_FOUND', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'POST',
    path: '/sessions/:id/start',
    auth: 'gm',
    stage: 1,
    request: idKey,
    response: z.object({ turnId: TurnId }),
    errors: ['CONFLICT', 'CAPABILITY_UNAVAILABLE', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'POST',
    path: '/sessions/:id/pause',
    auth: 'gm',
    stage: 1,
    request: idKey,
    response: empty,
    errors: ['CONFLICT', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'POST',
    path: '/sessions/:id/resume',
    auth: 'gm',
    stage: 1,
    request: idKey,
    response: empty,
    errors: ['CONFLICT', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'POST',
    path: '/sessions/:id/end',
    auth: 'gm',
    stage: 1,
    request: idKey,
    response: empty,
    errors: ['CONFLICT', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'DELETE',
    path: '/sessions/:id/me',
    auth: 'player',
    stage: 1,
    request: empty,
    response: empty,
    errors: ['NOT_FOUND'],
    note: 'добровольный выход (B-11)',
  },
  {
    method: 'DELETE',
    path: '/sessions/:id/player/:pid',
    auth: 'gm',
    stage: 1,
    request: empty,
    response: empty,
    errors: ['NOT_FOUND', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'POST',
    path: '/sessions/:id/move',
    auth: 'gm',
    stage: 1,
    request: z.object({
      playerIds: z.array(PlayerId).min(1),
      toLocationId: LocationId,
      idempotencyKey: IdempotencyKey,
    }),
    response: empty,
    errors: ['CORE_LOCATION_NOT_FOUND', 'RULE_REJECTED', 'CONFLICT', 'AUTH_FORBIDDEN'],
  },
  // --- turn
  {
    method: 'POST',
    path: '/sessions/:id/turns',
    auth: 'gm',
    stage: 1,
    request: idKey,
    response: turn.openResult,
    errors: ['CONFLICT', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'POST',
    path: '/turns/:id/action',
    auth: 'player',
    stage: 1,
    request: turn.action,
    response: turn.actionResult,
    errors: ['CONFLICT', 'TURN_NOT_OPEN', 'VALIDATION', 'RATE_LIMIT', 'RULE_REJECTED'],
  },
  {
    method: 'POST',
    path: '/turns/:id/lock',
    auth: 'gm',
    stage: 1,
    request: idKey,
    response: empty,
    errors: ['CONFLICT', 'IDEMPOTENCY_IN_FLIGHT', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'POST',
    path: '/turns/:id/unlock',
    auth: 'gm',
    stage: 1,
    request: idKey,
    response: empty,
    errors: ['CONFLICT', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'POST',
    path: '/turns/:id/cancel',
    auth: 'gm',
    stage: 1,
    request: turn.reject,
    response: empty,
    errors: ['CONFLICT', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'POST',
    path: '/turns/:id/commit',
    auth: 'gm',
    stage: 1,
    request: idKey,
    response: turn.versionResult,
    errors: ['CONFLICT', 'VERSION_CONFLICT', 'IDEMPOTENCY_IN_FLIGHT', 'RULE_REJECTED', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'POST',
    path: '/turns/:id/edit-approve',
    auth: 'gm',
    stage: 1,
    request: turn.editApprove,
    response: turn.versionResult,
    errors: ['VERSION_CONFLICT', 'VALIDATION', 'IDEMPOTENCY_IN_FLIGHT', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'POST',
    path: '/turns/:id/reject',
    auth: 'gm',
    stage: 1,
    request: turn.reject,
    response: empty,
    errors: ['CONFLICT', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'POST',
    path: '/turns/:id/retry',
    auth: 'gm',
    stage: 1,
    request: idKey,
    response: z.object({ turnId: TurnId }),
    errors: ['CONFLICT', 'PROVIDER_UNAVAILABLE', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'GET',
    path: '/turns/:id',
    auth: 'player',
    stage: 1,
    request: empty,
    response: TurnViewSchema,
    errors: ['NOT_FOUND'],
  },
  // --- chat
  {
    method: 'GET',
    path: '/chat/history',
    auth: 'player',
    stage: 1,
    request: z.object({
      sessionId: SessionId,
      since: IsoDateTime.optional(),
      limit: z.number().int().min(1).max(500).optional(),
      visibility: z.enum(['PUBLIC', 'PRIVATE', 'SYSTEM', 'GM']).optional(),
    }),
    response: z.array(ChatMessageViewSchema),
    errors: ['VALIDATION', 'AUTH_FORBIDDEN'],
  },
  // --- gm
  {
    method: 'POST',
    path: '/gm/inspect/state',
    auth: 'gm',
    stage: 1,
    request: z.object({ sessionId: SessionId }),
    response: GMStateViewSchema,
    errors: ['NOT_FOUND', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'POST',
    path: '/gm/inspect/context',
    auth: 'gm',
    stage: 1,
    request: z.object({ turnId: TurnId }),
    response: DirectorContextSchema,
    errors: ['NOT_FOUND', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'POST',
    path: '/gm/inspect/journal',
    auth: 'gm',
    stage: 1,
    request: z.object({ turnId: TurnId }),
    response: z.array(JournalEntryViewSchema),
    errors: ['NOT_FOUND', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'POST',
    path: '/gm/note',
    auth: 'gm',
    stage: 1,
    request: z.object({
      sessionId: SessionId,
      turnId: TurnId.nullable().optional(),
      visibility: GMNoteVisibility,
      text: z.string().min(1).max(4000),
    }),
    response: z.object({ noteId: z.string().uuid() }),
    errors: ['VALIDATION', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'GET',
    path: '/gm/audit',
    auth: 'gm',
    stage: 1,
    request: z.object({
      sessionId: SessionId,
      since: IsoDateTime.optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    response: z.array(GmAuditEntryViewSchema),
    errors: ['VALIDATION', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'POST',
    path: '/gm/events/:eid/activate',
    auth: 'gm',
    stage: 2,
    request: z.object({ turnId: TurnId, idempotencyKey: IdempotencyKey }),
    response: empty,
    errors: ['NOT_FOUND', 'RULE_REJECTED', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'POST',
    path: '/gm/deferred/:deferredId/force-apply',
    auth: 'gm',
    stage: 2,
    request: idKey,
    response: empty,
    errors: ['NOT_FOUND', 'CONFLICT', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'POST',
    path: '/gm/worldpack',
    auth: 'gm',
    stage: 2,
    request: z.object({ packId: z.string().max(60), packVersion: z.string().max(20), idempotencyKey: IdempotencyKey }),
    response: z.object({ locations: z.number().int(), events: z.number().int() }),
    errors: ['WORKPACK_INVALID', 'WORLDPACK_VERSION_MISMATCH', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'GET',
    path: '/gm/worldpack',
    auth: 'gm',
    stage: 2,
    request: z.object({ sessionId: SessionId }),
    response: z.object({
      packId: z.string(),
      packVersion: z.string(),
      remap: z.array(z.object({ slug: z.string(), kind: z.string(), entityId: z.string() })),
      validation: z.record(z.string(), z.unknown()),
    }),
    errors: ['NOT_FOUND', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'GET',
    path: '/gm/spend',
    auth: 'gm',
    stage: 2,
    request: z.object({ sessionId: SessionId }),
    response: z.object({
      spentUsd: z.number(),
      budgetUsd: z.number(),
      byProvider: z.array(z.object({ providerId: z.string(), usd: z.number() })),
      aiTokens: z.object({ input: z.number().int(), output: z.number().int() }),
    }),
    errors: ['AUTH_FORBIDDEN'],
  },
  {
    method: 'POST',
    path: '/gm/capabilities',
    auth: 'gm',
    stage: 3,
    request: z.object({
      capability: z.string(),
      action: z.enum(['disable', 'enable']),
      reason: z.string().max(200),
      idempotencyKey: IdempotencyKey,
    }),
    response: empty,
    errors: ['VALIDATION', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'GET',
    path: '/gm/capabilities',
    auth: 'gm',
    stage: 3,
    request: empty,
    response: z.array(CapabilityAvailabilitySchema),
    errors: ['AUTH_FORBIDDEN'],
  },
  {
    method: 'POST',
    path: '/gm/sessions/:id/export',
    auth: 'gm',
    stage: 3,
    request: z.object({
      includeJournal: z.boolean().optional(),
      includeGmSecrets: z.boolean().optional(),
      includeChat: z.boolean().optional(),
    }),
    response: z.record(z.string(), z.unknown()),
    errors: ['NOT_FOUND', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'POST',
    path: '/gm/sessions/import',
    auth: 'gm',
    stage: 3,
    request: z.record(z.string(), z.unknown()),
    response: z.object({ sessionId: SessionId }),
    errors: ['BUNDLE_INCOMPATIBLE', 'VALIDATION', 'AUTH_FORBIDDEN'],
  },
  // --- media
  {
    method: 'GET',
    path: '/media/jobs/:id',
    auth: 'player',
    stage: 2,
    request: empty,
    response: MediaJobViewSchema,
    errors: ['NOT_FOUND'],
  },
  {
    method: 'POST',
    path: '/media/request',
    auth: 'gm',
    stage: 2,
    request: z.object({
      sessionId: SessionId,
      turnId: TurnId.nullable(),
      sceneHint: z.string().min(1).max(500),
      idempotencyKey: IdempotencyKey,
    }),
    response: z.object({ mediaJobId: z.string().uuid() }),
    errors: ['CAPABILITY_UNAVAILABLE', 'AUTH_FORBIDDEN'],
  },
  {
    method: 'POST',
    path: '/media/jobs/:id/cancel',
    auth: 'gm',
    stage: 2,
    request: empty,
    response: empty,
    errors: ['NOT_FOUND', 'CONFLICT', 'AUTH_FORBIDDEN'],
  },
  // --- state / service
  {
    method: 'GET',
    path: '/state/projection',
    auth: 'player',
    stage: 1,
    request: z.object({ sessionId: SessionId, view: z.enum(['public', 'private']) }),
    response: z.union([PublicGameStateViewSchema, z.record(z.string(), z.unknown())]),
    errors: ['NOT_FOUND', 'AUTH_FORBIDDEN'],
    note: 'view=public|private для игрока',
  },
  {
    method: 'GET',
    path: '/state/projection/gm',
    auth: 'gm',
    stage: 1,
    request: z.object({ sessionId: SessionId, view: z.enum(['ai', 'gm']) }),
    response: z.union([GMStateViewSchema, DirectorContextSchema]),
    errors: ['AUTH_FORBIDDEN'],
    note: 'ai/gm-виды — только GM (блокер B-10): в v3 маршрут /state/projection?view=ai|gm не различал роли',
  },
  {
    method: 'GET',
    path: '/health',
    auth: 'none',
    stage: 1,
    request: empty,
    response: z.object({
      ok: z.boolean(),
      version: z.string(),
      contractsVersion: z.string(),
      env: z.string(),
      uptime: z.number(),
      capabilities: z.record(z.string(), z.unknown()),
      db: z.enum(['ok', 'degraded', 'unknown']),
      schemaVersion: z.number().int().nullable(),
      phase: z.string(),
    }),
    errors: [],
  },
  {
    method: 'GET',
    path: '/version',
    auth: 'none',
    stage: 1,
    request: empty,
    response: z.object({
      version: z.string(),
      contractsVersion: z.string(),
      gitTag: z.string().nullable(),
      node: z.string(),
    }),
    errors: [],
  },
  {
    method: 'GET',
    path: '/metrics',
    auth: 'internal',
    stage: 3,
    request: empty,
    response: z.string(),
    errors: ['AUTH_FORBIDDEN'],
    note: 'в prod — только METRICS_PORT/localhost (D146)',
  },
]);

export type RouteKey = `${RouteContract['method']} ${RouteContract['path']}`;

export function routeKey(route: RouteContract): RouteKey {
  return `${route.method} ${route.path}` as RouteKey;
}

/** Маршруты этапа 1 — то, что транспорт обязан зарегистрировать сейчас. */
export const STAGE1_ROUTES: readonly RouteContract[] = Object.freeze(HTTP_ROUTES.filter((r) => r.stage === 1));
