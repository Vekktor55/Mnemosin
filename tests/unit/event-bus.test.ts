import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { nowIso, type DomainEvent, type SessionId, type TurnId } from '@mnemosin/contracts';
import { createEvent, InMemoryMetricsSink, InProcessEventBus, type EventLog } from '@mnemosin/core';

/**
 * Промпт 1.5 · EventBus (core/events/bus.ts).
 *
 * Проверяются: инвариант 16 (валидация payload ПЕРЕД публикацией), порядок
 * вызова обработчиков (регистрационный), изоляция сбоев, таймаут async-обработчика,
 * publishMany, отписка, метрики.
 */

const sessionId = randomUUID() as SessionId;

function turnOpened(number: number, traceId = 'trace-bus'): DomainEvent {
  return createEvent('TURN_OPENED', { sessionId, turnId: randomUUID() as TurnId, number }, traceId);
}

function invalidEvent(): DomainEvent {
  return {
    type: 'TURN_OPENED',
    payload: { garbage: true },
    traceId: 'trace-bad',
    emittedAt: nowIso(),
  } as unknown as DomainEvent;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Логгер-шпион: структурно совместим с EventLog (и с pino). */
function spyLog(): { log: EventLog; errors: Array<Record<string, unknown>> } {
  const errors: Array<Record<string, unknown>> = [];
  return {
    errors,
    log: {
      info(): void {},
      warn(): void {},
      debug(): void {},
      error(obj: unknown): void {
        errors.push(obj as Record<string, unknown>);
      },
    },
  };
}

describe('InProcessEventBus · инвариант 16', () => {
  it('publish() с невалидным payload бросает VALIDATION и НЕ публикует', async () => {
    const bus = new InProcessEventBus();
    const seen: DomainEvent[] = [];
    bus.subscribe('*', (event) => {
      seen.push(event);
    });

    const failure = await bus.publish(invalidEvent()).then(
      () => null,
      (err: unknown) => err as { code?: string; message: string },
    );
    expect(failure).not.toBeNull();
    expect(failure?.code).toBe('VALIDATION');
    expect(seen).toEqual([]);
  });

  it('createEvent не создаёт событие с невалидным payload', () => {
    expect(() =>
      createEvent('TURN_OPENED', { sessionId, turnId: randomUUID() as TurnId, number: -1 }, 'trace-x'),
    ).toThrow(/VALIDATION|DomainEventSchema|инвариант/);
  });
});

describe('InProcessEventBus · доставка', () => {
  it('обработчики вызываются последовательно в порядке регистрации (тип и «*» — общий список)', async () => {
    const bus = new InProcessEventBus();
    const order: string[] = [];
    bus.subscribe('*', () => {
      order.push('wild-1');
    });
    bus.subscribe('TURN_OPENED', () => {
      order.push('specific');
    });
    bus.subscribe('*', () => {
      order.push('wild-2');
    });

    const report = await bus.publish(turnOpened(1));
    expect(order).toEqual(['wild-1', 'specific', 'wild-2']);
    expect(report).toMatchObject({ type: 'TURN_OPENED', dispatched: 3, failed: 0, timedOut: 0 });
  });

  it('подписчик другого типа не получает событие', async () => {
    const bus = new InProcessEventBus();
    const seen: string[] = [];
    bus.subscribe('TURN_LOCKED', () => {
      seen.push('locked');
    });
    await bus.publish(turnOpened(2));
    expect(seen).toEqual([]);
  });

  it('unsubscribe останавливает доставку; повторный unsubscribe — no-op', async () => {
    const bus = new InProcessEventBus();
    let calls = 0;
    const unsubscribe = bus.subscribe('TURN_OPENED', () => {
      calls += 1;
    });
    await bus.publish(turnOpened(3));
    unsubscribe();
    unsubscribe();
    await bus.publish(turnOpened(4));
    expect(calls).toBe(1);
  });

  it('publishMany сохраняет порядок серии', async () => {
    const bus = new InProcessEventBus();
    const numbers: number[] = [];
    bus.subscribe('TURN_OPENED', (event) => {
      numbers.push(event.payload.number);
    });

    const reports = await bus.publishMany([turnOpened(1), turnOpened(2), turnOpened(3)]);
    expect(reports).toHaveLength(3);
    expect(numbers).toEqual([1, 2, 3]);
  });
});

describe('InProcessEventBus · изоляция сбоев', () => {
  it('исключение в одном обработчике не ломает остальные и логируется с traceId', async () => {
    const { log, errors } = spyLog();
    const bus = new InProcessEventBus({ logger: log });
    const reached: string[] = [];
    bus.subscribe('TURN_OPENED', () => {
      reached.push('first');
    });
    bus.subscribe('TURN_OPENED', () => {
      throw new Error('взрыв обработчика');
    });
    bus.subscribe('TURN_OPENED', async () => {
      await Promise.reject(new Error('async взрыв'));
    });
    bus.subscribe('TURN_OPENED', () => {
      reached.push('last');
    });

    const report = await bus.publish(turnOpened(5, 'trace-failure'));
    expect(reached).toEqual(['first', 'last']);
    expect(report).toMatchObject({ dispatched: 4, failed: 2, timedOut: 0 });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ event: 'TURN_OPENED', traceId: 'trace-failure' });
  });

  it('async-обработчик по таймауту: log error, timedOut++, следующие продолжают работать', async () => {
    const { log, errors } = spyLog();
    const bus = new InProcessEventBus({ handlerTimeoutMs: 30, logger: log });
    const reached: string[] = [];
    bus.subscribe('TURN_OPENED', async () => {
      await sleep(300);
      reached.push('slow'); // успеет выполниться уже после публикации — идемпотентность (D113)
    });
    bus.subscribe('TURN_OPENED', () => {
      reached.push('fast');
    });

    const report = await bus.publish(turnOpened(6));
    expect(report).toMatchObject({ dispatched: 2, failed: 1, timedOut: 1 });
    expect(reached).toEqual(['fast']);
    expect(errors[0]).toMatchObject({ timedOut: true, event: 'TURN_OPENED' });
  });
});

describe('InProcessEventBus · метрики (MetricsSink)', () => {
  it('счётчики published/handler_failed и длительность dispatch растут', async () => {
    const metrics = new InMemoryMetricsSink();
    const bus = new InProcessEventBus({ metrics });
    bus.subscribe('TURN_OPENED', () => {
      throw new Error('boom');
    });

    await bus.publish(turnOpened(7));
    expect(metrics.counterOf('events.published', { type: 'TURN_OPENED' })).toBe(1);
    expect(metrics.counterOf('events.handler_failed', { type: 'TURN_OPENED' })).toBe(1);
    const snapshot = metrics.snapshot();
    expect(snapshot.timings['events.dispatch.duration_ms{type=TURN_OPENED}']?.count).toBe(1);
  });
});
