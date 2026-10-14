import { z } from 'zod';
import {
  CapabilitySchema,
  ProviderPolicySchema,
  RetriesPolicySchema,
  CircuitBreakerPolicySchema,
  type Capability,
  type ProviderPolicy,
} from '@mnemosin/contracts';

/**
 * Схемы конфигурационных файлов config/*.yaml (v3 §V.11, §VI.10, §VIII.6;
 * образец — docs/AUDIT.md §8.9).
 *
 * D162: доменные понятия (`CapabilitySchema`, `ProviderPolicySchema`) определены
 * в @mnemosin/contracts и импортируются здесь — один владелец на схему.
 * В этом пакете остаются только деплой-конфиги: `capabilities.yaml` (цепочки
 * fallback) и `limits.yaml` (лимиты партии, WS, HTTP, outbox, бюджеты).
 */

export { CapabilitySchema, ProviderPolicySchema };
export type { Capability, ProviderPolicy };

export const RetriesSchema = RetriesPolicySchema;
export const CircuitBreakerSchema = CircuitBreakerPolicySchema;
export type RetriesPolicy = z.infer<typeof RetriesPolicySchema>;
export type CircuitBreakerPolicy = z.infer<typeof CircuitBreakerPolicySchema>;

export const CapabilityConfigSchema = z.object({
  /** required=true: при недоступности сессия не стартует (CAPABILITY_UNAVAILABLE). */
  required: z.boolean().default(false),
  /** Упорядоченная цепочка fallback (v3 §IV.2). */
  chain: z.array(z.string().min(1).max(64)).default([]),
});
export type CapabilityConfig = z.infer<typeof CapabilityConfigSchema>;

export const CapabilitiesConfigSchema = z.object({
  capabilities: z.record(CapabilitySchema, CapabilityConfigSchema),
});
export type CapabilitiesConfig = z.infer<typeof CapabilitiesConfigSchema>;

export const ProviderPoliciesConfigSchema = z.object({
  policies: z.array(ProviderPolicySchema),
});
export type ProviderPoliciesConfig = z.infer<typeof ProviderPoliciesConfigSchema>;

export const LimitsConfigSchema = z.object({
  // --- партия
  maxPlayersPerSession: z.number().int().positive().max(12).default(12),
  actionsPerPlayerPerTurn: z.number().int().positive().default(5),
  maxMessageLen: z.number().int().positive().default(1000),
  chatRingBuffer: z.number().int().positive().default(500),

  // --- WebSocket
  wsRatePerConnection: z
    .object({
      ACTION_SUBMIT: z.number().int().positive().default(5),
      CHAT_PUBLIC: z.number().int().positive().default(10),
      DEFAULT: z.number().int().positive().default(20),
    })
    .default({}),
  wsMaxConnectionsPerIp: z.number().int().positive().default(20),
  wsMaxConnectionsPerPlayer: z.number().int().positive().default(4),
  wsMaxPayloadBytes: z.number().int().positive().default(65_536),
  wsAuthTimeoutMs: z.number().int().positive().default(5000),
  heartbeat: z
    .object({
      intervalMs: z.number().int().positive().default(20_000),
      idleTimeoutMs: z.number().int().positive().default(45_000),
    })
    .default({}),
  reconnect: z
    .object({
      baseMs: z.number().int().positive().default(500),
      factor: z.number().positive().default(2),
      capMs: z.number().int().positive().default(15_000),
      jitter: z.number().min(0).max(1).default(0.2),
      maxAttempts: z.number().int().positive().default(8),
    })
    .default({}),
  dedupeTtlMs: z.number().int().positive().default(300_000),

  // --- идемпотентность и outbox
  idempotencyTtlHours: z.number().int().positive().default(24),
  idempotencyInFlightTimeoutMs: z.number().int().positive().default(120_000),
  outboxBatchSize: z.number().int().positive().default(100),
  outboxPollMs: z.number().int().positive().default(250),
  outboxMaxAttempts: z.number().int().positive().default(5),

  // --- AI
  aiMaxConcurrentPerSession: z.number().int().positive().default(1),
  aiMaxRetriesPerTurn: z.number().int().min(0).default(2),
  aiContextMaxTokens: z.number().int().positive().default(24_000),
  aiSchemaRepairAttempts: z.number().int().min(0).default(1),

  // --- media / audio
  mediaMaxConcurrentPerSession: z.number().int().positive().default(2),
  mediaMaxRetriesPerJob: z.number().int().min(0).default(1),
  mediaPollMs: z.number().int().positive().default(1000),
  mediaJobTimeoutMs: z.number().int().positive().default(180_000),
  mediaCacheMaxRows: z.number().int().positive().default(5000),
  mediaMaxBytesPerSession: z.number().int().positive().default(524_288_000),
  audioMaxConcurrentPerSession: z.number().int().positive().default(1),
  audioMaxCharsPerTurn: z.number().int().positive().default(1200),

  // --- capability registry / event engine
  capabilityProbeMs: z.number().int().positive().default(30_000),
  eventCascadeMaxDepth: z.number().int().positive().default(3),
  handlerTimeoutMs: z.number().int().positive().default(5000),

  // --- бюджеты (этап 2; фактическое значение — после замера, D139)
  sessionBudgetUsd: z.number().nonnegative().default(5),
  budgetWarningRatio: z.number().min(0).max(1).default(0.8),

  // --- HTTP rate limit
  httpRatePerIpPerMin: z.number().int().positive().default(100),
  httpRatePerTokenPerMin: z.number().int().positive().default(300),
  httpRateAuthPerIpPerMin: z.number().int().positive().default(10),
  httpRateMutatingPerTokenPerMin: z.number().int().positive().default(30),

  // --- retention (промпт 3.2)
  journalKeepDays: z.number().int().positive().default(90),
  chatKeepDays: z.number().int().positive().default(180),
  auditKeepDays: z.number().int().positive().default(365),
  snapshotKeepPerSession: z.number().int().positive().default(50),
  snapshotKeepDays: z.number().int().positive().default(30),

  // --- AI-write allowlist (промпт 2.14, F-9.4)
  aiMutable: z
    .object({
      effectKinds: z
        .array(z.string().max(40))
        .default([
          'SET_FLAG',
          'CHANGE_OBJECT_STATE',
          'EMIT_NARRATIVE',
          'REQUEST_MEDIA',
          'GRANT_KNOWLEDGE',
          'REVEAL_OBJECT',
        ]),
      objectStateKeys: z.array(z.string().max(60)).default(['*']),
      forbiddenFlagPrefixes: z.array(z.string().max(40)).default(['system.', 'gm.', 'audit.']),
      maxProposedEventsPerTurn: z.number().int().positive().default(3),
      maxObjectChangesPerTurn: z.number().int().positive().default(10),
      maxPrivateMessagesPerTurn: z.number().int().positive().default(12),
      teleportAllowed: z.boolean().default(false),
      reachEndingAllowed: z.boolean().default(true),
    })
    .default({}),

  // --- HostBridge (промпт 2.13, F-6.5)
  hostbridge: z
    .object({
      maxClockSkewMs: z.number().int().positive().default(30_000),
      requestIdTtlMs: z.number().int().positive().default(300_000),
      heartbeatIntervalMs: z.number().int().positive().default(15_000),
      maxHosts: z.number().int().positive().default(1),
      maxFileBytes: z.number().int().positive().default(33_554_432),
    })
    .default({}),
});
export type LimitsConfig = z.infer<typeof LimitsConfigSchema>;
