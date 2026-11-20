import { describe, expect, it, vi } from 'vitest';

import { DomainEventSchema } from '@mnemosin/contracts';
import { appendOutbox, createEvent, toOutboxDraft } from '@mnemosin/core';
import { randomUUID } from 'node:crypto';

/**
 * Unit tests for core/events/outbox.ts
 * Covers uncovered branches: empty events array, createEvent validation
 */

const TEST_SESSION_ID = randomUUID();

describe('core/events/outbox', () => {
  describe('appendOutbox', () => {
    it('returns empty array for empty events', async () => {
      const mockScope = {
        repos: {
          outbox: {
            appendMany: vi.fn().mockResolvedValue([]),
          },
        },
      };

      const result = await appendOutbox(
        [],
        mockScope as unknown as { repos: { outbox: { appendMany: () => Promise<unknown[]> } } },
      );
      expect(result).toEqual([]);
    });

    it('returns empty array for empty events (explicit check)', async () => {
      const mockScope = {
        repos: {
          outbox: {
            appendMany: vi.fn().mockResolvedValue([]),
          },
        },
      };

      const result = await appendOutbox(
        [],
        mockScope as unknown as { repos: { outbox: { appendMany: () => Promise<unknown[]> } } },
      );
      expect(result).toEqual([]);
    });
  });

  describe('createEvent', () => {
    it('creates valid STATE_COMMITTED event', () => {
      const event = createEvent(
        'STATE_COMMITTED',
        { sessionId: TEST_SESSION_ID, version: 1, changedKeys: [] },
        'trace-123',
      );
      expect(event.type).toBe('STATE_COMMITTED');
      expect(event.payload).toEqual({ sessionId: TEST_SESSION_ID, version: 1, changedKeys: [] });
      expect(event.traceId).toBe('trace-123');
      expect(event.emittedAt).toBeDefined();
    });

    it('uses custom emittedAt', () => {
      const customTime = '2024-01-01T00:00:00.000Z';
      const event = createEvent(
        'STATE_COMMITTED',
        { sessionId: TEST_SESSION_ID, version: 1, changedKeys: [] },
        'trace-123',
        customTime,
      );
      expect(event.emittedAt).toBe(customTime);
    });

    it('truncates traceId to 64 chars', () => {
      const longTraceId = 'a'.repeat(100);
      const event = createEvent(
        'STATE_COMMITTED',
        { sessionId: TEST_SESSION_ID, version: 1, changedKeys: [] },
        longTraceId,
      );
      expect(event.traceId.length).toBe(64);
    });

    it('throws VALIDATION for invalid payload', () => {
      expect(() => createEvent('INVALID_TYPE', { data: 'test' }, 'trace')).toThrowError(
        'createEvent: payload INVALID_TYPE не прошёл DomainEventSchema',
      );
    });
  });

  describe('toOutboxDraft', () => {
    it('converts event to outbox draft', () => {
      const event = DomainEventSchema.parse({
        type: 'STATE_COMMITTED',
        payload: { sessionId: TEST_SESSION_ID, version: 1, changedKeys: [] },
        traceId: 'trace-123',
        emittedAt: '2024-01-01T00:00:00.000Z',
      });

      const draft = toOutboxDraft(event);
      expect(draft.eventName).toBe('STATE_COMMITTED');
      expect(draft.payloadJson).toContain('sessionId');
      expect(draft.traceId).toBe('trace-123');
      expect(draft.emittedAt).toBe('2024-01-01T00:00:00.000Z');
    });
  });
});
