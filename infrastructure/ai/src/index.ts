/**
 * @mnemosin/ai — AI-адаптеры и Capability Registry (промпт 1.7).
 *
 *  - ScriptedAI / EchoAI / FailingAI — офлайн-стенды AIPort (F-7.3): детерминированные,
 *    без внешних вызовов; боевые провайдеры (openrouter, lmstudio) добавляются
 *    в этапе 2 ОДНИМ файлом адаптера + строкой в config/capabilities.yaml —
 *    этот пакет и core не меняются (критерий A1.14, сценарий v3 §X.1);
 *  - CapabilityRegistry (v3 §V.11): цепочки fallback, circuit breaker,
 *    retry/backoff/timeout по ProviderPolicy (F-7.2), healthProbe c эмиссией
 *    CAPABILITY_CHANGED, snapshot() для GET /health (A1.13);
 *  - provider-probe.ts — зонд расширяемости (A1.14, промпт 1.3): доказывает, что
 *    описание нового провайдера требует только @mnemosin/contracts. ОСТАВЛЕН
 *    без изменений: его импорты проверяются tests/arch/extensibility.test.ts
 *    и tools/verify/stage1.mjs.
 *
 * Правило слоя (1.3): пакет импортирует только @mnemosin/contracts и
 * @mnemosin/core/domain/ports — адаптер знает порт, но не ядро (D211).
 */
export { PROBE_PROVIDER_ID, PROBE_CAPABILITY, PROBE_POLICY, probeValidateResponse } from './provider-probe.js';

export {
  ScriptedAI,
  ACTION_COUNT_MARKER,
  PLACEHOLDER_PLAYER_PREFIX,
  SCRIPTED_MODEL,
  type ScriptedAIOptions,
} from './scripted-provider.js';
export { EchoAI, echoNarrative, ECHO_MODEL, type EchoAIOptions } from './echo-provider.js';
export { FailingAI, FailingModeSchema, type FailingMode, type FailingAIOptions } from './failing-provider.js';
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
