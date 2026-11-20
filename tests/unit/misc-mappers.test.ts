import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { nowIso } from '@mnemosin/contracts';

import {
  chatFromRow,
  chatToRow,
  gmNoteFromRow,
  gmNoteToRow,
  gmAuditFromRow,
  gmAuditToRow,
  journalFromRow,
  outboxFromRow,
  snapshotFromRow,
  snapshotToRow,
} from '@mnemosin/database';

describe('infrastructure/database mappers (misc-mappers)', () => {
  const now = nowIso();

  describe('chat mappers', () => {
    it('chatFromRow parses valid row', () => {
      const messageId = randomUUID();
      const sessionId = randomUUID();
      const turnId = randomUUID();
      const fromPlayerId = randomUUID();
      const toPlayerId = randomUUID();
      const fromDisplayName = 'Test Player';
      const bodyJson = {
        messageId,
        sessionId,
        turnId,
        visibility: 'PUBLIC',
        fromPlayerId,
        toPlayerId,
        fromDisplayName,
        text: 'Hello',
        createdAt: now,
      };
      const row = {
        messageId,
        sessionId,
        turnId,
        visibility: 'PUBLIC',
        fromPlayerId,
        toPlayerId,
        createdAt: now,
        bodyJson,
      };

      const result = chatFromRow(row);
      expect(result.messageId).toBe(messageId);
      expect(result.text).toBe('Hello');
    });

    it('chatToRow converts message to row', () => {
      const messageId = randomUUID();
      const sessionId = randomUUID();
      const turnId = randomUUID();
      const fromPlayerId = randomUUID();
      const toPlayerId = randomUUID();
      const message = {
        messageId,
        sessionId,
        turnId,
        visibility: 'PUBLIC' as const,
        fromPlayerId,
        toPlayerId,
        text: 'Hello',
        createdAt: nowIso(),
      };

      const result = chatToRow(message);
      expect(result.messageId).toBe(messageId);
      expect(result.bodyJson).toEqual({
        messageId,
        sessionId,
        turnId,
        visibility: 'PUBLIC',
        fromPlayerId,
        toPlayerId,
        fromDisplayName: undefined,
        text: 'Hello',
        createdAt: message.createdAt,
      });
    });
  });

  describe('gmNote mappers', () => {
    it('gmNoteFromRow parses valid row', () => {
      const noteId = randomUUID();
      const sessionId = randomUUID();
      const turnId = randomUUID();
      const bodyJson = {
        noteId,
        sessionId,
        turnId,
        visibility: 'GM_ONLY',
        text: 'Note',
        createdAt: now,
      };
      const row = {
        noteId,
        sessionId,
        turnId,
        visibility: 'GM_ONLY',
        createdAt: now,
        bodyJson,
      };

      const result = gmNoteFromRow(row);
      expect(result.noteId).toBe(noteId);
      expect(result.text).toBe('Note');
    });

    it('gmNoteToRow converts note to row', () => {
      const noteId = randomUUID();
      const sessionId = randomUUID();
      const turnId = randomUUID();
      const note = {
        noteId,
        sessionId,
        turnId,
        visibility: 'GM_ONLY' as const,
        text: 'Note',
        createdAt: nowIso(),
      };

      const result = gmNoteToRow(note);
      expect(result.noteId).toBe(noteId);
      expect(result.bodyJson).toEqual({
        noteId,
        sessionId,
        turnId,
        visibility: 'GM_ONLY',
        text: 'Note',
        createdAt: note.createdAt,
      });
    });
  });

  describe('gmAudit mappers', () => {
    it('gmAuditFromRow parses valid row', () => {
      const auditId = 1;
      const sessionId = randomUUID();
      const gmPlayerId = randomUUID();
      const traceId = 'trace-123';
      const idempotencyKey = 'idem-key-1234567890123456';
      const at = now;
      const bodyJson = {
        auditId,
        sessionId,
        gmPlayerId,
        action: 'createSession',
        traceId,
        idempotencyKey,
        at,
        meta: {},
      };
      const row = {
        auditId,
        sessionId,
        gmPlayerId,
        action: 'createSession',
        traceId,
        idempotencyKey,
        at,
        bodyJson,
      };

      const result = gmAuditFromRow(row);
      expect(result.auditId).toBe(1);
      expect(result.action).toBe('createSession');
    });

    it('gmAuditToRow converts entry to row', () => {
      const sessionId = randomUUID();
      const gmPlayerId = randomUUID();
      const entry = {
        sessionId,
        gmPlayerId,
        action: 'createSession' as const,
        traceId: 'trace-123',
        idempotencyKey: 'idem-key-1234567890123456',
        at: nowIso(),
      };

      const result = gmAuditToRow(entry);
      expect(result.sessionId).toBe(sessionId);
      expect(result.action).toBe('createSession');
    });
  });

  describe('journal mappers', () => {
    it('journalFromRow parses valid row', () => {
      const turnId = randomUUID();
      const sessionId = randomUUID();
      const traceId = 'trace-123';
      const payloadJson = { number: 1 };
      const row = {
        id: 1,
        turnId,
        sessionId,
        traceId,
        kind: 'turn_opened',
        payloadJson,
        createdAt: now,
      };

      const result = journalFromRow(row);
      expect(result.id).toBe(1);
      expect(result.kind).toBe('turn_opened');
    });
  });

  describe('outbox mappers', () => {
    it('outboxFromRow parses valid row', () => {
      const row = {
        id: 1,
        eventName: 'STATE_COMMITTED',
        payloadJson: '{"sessionId":"test","version":1}',
        traceId: 'trace-123',
        status: 'PENDING',
        attempts: 0,
        lastError: null,
        emittedAt: now,
        publishedAt: null,
      };

      const result = outboxFromRow(row);
      expect(result.id).toBe(1);
      expect(result.eventName).toBe('STATE_COMMITTED');
    });
  });

  describe('snapshot mappers', () => {
    it('snapshotFromRow parses valid row', () => {
      const snapshotId = randomUUID();
      const sessionId = randomUUID();
      const locationId = randomUUID();
      const state = {
        sessionId,
        version: 1,
        worldState: {
          currentLocationId: locationId,
          timeOfDay: 'NIGHT' as const,
          weather: null,
          ambientFlags: {},
        },
        storyFlags: {},
        objectStates: {},
        playerKnowledge: {},
        endingState: null,
        updatedAt: now,
      };
      const row = {
        snapshotId,
        sessionId,
        label: 'Test',
        turnNumber: 1,
        createdByTurnId: null,
        createdBy: 'SYSTEM',
        checksum: 'a'.repeat(64),
        createdAt: now,
        stateJson: state,
      };

      const result = snapshotFromRow(row);
      expect(result.id).toBe(snapshotId);
      expect(result.label).toBe('Test');
    });

    it('snapshotToRow converts snapshot to row', () => {
      const snapshotId = randomUUID();
      const sessionId = randomUUID();
      const snapshot = {
        id: snapshotId,
        sessionId,
        label: 'Test',
        turnNumber: 1,
        createdByTurnId: null,
        createdBy: 'SYSTEM',
        checksum: 'a'.repeat(64),
        createdAt: nowIso(),
        state: {
          sessionId,
          version: 1,
          worldState: { currentLocationId: 'loc1', timeOfDay: 'NIGHT', weather: null, ambientFlags: {} },
        },
      };

      const result = snapshotToRow(snapshot);
      expect(result.snapshotId).toBe(snapshotId);
      expect(result.stateJson).toEqual(snapshot.state);
    });
  });
});
