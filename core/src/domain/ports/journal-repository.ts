import type { JournalEntry, JournalKind } from '@mnemosin/contracts';
import type { SessionId, TurnId } from '@mnemosin/contracts';

export interface JournalDraft {
  readonly turnId: TurnId;
  readonly sessionId: SessionId;
  readonly traceId: string;
  readonly kind: JournalKind;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export interface JournalRepository {
  /** id (монотонная последовательность сессии) присваивает БД. */
  append(draft: JournalDraft): Promise<JournalEntry>;
  appendMany(drafts: JournalDraft[]): Promise<JournalEntry[]>;
  listByTurn(turnId: TurnId): Promise<JournalEntry[]>;
  listBySession(sessionId: SessionId, limit?: number): Promise<JournalEntry[]>;
  /** Последний записанный id — для восстановления после сбоя (reconciled_on_boot). */
  lastId(sessionId: SessionId): Promise<number>;
}
