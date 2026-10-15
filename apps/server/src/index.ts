/**
 * Публичный API пакета @mnemosin/server.
 * main.ts — точка входа процесса (не экспортируется, чтобы импорт пакета
 * не запускал сервер).
 */
export { buildApp, type BuildAppOptions } from './app.js';
export { buildAIStack, type AIStack, type BuildAIStackDeps } from './ai.js';
export { buildModules, type ModuleStack, type BuildModulesDeps } from './modules.js';
export {
  attachModulesRegistry,
  buildStage1Registrations,
  mediaDirectorContract,
  validateModulesRegistry,
  type ModuleRegistration,
  type ModuleEventHandler,
  type RegistryLog,
  type Stage1Services,
} from './modules-registry.js';
export { resolveProjectRoot } from './project-root.js';
export { buildProjectionProvider, type ProjectionProviderImpl } from './projections.js';
export {
  buildHealthPayload,
  buildVersionPayload,
  type HealthPayload,
  type HealthExtras,
  type VersionPayload,
} from './health.js';
