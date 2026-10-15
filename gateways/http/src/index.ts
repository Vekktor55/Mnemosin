/**
 * @mnemosin/gateway-http — HTTP-транспорт (промпт 1.10; критерии A1.1, A1.7;
 * закрывает B-11, B-12, F-6.6).
 *
 *  - auth/ — JWT HS256 (jose, D252): access/refresh, claims {sub, sid, gm, typ,
 *    exp, iat, jti}; отзыв по players.revoked_before (B-12.3); requireAuth
 *    ('none'|'player'|'gm'|'internal') — единый preHandler по route.auth ИЗ
 *    каталога HTTP_ROUTES;
 *  - routes.ts — регистрация ВСЕХ маршрутов из contracts HTTP_ROUTES (маршруты
 *    не объявляются заново): парсинг Zod → команда модуля → парсинг ответа;
 *    stage 2/3 — объявлены и отдают 501 NOT_IMPLEMENTED;
 *  - error-handler.ts — AppError/ZodError → HttpErrorBody по ERROR_TABLE,
 *    requestId всегда;
 *  - rate-limit.ts — per-token лимиты (300/мин, мутирующие turn — 30/мин);
 *    per-IP — @fastify/rate-limit (глобально 100/мин, /auth/* и join — 10/мин);
 *  - media.ts — /media/files/* c auth player (этап 2 наполнит каталог).
 *
 * Инвариант 14: никакой доменной логики — только парсинг, авторизация, вызов
 * команд модулей (инжектируются wiring'ом структурными портами, D227) и
 * сериализация. Импорты: @mnemosin/contracts, @mnemosin/core/domain/ports,
 * fastify, zod, jose, node:*.
 */
export { JwtService, type IssuedTokens, type JwtConfig, type TokenClaims, type TokenType } from './auth/jwt.js';
export { makeAuthHook, assertSameSession, requireAuthOf, type AuthDeps, type RequestAuth } from './auth/middleware.js';
export { createHttpErrorHandler, zodIssuesToMeta, type HttpErrorBody } from './error-handler.js';
export { TokenRateLimiter } from './rate-limit.js';
export { registerHttpRoutes } from './routes.js';
export { registerMediaFilesRoute } from './media.js';
export type {
  ChatOps,
  GatewayLog,
  GmOps,
  GmReviewOps,
  HttpGatewayDeps,
  ProjectionProvider,
  SessionOps,
  TurnActionMeta,
  TurnOps,
} from './deps.js';

export const PACKAGE_ID = '@mnemosin/gateway-http';
export const IMPLEMENTED_IN_PROMPT = '1.10';
