import { z } from 'zod';
import {
  ErrorCode,
  IdempotencyKey,
  JournalEntrySchema,
  PlayerId,
  SessionId,
  TurnId,
  TurnSchema,
  TurnStatus,
  defineModule,
} from '@mnemosin/contracts';

/**
 * Контракт модуля turn — Turn Engine (v3 §III.1–III.3; промпт 1.8, п.1).
 *
 * Границы владения (B-09/D119):
 *  - resolveTurn/commitTurn/rejectTurn/retryTurn — механизм переходов и применения
 *    черновика; владелец REVIEW→COMMITTED — gm-review, который ВЫЗЫВАЕТ
 *    turn.commitTurn (инъекцией, не импортом — D161);
 *  - editAndApprove здесь НЕТ — им владеет gm-review (промпт 1.8, п.6);
 *  - openTurn/lockTurn/unlockTurn/cancelTurn/submitAction — команды лобби/GM,
 *    реализованы TurnService (промпт 1.6); контракт декларирует их события
 *    (TURN_OPENED/TURN_LOCKED/TURN_UNLOCKED) как принадлежащие модулю turn
 *    (EVENT_EMITTERS, contracts).
 *
 * dependencies: ['ai-director'] — ДЕКЛАРАТИВНО (D161/D227): вызов через
 * инжектируемый DraftGeneratorPort, импорта модуля нет.
 */

// ---------------------------------------------------------------- команды

export const ResolveTurnInputSchema = z.object({
  turnId: TurnId,
  traceId: z.string().min(1).max(64).optional(),
});
export type ResolveTurnInput = z.infer<typeof ResolveTurnInputSchema>;

export const ResolveTurnOutputSchema = z.object({
  turnId: TurnId,
  sessionId: SessionId,
  status: TurnStatus,
  /** Хэш сохранённого черновика — baseResolutionHash для editAndApprove (F-3.2). */
  resolutionHash: z.string().length(64),
  /** SOFT_REJECT/WARN подняли флаг обязательного ревью GM. */
  requiresGM: z.boolean(),
  replayed: z.boolean(),
});
export type ResolveTurnOutput = z.infer<typeof ResolveTurnOutputSchema>;

/** Решение GM, сопровождающее вызов команды (журнал + GM_REVIEW_DECIDED). */
export const CommitGmDecisionSchema = z.object({
  gmPlayerId: PlayerId,
  kind: z.enum(['APPROVE', 'EDIT_AND_APPROVE']),
});
export type CommitGmDecision = z.infer<typeof CommitGmDecisionSchema>;

export const ReviewerGmDecisionSchema = z.object({
  gmPlayerId: PlayerId,
});
export type ReviewerGmDecision = z.infer<typeof ReviewerGmDecisionSchema>;

export const CommitTurnInputSchema = z.object({
  turnId: TurnId,
  idempotencyKey: IdempotencyKey,
  traceId: z.string().min(1).max(64).optional(),
  /** Присутствует при вызове из gm-review: PROPOSED→APPROVED + GM_REVIEW_DECIDED. */
  gmDecision: CommitGmDecisionSchema.optional(),
});
export type CommitTurnInput = z.infer<typeof CommitTurnInputSchema>;

export const CommitTurnOutputSchema = z.object({
  turnId: TurnId,
  sessionId: SessionId,
  /** Версия GameState после коммита — то, что получает клиент (B-08.4). */
  version: z.number().int().nonnegative(),
  replayed: z.boolean(),
});
export type CommitTurnOutput = z.infer<typeof CommitTurnOutputSchema>;

export const RejectTurnInputSchema = z.object({
  turnId: TurnId,
  reason: z.string().min(1).max(500),
  /** Код отказа (TurnFailure.code); по умолчанию CONFLICT (D223). */
  code: ErrorCode.optional(),
  idempotencyKey: IdempotencyKey,
  traceId: z.string().min(1).max(64).optional(),
  gmDecision: ReviewerGmDecisionSchema.optional(),
});
export type RejectTurnInput = z.infer<typeof RejectTurnInputSchema>;

export const RejectTurnOutputSchema = z.object({
  turnId: TurnId,
  sessionId: SessionId,
  status: TurnStatus,
  replayed: z.boolean(),
});
export type RejectTurnOutput = z.infer<typeof RejectTurnOutputSchema>;

export const RetryTurnInputSchema = z.object({
  turnId: TurnId,
  idempotencyKey: IdempotencyKey,
  traceId: z.string().min(1).max(64).optional(),
  gmDecision: ReviewerGmDecisionSchema.optional(),
});
export type RetryTurnInput = z.infer<typeof RetryTurnInputSchema>;

export const RetryTurnOutputSchema = z.object({
  turnId: TurnId,
  sessionId: SessionId,
  number: z.number().int().nonnegative(),
  status: TurnStatus,
  /** true — из FAILED создан НОВЫЙ ход (D118); false — REVIEW→OPEN того же хода. */
  createdNewTurn: z.boolean(),
  replayed: z.boolean(),
});
export type RetryTurnOutput = z.infer<typeof RetryTurnOutputSchema>;

// ---------------------------------------------------------------- запросы

export const GetTurnInputSchema = z.object({ turnId: TurnId });
export type GetTurnInput = z.infer<typeof GetTurnInputSchema>;

export const ListTurnsInputSchema = z.object({
  sessionId: SessionId,
  limit: z.number().int().positive().max(500).optional(),
});
export type ListTurnsInput = z.infer<typeof ListTurnsInputSchema>;

export const GetJournalInputSchema = z.object({ turnId: TurnId });
export type GetJournalInput = z.infer<typeof GetJournalInputSchema>;

// ---------------------------------------------------------------- контракт

export const turnContract = defineModule({
  moduleId: 'turn',
  purpose:
    'Turn Engine: resolveTurn (LOCKED→PROCESSING→REVIEW/FAILED), commitTurn (REVIEW→COMMITTED + применение черновика), reject/retry (v3 §III.1–III.3)',
  version: '0.1.0',
  commands: {
    resolveTurn: { input: ResolveTurnInputSchema, output: ResolveTurnOutputSchema },
    commitTurn: { input: CommitTurnInputSchema, output: CommitTurnOutputSchema },
    rejectTurn: { input: RejectTurnInputSchema, output: RejectTurnOutputSchema },
    retryTurn: { input: RetryTurnInputSchema, output: RetryTurnOutputSchema },
  },
  queries: {
    getTurn: { input: GetTurnInputSchema, output: TurnSchema },
    listTurns: { input: ListTurnsInputSchema, output: z.array(TurnSchema) },
    getJournal: { input: GetJournalInputSchema, output: z.array(JournalEntrySchema) },
  },
  // resolveTurn — детерминированный СЕРВЕРНЫЙ ключ `resolve:{turnId}` (B-08),
  // клиентский ключ не требуется; остальные команды принимают ключ от вызывающего.
  idempotentCommands: ['commitTurn', 'rejectTurn', 'retryTurn'],
  emits: [
    'TURN_OPENED',
    'TURN_LOCKED',
    'TURN_UNLOCKED',
    'TURN_PROCESSING_STARTED',
    'TURN_DRAFT_READY',
    'TURN_COMMITTED',
    'TURN_FAILED',
    'STATE_COMMITTED',
  ],
  subscribes: [],
  ports: ['AIPort', 'RulesPort'], // AIPort — через ai-director (D115/D227)
  dependencies: ['ai-director'], // декларативно (D161): инъекция DraftGeneratorPort
  capabilities: [],
});
