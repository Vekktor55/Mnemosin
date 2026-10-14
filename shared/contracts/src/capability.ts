import { z } from 'zod';

/**
 * Capability и политики провайдеров (v3 §IV.2, §V.11).
 *
 * D162: схемы конфигов деплоя живут в @mnemosin/config, но CapabilitySchema и
 * ProviderPolicySchema — доменные понятия, поэтому определены здесь, а config
 * их импортирует. Один владелец на схему.
 */

export const CapabilitySchema = z.enum([
  'TEXT_AI',
  'VISUAL_PROMPT',
  'IMAGE_GENERATION',
  'IMAGE_EDITING',
  'AUDIO_GENERATION',
  'VIDEO',
]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const RetriesPolicySchema = z.object({
  max: z.number().int().min(0).max(5).default(2),
  backoffMs: z.number().int().positive().default(1000),
  jitter: z.boolean().default(true),
});
export type RetriesPolicy = z.infer<typeof RetriesPolicySchema>;

export const CircuitBreakerPolicySchema = z.object({
  failureThreshold: z.number().int().positive().default(3),
  cooldownMs: z.number().int().positive().default(60_000),
});
export type CircuitBreakerPolicy = z.infer<typeof CircuitBreakerPolicySchema>;

export const ModelPriceSchema = z.object({
  /** null = цена неизвестна → costUsd не считается (v3 §VIII.6, UNKNOWN#5). */
  input: z.number().nonnegative().nullable(),
  output: z.number().nonnegative().nullable(),
});

export const ProviderPolicySchema = z.object({
  providerId: z.string().min(1).max(64),
  capability: CapabilitySchema,
  timeoutMs: z.number().int().positive().default(45_000),
  retries: RetriesPolicySchema.default({}),
  circuitBreaker: CircuitBreakerPolicySchema.default({}),
  costPer1kTokens: ModelPriceSchema.default({ input: null, output: null }),
});
export type ProviderPolicy = z.infer<typeof ProviderPolicySchema>;

export const BreakerState = z.enum(['CLOSED', 'OPEN', 'HALF_OPEN']);
export type BreakerState = z.infer<typeof BreakerState>;

/** Причина деградации capability (D-политика деградации, промпт 3.4). */
export const DegradationReason = z.enum(['unavailable', 'budget', 'manual', 'error_rate']);
export type DegradationReason = z.infer<typeof DegradationReason>;

export const CapabilityAvailabilitySchema = z.object({
  capability: CapabilitySchema,
  available: z.boolean(),
  required: z.boolean(),
  providers: z.array(z.string().max(64)),
  reason: DegradationReason.nullable(),
  checkedAt: z.string().datetime({ offset: false, precision: 3 }).nullable(),
});
export type CapabilityAvailability = z.infer<typeof CapabilityAvailabilitySchema>;
