import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';

import type {
  ChatMessage,
  ChatVisibility,
  GmAuditEntry,
  GmActionKind,
  GMNote,
  MessageId,
  NoteId,
  PlayerId,
  SessionId,
  TurnId,
} from '@mnemosin/contracts';
import type { ChatRepository, GmAuditRepository, GmNoteRepository } from '@mnemosin/core/domain/ports';

import type { Db, Executor } from '../client.js';
import { rowsAffectedOf } from '../mappers/index.js';
import {
  chatFromRow,
  chatToRow,
  gmAuditFromRow,
  gmAuditToRow,
  gmNoteFromRow,
  gmNoteToRow,
} from '../mappers/misc-mappers.js';
import { chatMessages, gmAuditLog, gmNotes, players } from '../schema.js';

export class SqlChatRepository implements ChatRepository {
  private readonly q: Db;

  constructor(ex: Executor) {
    this.q = ex as Db;
  }

  async insert(message: ChatMessage): Promise<void> {
    await this.q.insert(chatMessages).values(chatToRow(message)).run();
  }

  async findById(messageId: MessageId): Promise<ChatMessage | null> {
    const rows = await this.q.select().from(chatMessages).where(eq(chatMessages.messageId, messageId)).limit(1);
    return rows[0] ? chatFromRow(rows[0]) : null;
  }

  async listBySession(sessionId: SessionId, limit = 200): Promise<ChatMessage[]> {
    const rows = await this.q
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(desc(chatMessages.createdAt))
      .limit(limit);
    return rows.map(chatFromRow).reverse();
  }

  /**
   * Лента для конкретного игрока: PUBLIC/SYSTEM видны всем, PRIVATE — только адресату и
   * отправителю, GM — только ведущему. Фильтрация по приватности на уровне запроса,
   * а не «отдали всё, потом спрячем» (WS_PRIVACY_POLICY, промпт 1.9).
   */
  async listForPlayer(sessionId: SessionId, playerId: PlayerId, limit = 200): Promise<ChatMessage[]> {
    const isGmRows = await this.q
      .select({ isGm: players.isGm })
      .from(players)
      .where(and(eq(players.sessionId, sessionId), eq(players.playerId, playerId)))
      .limit(1);
    const isGm = Boolean(isGmRows[0]?.isGm);
    const visible: ChatVisibility[] = isGm ? ['PUBLIC', 'SYSTEM', 'GM'] : ['PUBLIC', 'SYSTEM'];

    const conditions = [
      and(eq(chatMessages.sessionId, sessionId), inArray(chatMessages.visibility, visible)),
      and(
        eq(chatMessages.sessionId, sessionId),
        eq(chatMessages.visibility, 'PRIVATE'),
        eq(chatMessages.toPlayerId, playerId),
      ),
      and(
        eq(chatMessages.sessionId, sessionId),
        eq(chatMessages.visibility, 'PRIVATE'),
        eq(chatMessages.fromPlayerId, playerId),
      ),
    ];
    const rows = await this.q
      .select()
      .from(chatMessages)
      .where(or(...conditions))
      .orderBy(desc(chatMessages.createdAt))
      .limit(limit);
    return rows.map(chatFromRow).reverse();
  }

  async listByVisibility(sessionId: SessionId, visibility: ChatVisibility, limit = 200): Promise<ChatMessage[]> {
    const rows = await this.q
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.sessionId, sessionId), eq(chatMessages.visibility, visibility)))
      .orderBy(desc(chatMessages.createdAt))
      .limit(limit);
    return rows.map(chatFromRow).reverse();
  }
}

export class SqlGmNoteRepository implements GmNoteRepository {
  private readonly q: Db;

  constructor(ex: Executor) {
    this.q = ex as Db;
  }

  async insert(note: GMNote): Promise<void> {
    await this.q.insert(gmNotes).values(gmNoteToRow(note)).run();
  }

  async findById(noteId: NoteId): Promise<GMNote | null> {
    const rows = await this.q.select().from(gmNotes).where(eq(gmNotes.noteId, noteId)).limit(1);
    return rows[0] ? gmNoteFromRow(rows[0]) : null;
  }

  async listBySession(sessionId: SessionId, limit = 200): Promise<GMNote[]> {
    const rows = await this.q
      .select()
      .from(gmNotes)
      .where(eq(gmNotes.sessionId, sessionId))
      .orderBy(desc(gmNotes.createdAt))
      .limit(limit);
    return rows.map(gmNoteFromRow).reverse();
  }

  async listByTurn(turnId: TurnId): Promise<GMNote[]> {
    const rows = await this.q.select().from(gmNotes).where(eq(gmNotes.turnId, turnId)).orderBy(desc(gmNotes.createdAt));
    return rows.map(gmNoteFromRow).reverse();
  }
}

export class SqlGmAuditRepository implements GmAuditRepository {
  private readonly q: Db;

  constructor(ex: Executor) {
    this.q = ex as Db;
  }

  async append(entry: Omit<GmAuditEntry, 'auditId'>): Promise<GmAuditEntry> {
    const inserted = await this.q.insert(gmAuditLog).values(gmAuditToRow(entry)).returning();
    const row = inserted[0];
    if (!row) throw new Error('[database] gm_audit_log.append: RETURNING не вернул строку');
    // body_json записан без auditId — проставляем его в теле при чтении, чтобы контракт сошёлся.
    const withId = { ...(row.bodyJson as Record<string, unknown>), auditId: row.auditId };
    return gmAuditFromRow({ ...row, bodyJson: withId });
  }

  async listBySession(sessionId: SessionId, limit = 200): Promise<GmAuditEntry[]> {
    const rows = await this.q
      .select()
      .from(gmAuditLog)
      .where(eq(gmAuditLog.sessionId, sessionId))
      .orderBy(desc(gmAuditLog.auditId))
      .limit(limit);
    return rows.map((r) => gmAuditFromRow(withAuditId(r)));
  }

  async listByGm(gmPlayerId: PlayerId, limit = 200): Promise<GmAuditEntry[]> {
    const rows = await this.q
      .select()
      .from(gmAuditLog)
      .where(eq(gmAuditLog.gmPlayerId, gmPlayerId))
      .orderBy(desc(gmAuditLog.auditId))
      .limit(limit);
    return rows.map((r) => gmAuditFromRow(withAuditId(r)));
  }

  async listByAction(action: GmActionKind, limit = 200): Promise<GmAuditEntry[]> {
    const rows = await this.q
      .select()
      .from(gmAuditLog)
      .where(eq(gmAuditLog.action, action))
      .orderBy(desc(gmAuditLog.auditId))
      .limit(limit);
    return rows.map((r) => gmAuditFromRow(withAuditId(r)));
  }

  async countAll(): Promise<number> {
    const rows = await this.q.all<{ c: number }>(sql`SELECT count(*) AS c FROM gm_audit_log`);
    return Number(rows[0]?.c ?? 0);
  }
}

function withAuditId(row: typeof gmAuditLog.$inferSelect): typeof row {
  return { ...row, bodyJson: { ...(row.bodyJson as Record<string, unknown>), auditId: row.auditId } };
}

/** Проверка, что INSERT действительно отклонён (используется в тестах FK). */
export async function expectInsertRejected(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise;
    return false;
  } catch {
    return true;
  }
}

export { rowsAffectedOf };
