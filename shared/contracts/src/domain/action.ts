import { z } from 'zod';
import { IsoDateTime } from '../time.js';
import { ActionId, IdempotencyKey, ObjectId, PlayerId, TurnId } from '../ids.js';

/**
 * PlayerAction (v3 §II.6).
 *
 * Отклонение: `meta.intent` — enum, а не свободная строка (F-4.6): Rules Engine
 * и проверка `exit.locked` опираются на intent='MOVE', свободная строка делала
 * правила неработоспособными.
 */

export const ActionIntent = z.enum(['SPEAK', 'ACT', 'MOVE', 'USE', 'OBSERVE', 'WAIT', 'CUSTOM']);
export type ActionIntent = z.infer<typeof ActionIntent>;

export const ActionMetaSchema = z.object({
  targetObjectId: ObjectId.nullable().default(null),
  targetPlayerId: PlayerId.nullable().default(null),
  intent: ActionIntent.nullable().default(null),
  /** Свободный текст уточнения для CUSTOM (например «notice:own_belongings» из v1). */
  customLabel: z.string().max(80).nullable().default(null),
});
export type ActionMeta = z.infer<typeof ActionMetaSchema>;

export const PlayerActionSchema = z.object({
  actionId: ActionId,
  turnId: TurnId,
  playerId: PlayerId,
  /** Назначается сервером в транзакции (max+1); UNIQUE(turn_id, sequence_id). */
  sequenceId: z.number().int().positive(),
  rawText: z.string().min(1).max(4000),
  meta: ActionMetaSchema.default({}),
  idempotencyKey: IdempotencyKey,
  createdAt: IsoDateTime,
});
export type PlayerAction = z.infer<typeof PlayerActionSchema>;
