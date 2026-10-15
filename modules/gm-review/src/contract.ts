import { z } from 'zod';
import {
  ErrorCode,
  IdempotencyKey,
  IsoDateTime,
  PlayerId,
  SessionId,
  TurnId,
  TurnResolutionSchema,
  TurnStatus,
  defineModule,
} from '@mnemosin/contracts';

/**
 * Контракт модуля gm-review (v3 §II.15; промпт 1.8, п.6).
 *
 * D119 (F-8.6, блокер B-09): gm-review — ЕДИНСТВЕННЫЙ владелец перехода
 * REVIEW→COMMITTED; вызывает turn.commitTurn инъекцией (структурный порт
 * TurnEnginePort), НЕ импортируя модуль turn (D161). `gm.finishTurn` удалён
 * из контракта gm. dependencies: [] — в частности НЕ ['gm'].
 *
 * Все команды требуют idempotencyKey (F-8.2).
 */

// ---------------------------------------------------------------- команды

const TraceId = z.string().min(1).max(64).optional();

export const ApproveInputSchema = z.object({
  turnId: TurnId,
  gmPlayerId: PlayerId,
  idempotencyKey: IdempotencyKey,
  traceId: TraceId,
});
export type ApproveInput = z.infer<typeof ApproveInputSchema>;

export const ReviewDecisionOutputSchema = z.object({
  turnId: TurnId,
  sessionId: SessionId,
  /** Версия GameState после коммита (B-08.4: повтор возвращает то же значение). */
  version: z.number().int().nonnegative(),
  replayed: z.boolean(),
});
export type ReviewDecisionOutput = z.infer<typeof ReviewDecisionOutputSchema>;

export const RejectInputSchema = z.object({
  turnId: TurnId,
  gmPlayerId: PlayerId,
  reason: z.string().min(1).max(500),
  /** Код отказа TurnFailure; default CONFLICT (D223). */
  code: ErrorCode.optional(),
  idempotencyKey: IdempotencyKey,
  traceId: TraceId,
});
export type RejectInput = z.infer<typeof RejectInputSchema>;

export const RejectOutputSchema = z.object({
  turnId: TurnId,
  sessionId: SessionId,
  status: TurnStatus,
  replayed: z.boolean(),
});
export type RejectOutput = z.infer<typeof RejectOutputSchema>;

export const RetryInputSchema = z.object({
  turnId: TurnId,
  gmPlayerId: PlayerId,
  idempotencyKey: IdempotencyKey,
  traceId: TraceId,
});
export type RetryInput = z.infer<typeof RetryInputSchema>;

export const RetryOutputSchema = z.object({
  turnId: TurnId,
  sessionId: SessionId,
  number: z.number().int().nonnegative(),
  status: TurnStatus,
  /** true — из FAILED создан новый ход (D118); false — REVIEW→OPEN. */
  createdNewTurn: z.boolean(),
  replayed: z.boolean(),
});
export type RetryOutput = z.infer<typeof RetryOutputSchema>;

export const EditAndApproveInputSchema = z.object({
  turnId: TurnId,
  gmPlayerId: PlayerId,
  /** Отредактированный черновик (валидируется TurnResolutionSchema). */
  editedResolution: TurnResolutionSchema,
  /** Хэш черновика, который GM видел при редактировании (F-3.2/A1.8). */
  baseResolutionHash: z.string().length(64),
  idempotencyKey: IdempotencyKey,
  traceId: TraceId,
});
export type EditAndApproveInput = z.infer<typeof EditAndApproveInputSchema>;

export const EditAndApproveOutputSchema = z.object({
  turnId: TurnId,
  sessionId: SessionId,
  version: z.number().int().nonnegative(),
  /** Хэш сохранённой отредактированной версии. */
  resolutionHash: z.string().length(64),
  replayed: z.boolean(),
});
export type EditAndApproveOutput = z.infer<typeof EditAndApproveOutputSchema>;

// ---------------------------------------------------------------- запросы

export const PendingReviewsInputSchema = z.object({ sessionId: SessionId });
export type PendingReviewsInput = z.infer<typeof PendingReviewsInputSchema>;

export const PendingReviewSchema = z.object({
  turnId: TurnId,
  number: z.number().int().nonnegative(),
  status: TurnStatus,
  reviewReadyAt: IsoDateTime.nullable(),
  resolution: TurnResolutionSchema.nullable(),
});
export type PendingReview = z.infer<typeof PendingReviewSchema>;

export const PendingReviewsOutputSchema = z.array(PendingReviewSchema);
export type PendingReviewsOutput = z.infer<typeof PendingReviewsOutputSchema>;

// ---------------------------------------------------------------- контракт

export const gmReviewContract = defineModule({
  moduleId: 'gm-review',
  purpose:
    'GM-ревью черновика хода: approve/reject/editAndApprove/retry — единственный владелец REVIEW→COMMITTED (D119, B-09)',
  version: '0.1.0',
  commands: {
    approve: { input: ApproveInputSchema, output: ReviewDecisionOutputSchema },
    reject: { input: RejectInputSchema, output: RejectOutputSchema },
    editAndApprove: { input: EditAndApproveInputSchema, output: EditAndApproveOutputSchema },
    retry: { input: RetryInputSchema, output: RetryOutputSchema },
  },
  queries: {
    pendingReviews: { input: PendingReviewsInputSchema, output: PendingReviewsOutputSchema },
  },
  idempotentCommands: ['approve', 'reject', 'editAndApprove', 'retry'],
  emits: ['GM_REVIEW_DECIDED'],
  subscribes: ['TURN_DRAFT_READY'], // EVENT_SUBSCRIBERS (contracts): уведомление GM о черновике
  ports: [],
  dependencies: [], // НЕ ['gm'] — F-8.6/D119
  capabilities: [],
});
