import {
  CharacterSchema,
  PlayerSchema,
  SessionSchema,
  type Character,
  type Player,
  type Session,
} from '@mnemosin/contracts';

import type { characters, players, sessions } from '../schema.js';
import { asJson, assertMatches, parseBody } from './index.js';

type SessionRow = typeof sessions.$inferSelect;
type PlayerRow = typeof players.$inferSelect;
type CharacterRow = typeof characters.$inferSelect;

export function sessionFromRow(row: SessionRow): Session {
  const body = parseBody(SessionSchema, row.bodyJson, 'sessions');
  assertMatches('session_id', row.sessionId, body.sessionId, 'sessions');
  assertMatches('status', row.status, body.status, 'sessions');
  assertMatches('updated_at', row.updatedAt, body.updatedAt, 'sessions');
  return body;
}

export function sessionToRow(session: Session): SessionRow {
  return {
    sessionId: session.sessionId,
    title: session.title,
    status: session.status,
    gmPlayerId: session.gmPlayerId,
    currentTurnId: session.currentTurnId,
    worldPackId: session.worldPackId,
    worldPackVersion: session.worldPackVersion,
    archivedAt: session.archivedAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    bodyJson: asJson(session as unknown, 'sessions.insert'),
  };
}

export function playerFromRow(row: PlayerRow): Player {
  const body = parseBody(PlayerSchema, row.bodyJson, 'players');
  assertMatches('player_id', row.playerId, body.playerId, 'players');
  assertMatches('session_id', row.sessionId, body.sessionId, 'players');
  assertMatches('status', row.status, body.status, 'players');
  return body;
}

export function playerToRow(player: Player): PlayerRow {
  return {
    playerId: player.playerId,
    sessionId: player.sessionId,
    characterId: player.characterId,
    displayName: player.displayName,
    isGm: player.isGM,
    status: player.status,
    joinedAt: player.joinedAt,
    leftAt: player.leftAt,
    bodyJson: asJson(player as unknown, 'players.insert'),
  };
}

export function characterFromRow(row: CharacterRow): Character {
  const body = parseBody(CharacterSchema, row.bodyJson, 'characters');
  assertMatches('character_id', row.characterId, body.characterId, 'characters');
  return body;
}

export function characterToRow(character: Character): CharacterRow {
  return {
    characterId: character.characterId,
    sessionId: character.sessionId,
    name: character.name,
    archetype: character.archetype,
    createdAt: character.createdAt,
    bodyJson: asJson(character as unknown, 'characters.insert'),
  };
}
