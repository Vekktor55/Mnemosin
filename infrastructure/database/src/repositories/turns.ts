import { and, desc, eq, sql } from 'drizzle-orm';

import {
  nowIso,
  type ActionId,
  type IdempotencyKey,
  type PlayerAction,
  type PlayerId,
  type SessionId,
  type Turn,
  type TurnId,
  type TurnStatus,
} from '@mnemosin/contracts';
import type { ActionRepository, TurnRepository } from '@mnemosin/core/domain/ports';

import type { Db, Executor } from '../client.js';
import { actionFromRow, actionToRow, turnFromRow, turnToRow } from '../mappers/turn-mappers.js';
import { rowsAffectedOf } from '../mappers/index.js';
import { actions, turns } from '../schema.js';

/** Какой фазовый timestamp проставить при переходе (v3 §IV: у каждой фазы есть время входа). */
const STATUS_TIMESTAMP_FIELD = {
  LOCKED: 'lockedAt',
  PROCESSING: 'processingStartedAt',
  REVIEW: 'reviewReadyAt',
  COMMITTED: 'committedAt',
} as const satisfies Partial<Record<TurnStatus, string>>;

export class SqlTurnRepository implements TurnRepository {
  private readonly q: Db;

  constructor(ex: Executor) {
    this.q = ex as Db;
  }

  async insert(turn: Turn): Promise<Turn> {
    await this.q.insert(turns).values(turnToRow(turn)).run();
    return turn;
  }

  async findById(turnId: TurnId): Promise<Turn | null> {
    const rows = await this.q.select().from(turns).where(eq(turns.turnId, turnId)).limit(1);
    return rows[0] ? turnFromRow(rows[0]) : null;
  }

  async findLatestBySession(sessionId: SessionId): Promise<Turn | null> {
    const rows = await this.q
      .select()
      .from(turns)
      .where(eq(turns.sessionId, sessionId))
      .orderBy(desc(turns.number))
      .limit(1);
    return rows[0] ? turnFromRow(rows[0]) : null;
  }

  async listBySession(sessionId: SessionId, limit = 100): Promise<Turn[]> {
    const rows = await this.q
      .select()
      .from(turns)
      .where(eq(turns.sessionId, sessionId))
      .orderBy(desc(turns.number))
      .limit(limit);
    return rows.map(turnFromRow);
  }

  /**
   * CAS-переход статуса: `WHERE turn_id = ? AND status = <ожидаемый>`.
   * Возвращает false, если статус уже изменился (два движка одновременно — второй проигрывает).
   */
  async setStatus(turnId: TurnId, status: TurnStatus, expectedStatus?: TurnStatus): Promise<boolean> {
    const rows = await this.q.select().from(turns).where(eq(turns.turnId, turnId)).limit(1);
    const row = rows[0];
    if (!row) return false;
    const expected = expectedStatus ?? (row.status as TurnStatus);
    if (row.status !== expected) return false;

    const at = nowIso();
    const body: Record<string, unknown> = { ...(row.bodyJson as Record<string, unknown>), status, updatedAt: at };
    const stampField = STATUS_TIMESTAMP_FIELD[status as keyof typeof STATUS_TIMESTAMP_FIELD];
    if (stampField) body[stampField] = at;

    const patch: Record<string, unknown> = { status, updatedAt: at, bodyJson: body };
    if (stampField) patch[stampField] = at;

    const res = await this.q
      .update(turns)
      .set(patch)
      .where(and(eq(turns.turnId, turnId), eq(turns.status, expected)))
      .run();
    return rowsAffectedOf(res) === 1;
  }

  async update(turn: Turn): Promise<void> {
    await this.q.update(turns).set(turnToRow(turn)).where(eq(turns.turnId, turn.turnId)).run();
  }
}

export class SqlActionRepository implements ActionRepository {
  private readonly q: Db;

  constructor(ex: Executor) {
    this.q = ex as Db;
  }

  async insert(action: PlayerAction): Promise<void> {
    await this.q.insert(actions).values(actionToRow(action)).run();
  }

  async findById(actionId: ActionId): Promise<PlayerAction | null> {
    const rows = await this.q.select().from(actions).where(eq(actions.actionId, actionId)).limit(1);
    return rows[0] ? actionFromRow(rows[0]) : null;
  }

  async listByTurn(turnId: TurnId): Promise<PlayerAction[]> {
    const rows = await this.q
      .select()
      .from(actions)
      .where(eq(actions.turnId, turnId))
      .orderBy(sql`${actions.sequenceId} ASC`);
    return rows.map(actionFromRow);
  }

  async listByPlayer(playerId: PlayerId, limit = 100): Promise<PlayerAction[]> {
    const rows = await this.q
      .select()
      .from(actions)
      .where(eq(actions.playerId, playerId))
      .orderBy(desc(actions.createdAt))
      .limit(limit);
    return rows.map(actionFromRow);
  }

  async findByIdempotencyKey(key: IdempotencyKey): Promise<PlayerAction | null> {
    const rows = await this.q.select().from(actions).where(eq(actions.idempotencyKey, key)).limit(1);
    return rows[0] ? actionFromRow(rows[0]) : null;
  }

  async countByTurn(turnId: TurnId): Promise<number> {
    const rows = await this.q.all<{ c: number }>(sql`SELECT count(*) AS c FROM actions WHERE turn_id = ${turnId}`);
    return Number(rows[0]?.c ?? 0);
  }

  async nextSequenceId(turnId: TurnId): Promise<number> {
    const rows = await this.q.all<{ m: number | null }>(
      sql`SELECT max(sequence_id) AS m FROM actions WHERE turn_id = ${turnId}`,
    );
    return Number(rows[0]?.m ?? 0) + 1;
  }
}
