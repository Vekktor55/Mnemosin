import { z } from 'zod';
import { IsoDateTime } from '../time.js';
import { ErrorCode } from '../errors.js';
import { SessionId, TurnId } from '../ids.js';
import { TurnResolutionSchema } from './resolution.js';

/**
 * Turn (v3 §II.4–II.5) с отклонениями, зафиксированными в SPEC_STAGE1 §3.2:
 *  - `actionIds` удалён (F-1.17): источник истины — таблица `actions` + UNIQUE(turn_id, sequence_id);
 *  - `failedReason: string` заменён на структурированный `failed` (F-1.18);
 *  - добавлен переход `REVIEW → OPEN` для retry (F-3.1, D-решение SPEC §3.2).
 */

export const TurnStatus = z.enum(['OPEN', 'LOCKED', 'PROCESSING', 'REVIEW', 'COMMITTED', 'FAILED']);
export type TurnStatus = z.infer<typeof TurnStatus>;

export const TURN_TRANSITIONS: Readonly<Record<TurnStatus, readonly TurnStatus[]>> = Object.freeze({
  OPEN: ['LOCKED', 'FAILED'],
  LOCKED: ['OPEN', 'PROCESSING'],
  PROCESSING: ['REVIEW', 'FAILED'],
  REVIEW: ['COMMITTED', 'FAILED', 'OPEN'],
  COMMITTED: [],
  FAILED: [],
});

export const TurnTransitionTrigger = z.enum([
  'openTurn',
  'lockTurn',
  'unlockTurn',
  'cancelTurn',
  'startProcessing',
  'draftReady',
  'processingFailed',
  'commitTurn',
  'rejectTurn',
  'retry',
]);
export type TurnTransitionTrigger = z.infer<typeof TurnTransitionTrigger>;

/** Полная таблица переходов как данные (для тестов и GM-UI). */
export const TURN_TRANSITION_TABLE: ReadonlyArray<{
  readonly from: TurnStatus;
  readonly to: TurnStatus;
  readonly trigger: TurnTransitionTrigger;
  readonly actor: 'GM' | 'turn-engine' | 'ai-director' | 'gm-review';
  readonly idempotent: boolean;
}> = Object.freeze([
  { from: 'OPEN', to: 'LOCKED', trigger: 'lockTurn', actor: 'GM', idempotent: true },
  { from: 'LOCKED', to: 'OPEN', trigger: 'unlockTurn', actor: 'GM', idempotent: true },
  { from: 'LOCKED', to: 'PROCESSING', trigger: 'startProcessing', actor: 'turn-engine', idempotent: true },
  { from: 'PROCESSING', to: 'REVIEW', trigger: 'draftReady', actor: 'ai-director', idempotent: false },
  { from: 'PROCESSING', to: 'FAILED', trigger: 'processingFailed', actor: 'turn-engine', idempotent: false },
  { from: 'REVIEW', to: 'COMMITTED', trigger: 'commitTurn', actor: 'gm-review', idempotent: true },
  { from: 'REVIEW', to: 'FAILED', trigger: 'rejectTurn', actor: 'gm-review', idempotent: true },
  { from: 'REVIEW', to: 'OPEN', trigger: 'retry', actor: 'gm-review', idempotent: true },
  { from: 'OPEN', to: 'FAILED', trigger: 'cancelTurn', actor: 'GM', idempotent: true },
]);

export function isTurnTransitionAllowed(from: TurnStatus, to: TurnStatus): boolean {
  return TURN_TRANSITIONS[from].includes(to);
}

export const TurnFailureSchema = z.object({
  code: ErrorCode,
  message: z.string().max(500),
  meta: z.record(z.string(), z.unknown()).default({}),
  at: IsoDateTime,
});
export type TurnFailure = z.infer<typeof TurnFailureSchema>;

export const TurnSchema = z.object({
  turnId: TurnId,
  sessionId: SessionId,
  number: z.number().int().nonnegative(),
  status: TurnStatus,
  resolution: TurnResolutionSchema.nullable(),
  lockedAt: IsoDateTime.nullable(),
  processingStartedAt: IsoDateTime.nullable(),
  reviewReadyAt: IsoDateTime.nullable(),
  committedAt: IsoDateTime.nullable(),
  failed: TurnFailureSchema.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Turn = z.infer<typeof TurnSchema>;
