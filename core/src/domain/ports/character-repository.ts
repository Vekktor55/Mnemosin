import type { Character } from '@mnemosin/contracts';
import type { CharacterId, SessionId, PlayerId } from '@mnemosin/contracts';

export interface CharacterRepository {
  insert(character: Character): Promise<void>;
  findById(characterId: CharacterId): Promise<Character | null>;
  findByPlayer(playerId: PlayerId): Promise<Character | null>;
  listBySession(sessionId: SessionId): Promise<Character[]>;
  update(character: Character): Promise<void>;
}
