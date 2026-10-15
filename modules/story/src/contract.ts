import { z } from 'zod';
import { FlagKey, KnowledgeSource, PlayerId, Scalar, SessionId, TurnId, defineModule } from '@mnemosin/contracts';

/**
 * Контракт модуля story (v3 §IV.10; промпт 1.9, п.3).
 *
 * D120 (F-8.4): состояние пишется ТОЛЬКО через core/state-service.apply —
 * не напрямую в репозиторий. Идемпотентность — детерминированные серверные
 * ключи (образец D217 moveGroup): повтор той же операции (тот же флаг/значение)
 * → replay без второго подъёма version.
 */

export const SetFlagInputSchema = z.object({
  sessionId: SessionId,
  key: FlagKey,
  value: Scalar,
  setBy: z.enum(['AI_APPROVED', 'GM', 'ENGINE']),
  turnId: TurnId.nullish(),
  traceId: z.string().min(1).max(64).optional(),
});
export type SetFlagInput = z.infer<typeof SetFlagInputSchema>;

export const SetFlagOutputSchema = z.object({
  sessionId: SessionId,
  version: z.number().int().nonnegative(),
  changedKeys: z.array(z.string().max(120)),
  replayed: z.boolean(),
});
export type SetFlagOutput = z.infer<typeof SetFlagOutputSchema>;

export const GrantKnowledgeInputSchema = z.object({
  sessionId: SessionId,
  playerId: PlayerId,
  key: z.string().min(1).max(80),
  value: Scalar,
  source: KnowledgeSource,
  turnId: TurnId.nullish(),
  traceId: z.string().min(1).max(64).optional(),
});
export type GrantKnowledgeInput = z.infer<typeof GrantKnowledgeInputSchema>;

export const GrantKnowledgeOutputSchema = z.object({
  sessionId: SessionId,
  version: z.number().int().nonnegative(),
  replayed: z.boolean(),
});
export type GrantKnowledgeOutput = z.infer<typeof GrantKnowledgeOutputSchema>;

export const KnownFactSchema = z.object({
  playerId: PlayerId,
  key: z.string().max(80),
  value: Scalar,
  source: KnowledgeSource,
  learnedAtTurnId: TurnId.nullable(),
});
export type KnownFact = z.infer<typeof KnownFactSchema>;

export const ListKnownFactsInputSchema = z.object({
  sessionId: SessionId,
  playerId: PlayerId.optional(),
});
export type ListKnownFactsInput = z.infer<typeof ListKnownFactsInputSchema>;

export const ListKnownFactsOutputSchema = z.array(KnownFactSchema);
export type ListKnownFactsOutput = z.infer<typeof ListKnownFactsOutputSchema>;

export const storyContract = defineModule({
  moduleId: 'story',
  purpose: 'История/факты партии: флаги и знания игроков — запись только через StateService (v3 §IV.10, D120/F-8.4)',
  version: '0.1.0',
  commands: {
    setFlag: { input: SetFlagInputSchema, output: SetFlagOutputSchema },
    grantKnowledge: { input: GrantKnowledgeInputSchema, output: GrantKnowledgeOutputSchema },
  },
  queries: {
    listKnownFacts: { input: ListKnownFactsInputSchema, output: ListKnownFactsOutputSchema },
  },
  // Ключи детерминированные серверные (D217-образец) — клиентский ключ не нужен.
  idempotentCommands: [],
  emits: [], // STATE_COMMITTED эмитит StateService (владелец 'turn' по EVENT_EMITTERS)
  subscribes: ['STATE_COMMITTED'], // EVENT_SUBSCRIBERS; этап 1 — декларативно (log-only)
  ports: [],
  dependencies: [],
  capabilities: [],
});
