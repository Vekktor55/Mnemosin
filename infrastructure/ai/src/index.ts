/**
 * @mnemosin/ai — AI-адаптеры и Capability Registry (промпт 1.7).
 *
 *  - CapabilityRegistry (v3 §V.11): цепочки fallback, circuit breaker,
 *    retry/backoff/timeout по ProviderPolicy (F-7.2), healthProbe c эмиссией
 *    CAPABILITY_CHANGED, snapshot() для GET /health (A1.13);
 *  - provider-probe.ts — зонд расширяемости (A1.14, промпт 1.3): доказывает, что
 *    описание нового провайдера требует только @mnemosin/contracts. ОСТАВЛЕН
 *    без изменений: его импорты проверяются tests/arch/extensibility.test.ts
 *    и tools/verify/stage1.mjs.
 *
 * Офлайн-стенды (ScriptedAI, EchoAI, FailingAI) вынесены в tests/fixtures/ai-providers/
 * и не входят в production-сборку. Используются только в тестах.
 *
 * Правило слоя (1.3): пакет импортирует только @mnemosin/contracts и
 * @mnemosin/core/domain/ports — адаптер знает порт, но не ядро (D211).
 */
export { PROBE_PROVIDER_ID, PROBE_CAPABILITY, PROBE_POLICY, probeValidateResponse } from './provider-probe.js';

export {
  CapabilityRegistry,
  RegistryEntrySchema,
  backoffDelayMs,
  type CapabilityRegistryOptions,
  type PolicyAttemptContext,
  type ProviderSnapshot,
  type RegistryEntry,
  type RegistryLog,
  type RegistrySnapshot,
} from './registry.js';

export const PACKAGE_ID = '@mnemosin/ai';
export const IMPLEMENTED_IN_PROMPT = '1.7';
