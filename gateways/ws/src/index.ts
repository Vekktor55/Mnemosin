/** Server-only P05-A WebSocket gateway; browser prediction/interpolation belongs to P05-B. */
export { registerWsGateway, type WsGatewayHandle } from './server.js';
export { ConnectionRegistry, WsConnectionRecord } from './connection-registry.js';
export { SceneReplicationService } from './replication.js';
export { HotSchedulerSupervisor } from './scheduler-supervisor.js';
export { SceneDeliveryQueue, coalesceSceneDeltas } from './delivery.js';
export { buildPlayerProjection, buildObserverProjection, buildProjection } from './projections.js';
export { routeWsMessage } from './router.js';
export { RequestDedupeCache } from './dedupe.js';
export { ConnectionRateLimiter } from './rate-limit.js';
export { WS_SUBPROTOCOL_PREFIX, extractHandshakeToken, verifyWsToken, closeWithCode } from './auth.js';
export { PROTOTYPE_REALTIME_NETWORK, realtimeNetworkConfig } from './config.js';
export type {
  WsGatewayDeps,
  WsLimits,
  RealtimeNetworkConfig,
  WsGatewayLog,
  WsHotMatchPort,
  WsHotRuntimePort,
  WsHotSchedulerPort,
  WsHotTickResult,
  WsHotSimulationState,
  WsAuthenticatedActor,
  WsAuthenticationResult,
  WsStaticScene,
  WsHiddenFactSource,
  ConnectionActorContext,
  WsConnectionState,
} from './deps.js';
