import { and, desc, eq, sql } from 'drizzle-orm';

import type { GameState, SessionId } from '@mnemosin/contracts';
import { nowIso } from '@mnemosin/contracts';
import type { StateMutationRecord, StateRepository, StateWriteResult } from '@mnemosin/core/domain/ports';

import type { Db, Executor } from '../client.js';
import { rowsAffectedOf } from '../mappers/index.js';
import { stateFromRow, stateToRow } from '../mappers/state-mappers.js';
import { gameState, stateHistory, worldStateVersion } from '../schema.js';

export class SqlStateRepository implements StateRepository {
  private readonly q: Db;

  constructor(ex: Executor) {
    this.q = ex as Db;
  }

  async insert(state: GameState): Promise<void> {
    await this.q.insert(gameState).values(stateToRow(state)).run();
    await this.bumpVersion(state.sessionId, state.version, state.updatedAt);
  }

  async findBySession(sessionId: SessionId): Promise<GameState | null> {
    const rows = await this.q.select().from(gameState).where(eq(gameState.sessionId, sessionId)).limit(1);
    return rows[0] ? stateFromRow(rows[0]) : null;
  }

  /**
   * Оптимистичная блокировка (критерий A1.5):
   *   UPDATE game_state SET ... WHERE session_id = ? AND version = ?
   * rowsAffected=0 → кто-то уже поднял версию → возвращаем conflict с фактической версией,
   * строка НЕ тронута. Никаких «прочитал-изменил-записал» без CAS.
   */
  async updateWithVersion(state: GameState, expectedVersion: number): Promise<StateWriteResult> {
    if (state.version !== expectedVersion + 1) {
      // Защита от вызова с неверным ожиданием: новая версия обязана быть ровно +1.
      throw new Error(
        `[database] updateWithVersion: state.version=${state.version}, expectedVersion=${expectedVersion} — ` +
          'новая версия обязана быть expectedVersion+1',
      );
    }
    const res = await this.q
      .update(gameState)
      .set(stateToRow(state))
      .where(and(eq(gameState.sessionId, state.sessionId), eq(gameState.version, expectedVersion)))
      .run();
    if (rowsAffectedOf(res) === 1) {
      await this.bumpVersion(state.sessionId, state.version, state.updatedAt);
      return { kind: 'ok', version: state.version };
    }
    const rows = await this.q
      .select({ version: gameState.version })
      .from(gameState)
      .where(eq(gameState.sessionId, state.sessionId))
      .limit(1);
    return { kind: 'conflict', actualVersion: rows[0]?.version ?? -1 };
  }

  async listHistory(sessionId: SessionId, limit = 100): Promise<StateMutationRecord[]> {
    const rows = await this.q
      .select()
      .from(stateHistory)
      .where(eq(stateHistory.sessionId, sessionId))
      .orderBy(desc(stateHistory.toVersion))
      .limit(limit);
    return rows.map((r) => ({
      sessionId: r.sessionId as SessionId,
      turnId: r.turnId,
      fromVersion: r.fromVersion,
      toVersion: r.toVersion,
      mutations: (r.mutationsJson as unknown[]) ?? [],
      createdAt: r.createdAt,
    }));
  }

  async appendHistory(record: StateMutationRecord): Promise<void> {
    await this.q
      .insert(stateHistory)
      .values({
        sessionId: record.sessionId,
        turnId: record.turnId,
        fromVersion: record.fromVersion,
        toVersion: record.toVersion,
        mutationsJson: record.mutations,
        createdAt: record.createdAt,
      })
      .run();
  }

  async currentVersion(sessionId: SessionId): Promise<number | null> {
    const rows = await this.q.all<{ v: number | null }>(
      sql`SELECT version AS v FROM world_state_version WHERE session_id = ${sessionId}`,
    );
    const value = rows[0]?.v;
    return value === undefined || value === null ? null : Number(value);
  }

  private async bumpVersion(sessionId: SessionId, version: number, at: string = nowIso()): Promise<void> {
    await this.q
      .insert(worldStateVersion)
      .values({ sessionId, version, updatedAt: at })
      .onConflictDoUpdate({ target: worldStateVersion.sessionId, set: { version, updatedAt: at } })
      .run();
  }
}
