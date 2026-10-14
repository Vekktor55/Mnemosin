import type { GMNote } from '@mnemosin/contracts';
import type { NoteId, SessionId, TurnId } from '@mnemosin/contracts';

export interface GmNoteRepository {
  insert(note: GMNote): Promise<void>;
  findById(noteId: NoteId): Promise<GMNote | null>;
  listBySession(sessionId: SessionId, limit?: number): Promise<GMNote[]>;
  listByTurn(turnId: TurnId): Promise<GMNote[]>;
}
