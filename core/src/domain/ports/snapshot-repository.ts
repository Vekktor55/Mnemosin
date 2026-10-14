import type { Snapshot, SnapshotListEntry } from '@mnemosin/contracts';
import type { SnapshotId, SessionId } from '@mnemosin/contracts';

export interface SnapshotRepository {
  insert(snapshot: Snapshot): Promise<void>;
  findById(snapshotId: SnapshotId): Promise<Snapshot | null>;
  /** Список без тел состояний — тело тяжёлое, в списке оно не нужно. */
  listBySession(sessionId: SessionId, limit?: number): Promise<SnapshotListEntry[]>;
  findLatestBySession(sessionId: SessionId): Promise<Snapshot | null>;
  deleteOlderThan(sessionId: SessionId, turnNumber: number): Promise<number>;
}
