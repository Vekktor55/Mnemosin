import { asc, desc, eq, sql } from 'drizzle-orm';

import type { JournalEntry, OutboxRecord, OutboxStatus, SessionId, TurnId } from '@mnemosin/contracts';
import type { JournalDraft, JournalRepository, OutboxDraft, OutboxRepository } from '@mnemosin/core/domain/ports';

import type { Db, Executor } from '../client.js';
import { rowsAffectedOf } from '../mappers/index.js';
import { journalFromRow, outboxFromRow } from '../mappers/misc-mappers.js';
import { eventOutbox, journalEntries } from '../schema.js';

export class SqlJournalRepository implements JournalRepository {
  private readonly q: Db;

  constructor(ex: Executor) {
    this.q = ex as Db;
  }

  async append(draft: JournalDraft): Promise<JournalEntry> {
    const inserted = await this.q
      .insert(journalEntries)
      .values({
        turnId: draft.turnId,
        sessionId: draft.sessionId,
        traceId: draft.traceId,
        kind: draft.kind,
        payloadJson: draft.payload,
        createdAt: draft.createdAt,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('[database] journal.append: RETURNING не вернул строку');
    return journalFromRow(row);
  }

  async appendMany(drafts: JournalDraft[]): Promise<JournalEntry[]> {
    const out: JournalEntry[] = [];
    for (const draft of drafts) out.push(await this.append(draft));
    return out;
  }

  async listByTurn(turnId: TurnId): Promise<JournalEntry[]> {
    const rows = await this.q
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.turnId, turnId))
      .orderBy(asc(journalEntries.id));
    return rows.map(journalFromRow);
  }

  async listBySession(sessionId: SessionId, limit = 500): Promise<JournalEntry[]> {
    const rows = await this.q
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.sessionId, sessionId))
      .orderBy(desc(journalEntries.id))
      .limit(limit);
    return rows.map(journalFromRow).reverse();
  }

  async lastId(sessionId: SessionId): Promise<number> {
    const rows = await this.q.all<{ m: number | null }>(
      sql`SELECT max(id) AS m FROM journal_entries WHERE session_id = ${sessionId}`,
    );
    return Number(rows[0]?.m ?? 0);
  }
}

export class SqlOutboxRepository implements OutboxRepository {
  private readonly q: Db;

  constructor(ex: Executor) {
    this.q = ex as Db;
  }

  async append(draft: OutboxDraft): Promise<OutboxRecord> {
    const inserted = await this.q
      .insert(eventOutbox)
      .values({
        eventName: draft.eventName,
        payloadJson: draft.payloadJson,
        traceId: draft.traceId,
        status: 'PENDING',
        attempts: 0,
        lastError: null,
        emittedAt: draft.emittedAt,
        publishedAt: null,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('[database] outbox.append: RETURNING не вернул строку');
    return outboxFromRow(row);
  }

  async appendMany(drafts: OutboxDraft[]): Promise<OutboxRecord[]> {
    const out: OutboxRecord[] = [];
    for (const draft of drafts) out.push(await this.append(draft));
    return out;
  }

  async listPending(limit = 100): Promise<OutboxRecord[]> {
    const rows = await this.q
      .select()
      .from(eventOutbox)
      .where(eq(eventOutbox.status, 'PENDING'))
      .orderBy(asc(eventOutbox.id))
      .limit(limit);
    return rows.map(outboxFromRow);
  }

  async markPublished(id: number, atIso: string): Promise<void> {
    await this.q
      .update(eventOutbox)
      .set({ status: 'PUBLISHED', publishedAt: atIso })
      .where(eq(eventOutbox.id, id))
      .run();
  }

  /**
   * Сбой доставки: attempts+1, lastError. dead=true → status='DEAD' (лимит попыток
   * исчерпан, D210), publishedAt остаётся NULL. Одна запись — одно решение публикатора.
   */
  async registerFailure(id: number, error: string, dead: boolean): Promise<void> {
    await this.q
      .update(eventOutbox)
      .set({
        attempts: sql`${eventOutbox.attempts} + 1`,
        lastError: error.slice(0, 500),
        ...(dead ? { status: 'DEAD' as const } : {}),
      })
      .where(eq(eventOutbox.id, id))
      .run();
  }

  async setStatus(id: number, status: OutboxStatus): Promise<void> {
    await this.q.update(eventOutbox).set({ status }).where(eq(eventOutbox.id, id)).run();
  }

  async countByStatus(status: OutboxStatus): Promise<number> {
    const rows = await this.q.all<{ c: number }>(sql`SELECT count(*) AS c FROM event_outbox WHERE status = ${status}`);
    return Number(rows[0]?.c ?? 0);
  }

  async countAll(): Promise<number> {
    const rows = await this.q.all<{ c: number }>(sql`SELECT count(*) AS c FROM event_outbox`);
    return Number(rows[0]?.c ?? 0);
  }
}

export { rowsAffectedOf };
