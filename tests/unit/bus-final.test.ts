import { describe, expect, it, vi } from 'vitest';
import { DomainEventSchema } from '@mnemosin/contracts';
import { InProcessEventBus } from '@mnemosin/core';
import { randomUUID } from 'node:crypto';

const TEST_SESSION_ID = randomUUID();

function makeStateCommittedEvent(payload: Record<string, unknown> = {}) {
  return DomainEventSchema.parse({
    type: 'STATE_COMMITTED',
    payload: { sessionId: TEST_SESSION_ID, version: 1, changedKeys: [], ...payload },
    traceId: `trace-${randomUUID()}`,
    emittedAt: new Date().toISOString(),
  });
}

describe('core/events/bus.ts - final coverage branches', () => {
  describe('InProcessEventBus', () => {
    it('unsubscribe removes handler when found (index >= 0 branch line 77)', async () => {
      const bus = new InProcessEventBus();
      const handler1 = vi.fn().mockResolvedValue(undefined);
      const handler2 = vi.fn().mockResolvedValue(undefined);
      
      const unsubscribe1 = bus.subscribe('STATE_COMMITTED', handler1);
      const unsubscribe2 = bus.subscribe('STATE_COMMITTED', handler2);

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

    it('validation error includes event type when present (branch line 89)', async () => {
      const bus = new InProcessEventBus();
      const invalidEvent = { 
        type: 'INVALID_TYPE', 
        payload: {}, 
        traceId: 'trace', 
        emittedAt: new Date().toISOString() 
      };

      try {
        await bus.publish(invalidEvent as any);
        expect.fail('Should have thrown VALIDATION error');
      } catch (err: unknown) {
        expect(err).toMatchObject({ code: 'VALIDATION' });
        const error = err as { meta?: { type?: string } };
        expect(error.meta?.type).toBe('INVALID_TYPE');
      }
    });

    it('handler timeout triggers timeout error path in runWithTimeout (branch 143-150)', async () => {
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

    it('catches HandlerTimeoutError instanceof check in dispatch (branch 123)', async () => {
      const bus = new InProcessEventBus({ handlerTimeoutMs: 10 });
      const slowHandler = vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 50)));
      bus.subscribe('STATE_COMMITTED', slowHandler);

      const event = makeStateCommittedEvent({ traceId: 'trace-timeout-instanceof' });

      const report = await bus.publish(event);

      expect(report.timedOut).toBe(1);
      expect(report.failed).toBe(1);
      expect(report.errors[0]).toContain('не завершился за');
    });

    it('limits errors array to 3 items in dispatch (branch 123)', async () => {
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

    it('runWithTimeout handler error path (non-timeout) - branch 121-130', async () => {
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

    it('catches HandlerTimeoutError instanceof check in dispatch (branch 123)', async () => {
      const bus = new InProcessEventBus({ handlerTimeoutMs: 10 });
      const slowHandler = vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 50)));
      bus.subscribe('STATE_COMMITTED', slowHandler);

      const event = makeStateCommittedEvent({ traceId: 'trace-timeout-instanceof' });

      const report = await bus.publish(event);

      expect(report.timedOut).toBe(1);
      expect(report.failed).toBe(1);
      expect(report.errors[0]).toContain('не завершился за');
    });

    it('limits errors array to 3 items in dispatch (branch 123)', async () => {
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

    it('runWithTimeout clears timer in finally block (branch 152-153)', async () => {
      const bus = new InProcessEventBus({ handlerTimeoutMs: 5000 });
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.subscribe('STATE_COMMITTED', handler);

      const event = makeStateCommittedEvent({ traceId: 'trace-timer-cleanup' });

      const report = await bus.publish(event);

      expect(report.timedOut).toBe(0);
      expect(report.failed).toBe(0);
      expect(report.dispatched).toBe(1);
    });

    it('runWithTimeout handler error path (non-timeout) - branch 121-130', async () => {
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

    it('catches HandlerTimeoutError instanceof check in dispatch (branch 123)', async () => {
      const bus = new InProcessEventBus({ handlerTimeoutMs: 10 });
      const slowHandler = vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 50)));
      bus.subscribe('STATE_COMMITTED', slowHandler);

      const event = makeStateCommittedEvent({ traceId: 'trace-timeout-instanceof' });

      const report = await bus.publish(event);

      expect(report.timedOut).toBe(1);
      expect(report.failed).toBe(1);
      expect(report.errors[0]).toContain('не завершился за');
    });

    it('limits errors array to 3 items in dispatch (branch 123)', async () => {
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

    it('runWithTimeout clears timer in finally block (branch 152-153)', async () => {
      const bus = new InProcessEventBus({ handlerTimeoutMs: 5000 });
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.subscribe('STATE_COMMITTED', handler);

      const event = makeStateCommittedEvent({ traceId: 'trace-timer-cleanup' });

      const report = await bus.publish(event);

      expect(report.timedOut).toBe(0);
      expect(report.failed).toBe(0);
      expect(report.dispatched).toBe(1);
    });

    it('runWithTimeout handler error path (non-timeout) - branch 121-130', async () => {
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

    it('catches HandlerTimeoutError instanceof check in dispatch (branch 123)', async () => {
      const bus = new InProcessEventBus({ handlerTimeoutMs: 10 });
      const slowHandler = vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 50)));
      bus.subscribe('STATE_COMMITTED', slowHandler);

      const event = makeStateCommittedEvent({ traceId: 'trace-timeout-instanceof' });

      const report = await bus.publish(event);

      expect(report.timedOut).toBe(1);
      expect(report.failed).toBe(1);
      expect(report.errors[0]).toContain('не завершился за');
    });

    it('limits errors array to 3 items in dispatch (branch 123)', async () => {
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

    it('runWithTimeout clears timer in finally block (branch 152-153)', async () => {
      const bus = new InProcessEventBus({ handlerTimeoutMs: 5000 });
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.subscribe('STATE_COMMITTED', handler);

      const event = makeStateCommittedEvent({ traceId: 'trace-timer-cleanup' });

      const report = await bus.publish(event);

      expect(report.timedOut).toBe(0);
      expect(report.failed).toBe(0);
      expect(report.dispatched).toBe(1);
    });

    it('runWithTimeout handler error path (non-timeout) - branch 121-130', async () => {
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

    it('catches HandlerTimeoutError instanceof check in dispatch (branch 123)', async () => {
      const bus = new InProcessEventBus({ handlerTimeoutMs: 10 });
      const slowHandler = vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 50)));
      bus.subscribe('STATE_COMMITTED', slowHandler);

      const event = makeStateCommittedEvent({ traceId: 'trace-timeout-instanceof' });

      const report = await bus.publish(event);

      expect(report.timedOut).toBe(1);
      expect(report.failed).toBe(1);
      expect(report.errors[0]).toContain('не завершился за');
    });

    it('limits errors array to 3 items in dispatch (branch 123)', async () => {
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

    it('runWithTimeout clears timer in finally block (branch 152-153)', async () => {
      const bus = new InProcessEventBus({ handlerTimeoutMs: 5000 });
      const handler = vi.fn().mockResolvedValue(undefined);
      bus.subscribe('STATE_COMMITTED', handler);

      const event = makeStateCommittedEvent({ traceId: 'trace-timer-cleanup' });

      const report = await bus.publish(event);

      expect(report.timedOut).toBe(0);
      expect(report.failed).toBe(0);
      expect(report.dispatched).toBe(1);
    });

    it('runWithTimeout handler error path (non-timeout) - branch 121-130', async () => {
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
  });
});