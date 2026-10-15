import { z } from 'zod';
import { IsoDateTime } from '../time.js';
import { SessionId, TurnId } from '../ids.js';

/**
 * Turn journal (v3 §III.3, §II.18). Append-only; каждая запись несёт traceId
 * (v3 §VIII.4) и тип шага — F-1.10: структура записи в v3 не была определена.
 */

export const JournalKind = z.enum([
  'turn_opened',
  'turn_locked',
  'turn_unlocked',
  'turn_cancelled',
  // contracts 0.4.0 (промпт 1.6, D218): подача действия — шаг хронологии хода;
  // без него submitAction не мог писать журнал («все команды пишут journal», промпт 1.6 п.2).
  'action_submitted',
  'processing_started',
  'ai_context_built',
  'ai_call_started',
  'ai_call_finished',
  'ai_call_failed',
  'ai_violations',
  'rules_evaluated',
  'draft_ready',
  'gm_decision',
  'commit_started',
  'state_applied',
  'effects_applied',
  'events_fired',
  'effects_deferred',
  'committed',
  'failed',
  // contracts 0.5.0 (промпт 1.8): финал достигнут применением REACH_ENDING —
  // в этапе 1 только журнал, endSession — этап 3 (промпт 1.8, п.4).
  'ending_reached',
  'snapshot_taken',
  'reconciled_on_boot',
]);
export type JournalKind = z.infer<typeof JournalKind>;

export const JournalEntrySchema = z.object({
  id: z.number().int().positive(),
  turnId: TurnId,
  sessionId: SessionId,
  traceId: z.string().max(64),
  kind: JournalKind,
  payload: z.record(z.string(), z.unknown()),
  createdAt: IsoDateTime,
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

/** Запись outbox до публикации (v3 §III.3). */
export const OutboxStatus = z.enum(['PENDING', 'PUBLISHED', 'DEAD']);
export type OutboxStatus = z.infer<typeof OutboxStatus>;

export const OutboxRecordSchema = z.object({
  id: z.number().int().positive(),
  eventName: z.string().min(1).max(80),
  payloadJson: z.string(),
  traceId: z.string().max(64),
  status: OutboxStatus,
  attempts: z.number().int().nonnegative(),
  lastError: z.string().max(500).nullable(),
  emittedAt: IsoDateTime,
  publishedAt: IsoDateTime.nullable(),
});
export type OutboxRecord = z.infer<typeof OutboxRecordSchema>;
