import {
  ChatMessageSchema,
  GameStateSchema,
  GmAuditEntrySchema,
  GMNoteSchema,
  JournalEntrySchema,
  OutboxRecordSchema,
  HotSnapshotSchema,
  SnapshotSchema,
  type ChatMessage,
  type GmAuditEntry,
  type GMNote,
  type JournalEntry,
  type OutboxRecord,
  type Snapshot,
} from '@mnemosin/contracts';

import type { chatMessages, gmAuditLog, gmNotes, journalEntries, eventOutbox, snapshots } from '../schema.js';
import { asJson, assertMatches, parseBody } from './index.js';

export function chatFromRow(row: typeof chatMessages.$inferSelect): ChatMessage {
  const body = parseBody(ChatMessageSchema, row.bodyJson, 'chat_messages');
  assertMatches('message_id', row.messageId, body.messageId, 'chat_messages');
  assertMatches('visibility', row.visibility, body.visibility, 'chat_messages');
  return body;
}

export function chatToRow(message: ChatMessage): typeof chatMessages.$inferInsert {
  return {
    messageId: message.messageId,
    sessionId: message.sessionId,
    turnId: message.turnId,
    visibility: message.visibility,
    fromPlayerId: message.fromPlayerId,
    toPlayerId: message.toPlayerId,
    createdAt: message.createdAt,
    bodyJson: asJson(message as unknown, 'chat_messages.insert'),
  };
}

export function gmNoteFromRow(row: typeof gmNotes.$inferSelect): GMNote {
  const body = parseBody(GMNoteSchema, row.bodyJson, 'gm_notes');
  assertMatches('note_id', row.noteId, body.noteId, 'gm_notes');
  return body;
}

export function gmNoteToRow(note: GMNote): typeof gmNotes.$inferInsert {
  return {
    noteId: note.noteId,
    sessionId: note.sessionId,
    turnId: note.turnId,
    visibility: note.visibility,
    createdAt: note.createdAt,
    bodyJson: asJson(note as unknown, 'gm_notes.insert'),
  };
}

export function gmAuditFromRow(row: typeof gmAuditLog.$inferSelect): GmAuditEntry {
  const body = parseBody(GmAuditEntrySchema, row.bodyJson, 'gm_audit_log');
  assertMatches('audit_id', row.auditId, body.auditId, 'gm_audit_log');
  assertMatches('action', row.action, body.action, 'gm_audit_log');
  return body;
}

export function gmAuditToRow(entry: Omit<GmAuditEntry, 'auditId'>): typeof gmAuditLog.$inferInsert {
  return {
    sessionId: entry.sessionId,
    gmPlayerId: entry.gmPlayerId,
    action: entry.action,
    traceId: entry.traceId,
    idempotencyKey: entry.idempotencyKey,
    at: entry.at,
    bodyJson: asJson(entry as unknown, 'gm_audit_log.append'),
  };
}

export function journalFromRow(row: typeof journalEntries.$inferSelect): JournalEntry {
  // Журнал хранит payload в json-колонке, а контракт ожидает поле payload — собираем кандидата.
  const candidate = {
    id: row.id,
    turnId: row.turnId,
    sessionId: row.sessionId,
    traceId: row.traceId,
    kind: row.kind,
    payload: row.payloadJson,
    createdAt: row.createdAt,
  };
  const body = parseBody(JournalEntrySchema, candidate, 'journal_entries');
  assertMatches('id', row.id, body.id, 'journal_entries');
  assertMatches('kind', row.kind, body.kind, 'journal_entries');
  return body;
}

export function outboxFromRow(row: typeof eventOutbox.$inferSelect): OutboxRecord {
  const body = parseBody(OutboxRecordSchema, row, 'event_outbox');
  assertMatches('id', row.id, body.id, 'event_outbox');
  assertMatches('status', row.status, body.status, 'event_outbox');
  return body;
}

export function snapshotFromRow(row: typeof snapshots.$inferSelect): Snapshot {
  const metadata = {
    id: row.snapshotId,
    sessionId: row.sessionId,
    label: row.label,
    turnNumber: row.turnNumber,
    createdByTurnId: row.createdByTurnId,
    createdBy: row.createdBy,
    checksum: row.checksum,
    createdAt: row.createdAt,
  };
  const stored = row.stateJson as unknown;
  if (isHotSnapshotPayload(stored)) {
    return parseBody(HotSnapshotSchema, { ...metadata, ...stored }, 'snapshots.hot');
  }
  // Legacy state_json хранит только GameState и остаётся обратно-совместимым.
  const state = parseBody(GameStateSchema, stored, 'snapshots.state');
  return parseBody(SnapshotSchema, { ...metadata, state }, 'snapshots');
}

function isHotSnapshotPayload(
  value: unknown,
): value is { state: unknown; snapshotVersion: 1; recoveryPoint: unknown; runtime: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { snapshotVersion?: unknown }).snapshotVersion === 1 &&
    'state' in value &&
    'recoveryPoint' in value &&
    'runtime' in value
  );
}

export function snapshotToRow(snapshot: Snapshot): typeof snapshots.$inferInsert {
  const hot = snapshot.snapshotVersion === 1 ? HotSnapshotSchema.parse(snapshot) : null;
  const stateJson = hot
    ? {
        state: hot.state,
        snapshotVersion: hot.snapshotVersion,
        recoveryPoint: hot.recoveryPoint,
        runtime: hot.runtime,
      }
    : snapshot.state;
  return {
    snapshotId: snapshot.id,
    sessionId: snapshot.sessionId,
    label: snapshot.label,
    turnNumber: snapshot.turnNumber,
    createdByTurnId: snapshot.createdByTurnId,
    createdBy: snapshot.createdBy,
    checksum: snapshot.checksum,
    createdAt: snapshot.createdAt,
    stateJson: asJson(stateJson as unknown, 'snapshots.insert'),
  };
}
