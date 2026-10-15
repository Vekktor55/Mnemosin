/**
 * @mnemosin/gateway-ws — WS-транспорт этапа 1 «Стол» (промпт 1.11).
 *
 *  - server.ts: @fastify/websocket на /ws, handshake-авторизация (D123),
 *    окно AUTH (D267), лимиты соединений, HELLO/AUTH_OK, heartbeat,
 *    reconnect-контракт (A1.9);
 *  - router.ts: WSClientMessage → команды модулей, дедупликация по requestId
 *    (F-6.7), rate limit per connection, GM-гейт, ошибки только ErrorCode;
 *  - projections.ts: ЕДИНСТВЕННАЯ точка «домен → клиент» + WS_PRIVACY_POLICY
 *    (B-10, A1.7);
 *  - broadcast.ts: события шины → WS-доставка по политикам;
 *  - connection-registry.ts: in-memory реестр соединений (multi-tab, presence).
 *
 * Инвариант 14: игровой логики здесь нет — только парсинг, авторизация,
 * вызов команд модулей (структурные порты, D227) и сериализация.
 */
export { registerWsGateway, type WsGatewayHandle } from './server.js';
export { ConnectionRegistry, type WsConnectionRecord } from './connection-registry.js';
export { WsBroadcaster, findForbiddenKey, type DeliveryTarget, type ServerEnvelope } from './projections.js';
export { attachWsBroadcast } from './broadcast.js';
export { createWsRouter, type WsConnectionState, type WsRouter } from './router.js';
export { RequestDedupeCache } from './dedupe.js';
export { ConnectionRateLimiter } from './rate-limit.js';
export { WS_SUBPROTOCOL_PREFIX, extractHandshakeToken, verifyWsToken, closeWithCode } from './auth.js';
export type {
  WsGatewayDeps,
  WsLimits,
  WsJwtVerifier,
  WsSessionOps,
  WsTurnOps,
  WsChatOps,
  WsGmOps,
  WsGmReviewOps,
  WsStoryOps,
  WsProjectionProvider,
  WsGatewayLog,
} from './deps.js';
