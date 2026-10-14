import { and, desc, eq, sql } from 'drizzle-orm';

import {
  nowIso,
  type Character,
  type Player,
  type PlayerId,
  type PlayerStatus,
  type Session,
  type SessionId,
} from '@mnemosin/contracts';
import type {
  CharacterRepository,
  PlayerRepository,
  SessionPhasePatch,
  SessionRepository,
} from '@mnemosin/core/domain/ports';

import type { Db, Executor } from '../client.js';
import { characters, players, sessions } from '../schema.js';
import {
  characterFromRow,
  characterToRow,
  playerFromRow,
  playerToRow,
  sessionFromRow,
  sessionToRow,
} from '../mappers/session-mappers.js';

/**
 * Репозитории сессии/игроков/персонажей (промпт 1.4).
 *
 * `ex as Db` — приведение только для TypeScript: drizzle отдаёт у транзакции тот же набор
 * методов (select/insert/update/delete/run/all), а поведение определяется переданным объектом.
 * Так один и тот же репозиторий работает и вне транзакции, и внутри неё.
 */
export class SqlSessionRepository implements SessionRepository {
  private readonly q: Db;

  constructor(ex: Executor) {
    this.q = ex as Db;
  }

  async insert(session: Session): Promise<void> {
    await this.q.insert(sessions).values(sessionToRow(session)).run();
  }

  async findById(sessionId: SessionId): Promise<Session | null> {
    const rows = await this.q.select().from(sessions).where(eq(sessions.sessionId, sessionId)).limit(1);
    return rows[0] ? sessionFromRow(rows[0]) : null;
  }

  async findActive(): Promise<Session | null> {
    const rows = await this.q
      .select()
      .from(sessions)
      .where(eq(sessions.status, 'ACTIVE'))
      .orderBy(desc(sessions.updatedAt))
      .limit(1);
    return rows[0] ? sessionFromRow(rows[0]) : null;
  }

  async update(session: Session): Promise<void> {
    await this.q.update(sessions).set(sessionToRow(session)).where(eq(sessions.sessionId, session.sessionId)).run();
  }

  async patchPhase(sessionId: SessionId, patch: SessionPhasePatch): Promise<void> {
    const rows = await this.q.select().from(sessions).where(eq(sessions.sessionId, sessionId)).limit(1);
    const row = rows[0];
    if (!row) throw new Error(`[database] patchPhase: сессия ${sessionId} не найдена`);
    const body = { ...(row.bodyJson as Record<string, unknown>) };
    if (patch.status !== undefined) body['status'] = patch.status;
    if (patch.currentTurnId !== undefined) body['currentTurnId'] = patch.currentTurnId;
    const updatedAt = patch.updatedAt ?? nowIso();
    body['updatedAt'] = updatedAt;
    await this.q
      .update(sessions)
      .set({
        status: patch.status ?? row.status,
        currentTurnId: patch.currentTurnId === undefined ? row.currentTurnId : patch.currentTurnId,
        updatedAt,
        bodyJson: body,
      })
      .where(eq(sessions.sessionId, sessionId))
      .run();
  }

  async listAll(): Promise<Session[]> {
    const rows = await this.q.select().from(sessions).orderBy(desc(sessions.updatedAt));
    return rows.map(sessionFromRow);
  }
}

export class SqlPlayerRepository implements PlayerRepository {
  private readonly q: Db;

  constructor(ex: Executor) {
    this.q = ex as Db;
  }

  async insert(player: Player): Promise<void> {
    await this.q.insert(players).values(playerToRow(player)).run();
  }

  async findById(playerId: PlayerId): Promise<Player | null> {
    const rows = await this.q.select().from(players).where(eq(players.playerId, playerId)).limit(1);
    return rows[0] ? playerFromRow(rows[0]) : null;
  }

  async listBySession(sessionId: SessionId): Promise<Player[]> {
    const rows = await this.q.select().from(players).where(eq(players.sessionId, sessionId));
    return rows.map(playerFromRow);
  }

  async setStatus(playerId: PlayerId, status: PlayerStatus, at: string): Promise<void> {
    const rows = await this.q.select().from(players).where(eq(players.playerId, playerId)).limit(1);
    const row = rows[0];
    if (!row) throw new Error(`[database] setStatus: игрок ${playerId} не найден`);
    const body: Record<string, unknown> = { ...(row.bodyJson as Record<string, unknown>), status };
    if (status === 'LEFT') body['leftAt'] = at;
    await this.q
      .update(players)
      .set({ status, leftAt: status === 'LEFT' ? at : row.leftAt, bodyJson: body })
      .where(eq(players.playerId, playerId))
      .run();
  }

  async update(player: Player): Promise<void> {
    await this.q.update(players).set(playerToRow(player)).where(eq(players.playerId, player.playerId)).run();
  }
}

export class SqlCharacterRepository implements CharacterRepository {
  private readonly q: Db;

  constructor(ex: Executor) {
    this.q = ex as Db;
  }

  async insert(character: Character): Promise<void> {
    await this.q.insert(characters).values(characterToRow(character)).run();
  }

  async findById(characterId: string): Promise<Character | null> {
    const rows = await this.q.select().from(characters).where(eq(characters.characterId, characterId)).limit(1);
    return rows[0] ? characterFromRow(rows[0]) : null;
  }

  async findByPlayer(playerId: PlayerId): Promise<Character | null> {
    const rows = await this.q
      .select({ row: characters })
      .from(characters)
      .innerJoin(players, eq(players.characterId, characters.characterId))
      .where(eq(players.playerId, playerId))
      .limit(1);
    return rows[0] ? characterFromRow(rows[0].row) : null;
  }

  async listBySession(sessionId: SessionId): Promise<Character[]> {
    const rows = await this.q.select().from(characters).where(eq(characters.sessionId, sessionId));
    return rows.map(characterFromRow);
  }

  async update(character: Character): Promise<void> {
    await this.q
      .update(characters)
      .set(characterToRow(character))
      .where(eq(characters.characterId, character.characterId))
      .run();
  }

  async countAll(): Promise<number> {
    const rows = await this.q.all<{ c: number }>(sql`SELECT count(*) AS c FROM characters`);
    return Number(rows[0]?.c ?? 0);
  }
}

/** Условие «игрок принадлежит сессии» — используется в HTTP/WS слоях (промпт 1.9). */
export function playerInSessionCondition(sessionId: SessionId, playerId: PlayerId) {
  return and(eq(players.sessionId, sessionId), eq(players.playerId, playerId));
}
