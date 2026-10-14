import { and, desc, eq, lt, sql } from 'drizzle-orm';

import type { SessionId, Snapshot, SnapshotId, SnapshotListEntry } from '@mnemosin/contracts';
import type {
  AiDecisionDraft,
  AiDecisionRecord,
  AiDecisionRepository,
  SnapshotRepository,
} from '@mnemosin/core/domain/ports';

import type { Db, Executor } from '../client.js';
import { rowsAffectedOf } from '../mappers/index.js';
import { aiDecisionFromRow, snapshotFromRow, snapshotToRow } from '../mappers/misc-mappers.js';
import { aiDecisions, snapshots } from '../schema.js';

export class SqlSnapshotRepository implements SnapshotRepository {
  private readonly q: Db;

  constructor(ex: Executor) {
    this.q = ex as Db;
  }

  async insert(snapshot: Snapshot): Promise<void> {
    await this.q.insert(snapshots).values(snapshotToRow(snapshot)).run();
  }

  async findById(snapshotId: SnapshotId): Promise<Snapshot | null> {
    const rows = await this.q.select().from(snapshots).where(eq(snapshots.snapshotId, snapshotId)).limit(1);
    return rows[0] ? snapshotFromRow(rows[0]) : null;
  }

  async listBySession(sessionId: SessionId, limit = 50): Promise<SnapshotListEntry[]> {
    const rows = await this.q
      .select({
        id: snapshots.snapshotId,
        sessionId: snapshots.sessionId,
        label: snapshots.label,
        turnNumber: snapshots.turnNumber,
        createdByTurnId: snapshots.createdByTurnId,
        createdBy: snapshots.createdBy,
        checksum: snapshots.checksum,
        createdAt: snapshots.createdAt,
      })
      .from(snapshots)
      .where(eq(snapshots.sessionId, sessionId))
      .orderBy(desc(snapshots.turnNumber))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id as SnapshotId,
      sessionId: r.sessionId as SessionId,
      label: r.label,
      turnNumber: r.turnNumber,
      createdByTurnId: r.createdByTurnId as SnapshotListEntry['createdByTurnId'],
      createdBy: r.createdBy as SnapshotListEntry['createdBy'],
      checksum: r.checksum,
      createdAt: r.createdAt as SnapshotListEntry['createdAt'],
    }));
  }

  async findLatestBySession(sessionId: SessionId): Promise<Snapshot | null> {
    const rows = await this.q
      .select()
      .from(snapshots)
      .where(eq(snapshots.sessionId, sessionId))
      .orderBy(desc(snapshots.turnNumber))
      .limit(1);
    return rows[0] ? snapshotFromRow(rows[0]) : null;
  }

  async deleteOlderThan(sessionId: SessionId, turnNumber: number): Promise<number> {
    const res = await this.q
      .delete(snapshots)
      .where(and(eq(snapshots.sessionId, sessionId), lt(snapshots.turnNumber, turnNumber)))
      .run();
    return rowsAffectedOf(res);
  }
}

export class SqlAiDecisionRepository implements AiDecisionRepository {
  private readonly q: Db;

  constructor(ex: Executor) {
    this.q = ex as Db;
  }

  async append(draft: AiDecisionDraft): Promise<AiDecisionRecord> {
    const inserted = await this.q
      .insert(aiDecisions)
      .values({
        sessionId: draft.sessionId,
        turnId: draft.turnId,
        providerId: draft.providerId,
        model: draft.model,
        status: draft.status,
        promptHash: draft.promptHash,
        responseJson: draft.responseJson === null ? null : (JSON.parse(draft.responseJson) as Record<string, unknown>),
        violationsCount: draft.violationsCount,
        latencyMs: draft.latencyMs,
        errorCode: draft.errorCode,
        traceId: draft.traceId,
        createdAt: draft.createdAt,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('[database] ai_decisions.append: RETURNING не вернул строку');
    return aiDecisionFromRow(row);
  }

  async listByTurn(turnId: string): Promise<AiDecisionRecord[]> {
    const rows = await this.q
      .select()
      .from(aiDecisions)
      .where(eq(aiDecisions.turnId, turnId))
      .orderBy(desc(aiDecisions.id));
    return rows.map(aiDecisionFromRow).reverse();
  }

  async listBySession(sessionId: string, limit = 100): Promise<AiDecisionRecord[]> {
    const rows = await this.q
      .select()
      .from(aiDecisions)
      .where(eq(aiDecisions.sessionId, sessionId))
      .orderBy(desc(aiDecisions.id))
      .limit(limit);
    return rows.map(aiDecisionFromRow).reverse();
  }

  async countAll(): Promise<number> {
    const rows = await this.q.all<{ c: number }>(sql`SELECT count(*) AS c FROM ai_decisions`);
    return Number(rows[0]?.c ?? 0);
  }
}
