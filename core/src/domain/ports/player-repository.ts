import type { Player, PlayerStatus } from '@mnemosin/contracts';
import type { PlayerId, SessionId } from '@mnemosin/contracts';

export interface PlayerRepository {
  insert(player: Player): Promise<void>;
  findById(playerId: PlayerId): Promise<Player | null>;
  listBySession(sessionId: SessionId): Promise<Player[]>;
  setStatus(playerId: PlayerId, status: PlayerStatus, at: string): Promise<void>;
  update(player: Player): Promise<void>;
}
