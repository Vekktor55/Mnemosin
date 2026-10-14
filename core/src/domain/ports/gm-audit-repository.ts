import type { GmAuditEntry, GmActionKind } from '@mnemosin/contracts';
import type { SessionId, PlayerId } from '@mnemosin/contracts';

export interface GmAuditRepository {
  /** auditId генерируется БД (autoincrement) — возвращаем запись с проставленным id. */
  append(entry: Omit<GmAuditEntry, 'auditId'>): Promise<GmAuditEntry>;
  listBySession(sessionId: SessionId, limit?: number): Promise<GmAuditEntry[]>;
  listByGm(gmPlayerId: PlayerId, limit?: number): Promise<GmAuditEntry[]>;
  listByAction(action: GmActionKind, limit?: number): Promise<GmAuditEntry[]>;
}
