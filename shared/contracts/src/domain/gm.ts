import { z } from 'zod';
import { IsoDateTime } from '../time.js';
import { IdempotencyKey, NoteId, PlayerId, SessionId, TurnId } from '../ids.js';
import { TurnResolutionSchema } from './resolution.js';

/**
 * GM-сущности (v3 §II.15, §IV.8, §IV.10).
 *
 * Отклонение: `gm.finishTurn` удалён — переходом REVIEW→COMMITTED владеет
 * только `gm-review` (блокер B-09, D119).
 */

export const GMNoteVisibility = z.enum(['GM_ONLY', 'AI_DIRECTOR', 'PUBLIC_AFTER_COMMIT']);
export type GMNoteVisibility = z.infer<typeof GMNoteVisibility>;

export const GMNoteSchema = z.object({
  noteId: NoteId,
  sessionId: SessionId,
  turnId: TurnId.nullable(),
  visibility: GMNoteVisibility,
  text: z.string().min(1).max(4000),
  createdAt: IsoDateTime,
});
export type GMNote = z.infer<typeof GMNoteSchema>;

export const GMReviewDecisionKind = z.enum(['APPROVE', 'REJECT', 'EDIT_AND_APPROVE', 'RETRY_AI']);
export type GMReviewDecisionKind = z.infer<typeof GMReviewDecisionKind>;

export const GMReviewDecisionSchema = z.object({
  turnId: TurnId,
  decision: GMReviewDecisionKind,
  editedResolution: TurnResolutionSchema.nullable(),
  /** F-3.2: защита от lost update при параллельном редактировании. */
  baseResolutionHash: z.string().length(64).nullable(),
  comment: z.string().max(1000).nullable(),
  idempotencyKey: IdempotencyKey,
  decidedAt: IsoDateTime,
});
export type GMReviewDecision = z.infer<typeof GMReviewDecisionSchema>;

/** Действие GM для аудита (payload события GM_ACTION_PERFORMED и строки gm_audit). */
export const GmActionKind = z.enum([
  'createSession',
  'startSession',
  'pauseSession',
  'resumeSession',
  'endSession',
  'kickPlayer',
  'openTurn',
  'lockTurn',
  'unlockTurn',
  'cancelTurn',
  'retryTurn',
  'approve',
  'reject',
  'editAndApprove',
  'moveGroup',
  'sendSystemMessage',
  'addNote',
  'activateEvent',
  'forceApplyDeferred',
  'setFlag',
  'setNameRemembered',
  'requestScene',
  'cancelMediaJob',
  'reloadRules',
  'reloadWorldPack',
  'setCapability',
  'exportSession',
  'importSession',
]);
export type GmActionKind = z.infer<typeof GmActionKind>;

export const GmAuditEntrySchema = z.object({
  auditId: z.number().int().positive(),
  sessionId: SessionId,
  gmPlayerId: PlayerId,
  action: GmActionKind,
  meta: z.record(z.string(), z.unknown()),
  traceId: z.string().max(64),
  idempotencyKey: IdempotencyKey.nullable(),
  at: IsoDateTime,
});
export type GmAuditEntry = z.infer<typeof GmAuditEntrySchema>;
