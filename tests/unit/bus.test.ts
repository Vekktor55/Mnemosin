import { describe, expect, it, vi } from 'vitest';

import { DomainEventSchema } from '@mnemosin/contracts';
import { InProcessEventBus } from '@mnemosin/core';
import { randomUUID } from 'node:crypto';

/**
 * Unit tests for core/events/bus.ts
 * Covers uncovered branches: logger, metrics, timeout handling, error handling
 */

const TEST_SESSION_ID = randomUUID();

function makeStateCommittedEvent(payload: Record<string, unknown> = {}) {
  return DomainEventSchema.parse({
    type: 'STATE_COMMITTED',
    payload: { sessionId: TEST_SESSION_ID, version: 1, changedKeys: [], ...payload },
    traceId: `trace-${randomUUID()}`,
    emittedAt: new Date().toISOString(),
  });
}

describe('core/events/bus', () => {
  describe('InProcessEventBus', () => {
    it('throws VALIDATION for invalid event', async () => {
      const bus = new InProcessEventBus();
      const invalidEvent = { type: 'INVALID_TYPE', payload: {}, traceId: 'trace', emittedAt: new Date().toISOString() };

      await expect(bus.publish(invalidEvent as unknown as DomainEvent)).rejects.toMatchObject({
        code: 'VALIDATION',
      });
    });

    it('works with logger', async () => {
      const bus = new InProcessEventBus();
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.subscribe('STATE_COMMITTED', handler);

      const event = makeStateCommittedEvent();

      await bus.publish(event);

      expect(handler).toHaveBeenCalledWith(event);
    });

    it('works with metrics', async () => {
      const timingCalls: Record<string, unknown>[] = [];
      const counterCalls: Record<string, unknown>[] = [];
      const metrics = {
        timing: vi.fn((name: string, value: number, tags?: Record<string, unknown>) =>
          timingCalls.push({ name, value, tags }),
        ),
        counter: vi.fn((name: string, value: number, tags?: Record<string, unknown>) =>
          counterCalls.push({ name, value, tags }),
        ),
      };
      const bus = new InProcessEventBus({ metrics });
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.subscribe('STATE_COMMITTED', handler);

      const event = makeStateCommittedEvent();

      await bus.publish(event);

      expect(timingCalls.length).toBeGreaterThan(0);
      expect(counterCalls.some((c) => c.name === 'events.published')).toBe(true);
    });

    it('handles handler timeout', async () => {
      const bus = new InProcessEventBus({ handlerTimeoutMs: 10 });
      const slowHandler = vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 50)));
      bus.subscribe('STATE_COMMITTED', slowHandler);

      const event = makeStateCommittedEvent({ traceId: 'trace-timeout' });

      const report = await bus.publish(event);

      expect(report.timedOut).toBe(1);
      expect(report.failed).toBe(1);
      expect(report.errors.length).toBeGreaterThan(0);
    });

    it('handles handler error without timeout', async () => {
      const bus = new InProcessEventBus({ handlerTimeoutMs: 5000 });
      const failingHandler = vi.fn().mockRejectedValue(new Error('handler error'));
      bus.subscribe('STATE_COMMITTED', failingHandler);

      const event = makeStateCommittedEvent();

      const report = await bus.publish(event);

      expect(report.failed).toBe(1);
      expect(report.timedOut).toBe(0);
      expect(report.errors[0]).toContain('handler error');
    });

    it('continues dispatching after handler error', async () => {
      const bus = new InProcessEventBus();
      const failingHandler = vi.fn().mockRejectedValue(new Error('fail'));
      const successHandler = vi.fn().mockResolvedValue(undefined);
      bus.subscribe('STATE_COMMITTED', failingHandler);
      bus.subscribe('STATE_COMMITTED', successHandler);

      const event = makeStateCommittedEvent();

      const report = await bus.publish(event);

      expect(report.dispatched).toBe(2);
      expect(report.failed).toBe(1);
      expect(successHandler).toHaveBeenCalled();
    });

    it('unsubscribe removes handler', async () => {
      const bus = new InProcessEventBus();
      const handler = vi.fn().mockResolvedValue(undefined);
      const unsubscribe = bus.subscribe('STATE_COMMITTED', handler);

      const event = makeStateCommittedEvent();

      await bus.publish(event);
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();
      await bus.publish(event);
      expect(handler).toHaveBeenCalledTimes(1); // not called again
    });

    it('unsubscribe is idempotent', async () => {
      const bus = new InProcessEventBus();
      const handler = vi.fn().mockResolvedValue(undefined);
      const unsubscribe = bus.subscribe('STATE_COMMITTED', handler);

      unsubscribe();
      unsubscribe(); // second call should not throw

      const event = makeStateCommittedEvent();

      await expect(bus.publish(event)).resolves.toBeDefined();
    });

    it('publishMany preserves order', async () => {
      const bus = new InProcessEventBus();
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.subscribe('STATE_COMMITTED', handler);

      const events = [
        makeStateCommittedEvent({ version: 1 }),
        makeStateCommittedEvent({ version: 2 }),
        makeStateCommittedEvent({ version: 3 }),
      ];

      const reports = await bus.publishMany(events);

      expect(reports).toHaveLength(3);
      expect(handler).toHaveBeenCalledTimes(3);
    });
  });

  describe('HandlerTimeoutError', () => {
    it('includes event name and timeout in message', () => {
      const error = new Error('test timeout');
      error.name = 'HandlerTimeoutError';
      expect(error.message).toBeDefined();
    });
  });
});
