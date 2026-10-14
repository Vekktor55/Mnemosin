import type { PlayerAction } from '@mnemosin/contracts';
import type { ActionId, TurnId, PlayerId, IdempotencyKey } from '@mnemosin/contracts';

export interface ActionRepository {
  insert(action: PlayerAction): Promise<void>;
  findById(actionId: ActionId): Promise<PlayerAction | null>;
  listByTurn(turnId: TurnId): Promise<PlayerAction[]>;
  listByPlayer(playerId: PlayerId, limit?: number): Promise<PlayerAction[]>;
  findByIdempotencyKey(key: IdempotencyKey): Promise<PlayerAction | null>;
  countByTurn(turnId: TurnId): Promise<number>;
  /** Следующий sequenceId в рамках хода (для порядка подачи действий). */
  nextSequenceId(turnId: TurnId): Promise<number>;
}
