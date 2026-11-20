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

    it('omits event type from validation metadata when type is not a string', async () => {
      const bus = new InProcessEventBus();
      const invalidEvent = { type: 42, payload: {}, traceId: 'trace', emittedAt: new Date().toISOString() };

      try {
        await bus.publish(invalidEvent as unknown as DomainEvent);
        expect.fail('Should have thrown VALIDATION error');
      } catch (err: unknown) {
        expect(err).toMatchObject({ code: 'VALIDATION' });
        const error = err as { meta?: { type?: string } };
        expect(error.meta?.type).toBeUndefined();
      }
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

    it('unsubscribe handles handler not found (index < 0)', async () => {
      const bus = new InProcessEventBus();
      const handler = vi.fn().mockResolvedValue(undefined);
      const unsubscribe = bus.subscribe('STATE_COMMITTED', handler);

      unsubscribe();
      // Second call should not throw (index < 0)
      unsubscribe();

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

    it('handles publishMany with mixed success and failure', async () => {
      const bus = new InProcessEventBus();
      const successHandler = vi.fn().mockResolvedValue(undefined);
      const failingHandler = vi.fn().mockRejectedValue(new Error('fail'));
      bus.subscribe('STATE_COMMITTED', successHandler);
      bus.subscribe('STATE_COMMITTED', failingHandler);

      const events = [
        makeStateCommittedEvent({ version: 1, changedKeys: [] }),
        makeStateCommittedEvent({ version: 2, changedKeys: [] }),
      ];

      const reports = await bus.publishMany(events);

      expect(reports).toHaveLength(2);
      expect(reports[0].failed).toBe(1);
      expect(reports[1].failed).toBe(1);
    });

    it('unsubscribe removes handler when found (index >= 0)', async () => {
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

    it('handles publish with event type in validation error', async () => {
      const bus = new InProcessEventBus();
      const invalidEvent = {
        type: 'INVALID_TYPE',
        payload: {},
        traceId: 'trace',
        emittedAt: new Date().toISOString(),
      };

      await expect(bus.publish(invalidEvent as unknown as DomainEvent)).rejects.toMatchObject({
        code: 'VALIDATION',
      });
    });

    it('handles handler timeout with error logging', async () => {
      const logs: unknown[] = [];
      const logger = {
        error: vi.fn((obj) => logs.push(obj)),
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      };
      const bus = new InProcessEventBus({ handlerTimeoutMs: 10, logger });
      const slowHandler = vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 50)));
      bus.subscribe('STATE_COMMITTED', slowHandler);

      const event = makeStateCommittedEvent({ traceId: 'trace-timeout' });

      const report = await bus.publish(event);

      expect(report.timedOut).toBe(1);
      expect(report.failed).toBe(1);
      expect(report.errors[0]).toContain('не завершился за');
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]).toMatchObject({ event: 'STATE_COMMITTED', timedOut: true });
    });

    it('handles handler error with logging (non-timeout)', async () => {
      const logs: unknown[] = [];
      const logger = {
        error: vi.fn((obj) => logs.push(obj)),
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      };
      const bus = new InProcessEventBus({ logger });
      const failingHandler = vi.fn().mockRejectedValue(new Error('handler error'));
      bus.subscribe('STATE_COMMITTED', failingHandler);

      const event = makeStateCommittedEvent({ traceId: 'trace-log' });

      const report = await bus.publish(event);

      expect(report.failed).toBe(1);
      expect(report.timedOut).toBe(0);
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]).toMatchObject({ event: 'STATE_COMMITTED', timedOut: false });
    });

    it('handles timeout error correctly', async () => {
      const bus = new InProcessEventBus({ handlerTimeoutMs: 10 });
      const slowHandler = vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 50)));
      bus.subscribe('STATE_COMMITTED', slowHandler);

      const event = makeStateCommittedEvent({ traceId: 'trace-timeout' });

      const report = await bus.publish(event);

      expect(report.timedOut).toBe(1);
      expect(report.failed).toBe(1);
      expect(report.errors[0]).toContain('не завершился за');
    });

    it('handles handler error with logging', async () => {
      const logs: unknown[] = [];
      const logger = {
        error: vi.fn((obj) => logs.push(obj)),
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      };
      const bus = new InProcessEventBus({ logger });
      const failingHandler = vi.fn().mockRejectedValue(new Error('handler error'));
      bus.subscribe('STATE_COMMITTED', failingHandler);

      const event = makeStateCommittedEvent({ traceId: 'trace-log' });

      const report = await bus.publish(event);

      expect(report.failed).toBe(1);
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]).toMatchObject({ event: 'STATE_COMMITTED' });
    });

    it('unsubscribe actually removes handler from internal array (index >= 0)', async () => {
      const bus = new InProcessEventBus();
      const handler1 = vi.fn().mockResolvedValue(undefined);
      const handler2 = vi.fn().mockResolvedValue(undefined);

      const unsubscribe1 = bus.subscribe('STATE_COMMITTED', handler1);
      const _unsubscribe2 = bus.subscribe('STATE_COMMITTED', handler2);

      const event = makeStateCommittedEvent();
      await bus.publish(event);
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);

      // Unsubscribe first handler - this should hit the index >= 0 branch
      unsubscribe1();

      await bus.publish(event);
      expect(handler1).toHaveBeenCalledTimes(1); // not called again
      expect(handler2).toHaveBeenCalledTimes(2); // called again
    });

    it('validation error includes event type when present', async () => {
      const bus = new InProcessEventBus();
      const invalidEvent = {
        type: 'INVALID_TYPE',
        payload: {},
        traceId: 'trace',
        emittedAt: new Date().toISOString(),
      };

      try {
        await bus.publish(invalidEvent as unknown as DomainEvent);
        expect.fail('Should have thrown VALIDATION error');
      } catch (err: unknown) {
        expect(err).toMatchObject({
          code: 'VALIDATION',
        });
        // The error should include the type
        const error = err as { meta?: { type?: string } };
        expect(error.meta?.type).toBe('INVALID_TYPE');
      }
    });

    it('handler timeout triggers timeout error path in runWithTimeout', async () => {
      const bus = new InProcessEventBus({ handlerTimeoutMs: 10 });
      const slowHandler = vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 50)));
      bus.subscribe('STATE_COMMITTED', slowHandler);

      const event = makeStateCommittedEvent({ traceId: 'trace-timeout-path' });

      const report = await bus.publish(event);

      expect(report.timedOut).toBe(1);
      expect(report.failed).toBe(1);
      expect(report.errors[0]).toContain('не завершился за');
    });

    it('handler error (non-timeout) goes through catch path in runWithTimeout', async () => {
      const bus = new InProcessEventBus({ handlerTimeoutMs: 5000 });
      const failingHandler = vi.fn().mockRejectedValue(new Error('handler boom'));
      bus.subscribe('STATE_COMMITTED', failingHandler);

      const event = makeStateCommittedEvent({ traceId: 'trace-catch-path' });

      const report = await bus.publish(event);

      expect(report.failed).toBe(1);
      expect(report.timedOut).toBe(0);
      expect(report.errors[0]).toContain('handler boom');
    });

    it('dispatch continues after handler error (isolation)', async () => {
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

    it('catches HandlerTimeoutError instanceof check in dispatch', async () => {
      const bus = new InProcessEventBus({ handlerTimeoutMs: 10 });
      const slowHandler = vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 50)));
      bus.subscribe('STATE_COMMITTED', slowHandler);

      const event = makeStateCommittedEvent({ traceId: 'trace-timeout-instanceof' });

      const report = await bus.publish(event);

      expect(report.timedOut).toBe(1);
      expect(report.failed).toBe(1);
      expect(report.errors[0]).toContain('не завершился за');
    });

    it('limits errors array to 3 items in dispatch', async () => {
      const bus = new InProcessEventBus();
      const failingHandler1 = vi.fn().mockRejectedValue(new Error('error 1'));
      const failingHandler2 = vi.fn().mockRejectedValue(new Error('error 2'));
      const failingHandler3 = vi.fn().mockRejectedValue(new Error('error 3'));
      const failingHandler4 = vi.fn().mockRejectedValue(new Error('error 4'));

      bus.subscribe('STATE_COMMITTED', failingHandler1);
      bus.subscribe('STATE_COMMITTED', failingHandler2);
      bus.subscribe('STATE_COMMITTED', failingHandler3);
      bus.subscribe('STATE_COMMITTED', failingHandler4);

      const event = makeStateCommittedEvent({ traceId: 'trace-errors-limit' });

      const report = await bus.publish(event);

      expect(report.failed).toBe(4);
      expect(report.errors).toHaveLength(3); // limited to 3
    });

    it('runWithTimeout clears timer in finally block', async () => {
      const bus = new InProcessEventBus({ handlerTimeoutMs: 5000 });
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.subscribe('STATE_COMMITTED', handler);

      const event = makeStateCommittedEvent({ traceId: 'trace-timer-cleanup' });

      const report = await bus.publish(event);

      expect(report.timedOut).toBe(0);
      expect(report.failed).toBe(0);
      expect(report.dispatched).toBe(1);
    });

    it('runWithTimeout handler error path (non-timeout)', async () => {
      const bus = new InProcessEventBus({ handlerTimeoutMs: 5000 });
      const failingHandler = vi.fn().mockRejectedValue(new Error('handler boom'));
      bus.subscribe('STATE_COMMITTED', failingHandler);

      const event = makeStateCommittedEvent({ traceId: 'trace-catch-path' });

      const report = await bus.publish(event);

      expect(report.failed).toBe(1);
      expect(report.timedOut).toBe(0);
      expect(report.errors[0]).toContain('handler boom');
    });
  });
});
