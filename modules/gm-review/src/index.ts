/**
 * @mnemosin/module-gm-review — GM-ревью черновика хода (промпт 1.8, п.6).
 *
 * Единственный владелец перехода REVIEW→COMMITTED (D119/F-8.6, блокер B-09):
 * approve/reject/retry делегируются Turn Engine через структурный порт
 * TurnEnginePort (инъекция в wiring, модули друг друга не импортируют — D161);
 * editAndApprove владеет проверкой baseResolutionHash (409 VERSION_CONFLICT c
 * актуальным resolution в meta — A1.8/F-3.2) и сохранением правки.
 *
 * `gm.finishTurn` УДАЛЁН из контракта gm (B-09); зависимости: [] — в частности
 * НЕ ['gm'] (F-8.6).
 */
export {
  gmReviewContract,
  ApproveInputSchema,
  ReviewDecisionOutputSchema,
  RejectInputSchema,
  RejectOutputSchema,
  RetryInputSchema,
  RetryOutputSchema,
  EditAndApproveInputSchema,
  EditAndApproveOutputSchema,
  PendingReviewsInputSchema,
  PendingReviewsOutputSchema,
  PendingReviewSchema,
  type ApproveInput,
  type ReviewDecisionOutput,
  type RejectInput,
  type RejectOutput,
  type RetryInput,
  type RetryOutput,
  type EditAndApproveInput,
  type EditAndApproveOutput,
  type PendingReviewsInput,
  type PendingReviewsOutput,
  type PendingReview,
} from './contract.js';
export { GmReviewService, type GmReviewDeps, type GmReviewLog, type TurnEnginePort } from './service.js';

export const PACKAGE_ID = '@mnemosin/module-gm-review';
export const IMPLEMENTED_IN_PROMPT = '1.8';
