import type { Turn, TurnStatus } from '@mnemosin/contracts';
import type { SessionId, TurnId } from '@mnemosin/contracts';

export interface TurnRepository {
  insert(turn: Turn): Promise<Turn>;
  findById(turnId: TurnId): Promise<Turn | null>;
  /** Текущий (последний по номеру) ход сессии. */
  findLatestBySession(sessionId: SessionId): Promise<Turn | null>;
  listBySession(sessionId: SessionId, limit?: number): Promise<Turn[]>;
  /**
   * Перевод статуса. `expectedStatus` — CAS-страховка от гонки двух движков:
   * если статус в БД уже другой, запись не происходит и возвращается false.
   */
  setStatus(turnId: TurnId, status: TurnStatus, expectedStatus?: TurnStatus): Promise<boolean>;
  update(turn: Turn): Promise<void>;
}
