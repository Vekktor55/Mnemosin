import type { ChatMessage, ChatVisibility } from '@mnemosin/contracts';
import type { MessageId, SessionId, PlayerId } from '@mnemosin/contracts';

export interface ChatRepository {
  insert(message: ChatMessage): Promise<void>;
  findById(messageId: MessageId): Promise<ChatMessage | null>;
  /** Лента сессии с учётом видимости вызывающего (WS_PRIVACY_POLICY применяется выше, в gateway). */
  listBySession(sessionId: SessionId, limit?: number): Promise<ChatMessage[]>;
  listForPlayer(sessionId: SessionId, playerId: PlayerId, limit?: number): Promise<ChatMessage[]>;
  listByVisibility(sessionId: SessionId, visibility: ChatVisibility, limit?: number): Promise<ChatMessage[]>;
}
