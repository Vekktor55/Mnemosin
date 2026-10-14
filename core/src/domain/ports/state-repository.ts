import type { GameState } from '@mnemosin/contracts';
import type { SessionId } from '@mnemosin/contracts';

/** Исход оптимистичной блокировки — отдельный тип, чтобы вызывающий не путал его с «нет строки». */
export type StateWriteResult =
  { readonly kind: 'ok'; readonly version: number } | { readonly kind: 'conflict'; readonly actualVersion: number };

export interface StateMutationRecord {
  readonly sessionId: SessionId;
  readonly turnId: string | null;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly mutations: unknown[];
  readonly createdAt: string;
}

export interface StateRepository {
  insert(state: GameState): Promise<void>;
  findBySession(sessionId: SessionId): Promise<GameState | null>;
  /**
   * Запись с оптимистичной блокировкой (критерий A1.5):
   * `UPDATE ... WHERE session_id = ? AND version = ?`.
   * Если версию кто-то уже поднял — возвращается `conflict` с фактической версией,
   * а строка НЕ изменяется. Вызывающий обязан перечитать состояние и повторить.
   */
  updateWithVersion(state: GameState, expectedVersion: number): Promise<StateWriteResult>;
  listHistory(sessionId: SessionId, limit?: number): Promise<StateMutationRecord[]>;
  appendHistory(record: StateMutationRecord): Promise<void>;
}
