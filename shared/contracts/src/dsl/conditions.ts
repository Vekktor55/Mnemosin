import { z } from 'zod';
import { ObjectId, PlayerId, Scalar } from '../ids.js';
import { ActionIntent } from '../domain/action.js';
import { StatePathSchema } from './state-path.js';

/**
 * Условия DSL (v3 §III.4) + операторы над действием, без которых правила
 * из реальных данных невыразимы (F-4.5, F-4.6).
 *
 * `FIRST_TIME` обязан содержать `entityId` (F-4.1/блокер B-06): «первый раз»
 * относительно чего-то, иначе условие не вычислимо.
 */

export const FirstTimeScope = z.enum(['LOCATION', 'OBJECT', 'EVENT']);
export type FirstTimeScope = z.infer<typeof FirstTimeScope>;

// ZodType<Condition, ZodTypeDef, unknown>: на входе бренды ещё не проставлены
// (input у branded-схем — обычный string), поэтому третий параметр ослаблен.
export const ConditionSchema: z.ZodType<Condition, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.discriminatedUnion('op', [
    z.object({ op: z.literal('AND'), items: z.array(ConditionSchema).min(1) }),
    z.object({ op: z.literal('OR'), items: z.array(ConditionSchema).min(1) }),
    z.object({ op: z.literal('NOT'), item: ConditionSchema }),
    z.object({ op: z.literal('EQ'), path: StatePathSchema, value: Scalar }),
    z.object({ op: z.literal('NEQ'), path: StatePathSchema, value: Scalar }),
    z.object({ op: z.literal('GT'), path: StatePathSchema, value: z.number() }),
    z.object({ op: z.literal('LT'), path: StatePathSchema, value: z.number() }),
    z.object({ op: z.literal('HAS_FLAG'), flagKey: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,79}$/) }),
    z.object({ op: z.literal('PLAYER_KNOWS'), playerId: PlayerId, key: z.string().max(80) }),
    z.object({ op: z.literal('FIRST_TIME'), scope: FirstTimeScope, entityId: z.string().min(1).max(64) }),
    // --- операторы над действием (F-4.5: predicate описывает условие НАРУШЕНИЯ)
    z.object({ op: z.literal('ACTION_INTENT'), intent: ActionIntent }),
    z.object({ op: z.literal('ACTION_TARGET'), objectId: ObjectId }),
    z.object({
      op: z.literal('ACTION_TEXT_MATCH'),
      /** Regex ≤200 символов; проверка на catastrophic backtracking — в движке (промпт 2.2). */
      pattern: z.string().min(1).max(200),
    }),
  ]),
);

export type Condition =
  | { op: 'AND'; items: Condition[] }
  | { op: 'OR'; items: Condition[] }
  | { op: 'NOT'; item: Condition }
  | { op: 'EQ'; path: z.infer<typeof StatePathSchema>; value: Scalar }
  | { op: 'NEQ'; path: z.infer<typeof StatePathSchema>; value: Scalar }
  | { op: 'GT'; path: z.infer<typeof StatePathSchema>; value: number }
  | { op: 'LT'; path: z.infer<typeof StatePathSchema>; value: number }
  | { op: 'HAS_FLAG'; flagKey: string }
  | { op: 'PLAYER_KNOWS'; playerId: PlayerId; key: string }
  | { op: 'FIRST_TIME'; scope: FirstTimeScope; entityId: string }
  | { op: 'ACTION_INTENT'; intent: ActionIntent }
  | { op: 'ACTION_TARGET'; objectId: ObjectId }
  | { op: 'ACTION_TEXT_MATCH'; pattern: string };

/** v1 `state_is{path, equals}` → EQ с полным StatePath (namespace по D174/K5). */
export function eqFlag(roomSlug: string | null, flag: string, value: Scalar): Condition {
  const key = roomSlug === null ? flag : `${roomSlug}.${flag}`;
  return { op: 'EQ', path: { kind: 'FLAG', key }, value };
}
