import { and, desc, eq, lt } from 'drizzle-orm';

import type { SessionId, Snapshot, SnapshotId, SnapshotListEntry } from '@mnemosin/contracts';
import type { SnapshotRepository } from '@mnemosin/core/domain/ports';

import type { Db, Executor } from '../client.js';
import { rowsAffectedOf } from '../mappers/index.js';
import { snapshotFromRow, snapshotToRow } from '../mappers/misc-mappers.js';
import { snapshots } from '../schema.js';

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
