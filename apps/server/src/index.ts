/**
 * Публичный API пакета @mnemosin/server.
 * main.ts — точка входа процесса (не экспортируется, чтобы импорт пакета
 * не запускал сервер).
 */
export { buildApp, type BuildAppOptions } from './app.js';
export { resolveProjectRoot } from './project-root.js';
export {
  createPrototypeWsGateway,
  prototypeStaticScene,
  prototypeRealtimeLimits,
  PrototypeHotMatch,
  PROTOTYPE_HOT_RUNTIME_CONFIG,
  type PrototypeHotPlayer,
  type PrototypeWsOptions,
} from './hot-wiring.js';
export {
  buildHealthPayload,
  buildVersionPayload,
  type HealthPayload,
  type HealthExtras,
  type VersionPayload,
} from './health.js';
