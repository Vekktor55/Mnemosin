import { AIResponseSchema, CapabilitySchema, ProviderPolicySchema, type Capability } from '@mnemosin/contracts';

/**
 * Зонд расширяемости (критерий A1.14, промпт 1.3).
 *
 * Доказательство того, что новый AI-провайдер добавляется БЕЗ изменения core:
 * этот файл импортирует только @mnemosin/contracts и уже может описать
 * провайдера, его политику и валидацию ответа. В промпте 1.7 он заменяется
 * реальными адаптерами (ScriptedAI/EchoAI/FailingAI), реализующими AIPort из
 * core/domain/ports — при том же правиле: адаптер знает порт, а не ядро.
 *
 * Сценарий из v3 §X.1 («добавить XAI без правки Core») проверяется тестом
 * tests/arch/extensibility.test.ts.
 */

export const PROBE_PROVIDER_ID = 'xai-probe';
export const PROBE_CAPABILITY: Capability = CapabilitySchema.parse('TEXT_AI');

/** Политика нового провайдера валидна без единой строчки хардкода в контрактах. */
export const PROBE_POLICY = ProviderPolicySchema.parse({
  providerId: PROBE_PROVIDER_ID,
  capability: PROBE_CAPABILITY,
  timeoutMs: 40_000,
  retries: { max: 2, backoffMs: 1000, jitter: true },
  circuitBreaker: { failureThreshold: 3, cooldownMs: 60_000 },
  costPer1kTokens: { input: null, output: null },
});

/** Ответ провайдера проверяется общей схемой — своей схемы провайдер не заводит. */
export function probeValidateResponse(raw: unknown): { ok: boolean; issues: string[] } {
  const result = AIResponseSchema.safeParse(raw);
  if (result.success) return { ok: true, issues: [] };
  return { ok: false, issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) };
}
