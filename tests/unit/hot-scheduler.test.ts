import { afterEach, describe, expect, it, vi } from 'vitest';

import { SimulationTick } from '@mnemosin/contracts';
import {
  HotTickScheduler,
  type HotSchedulerDiagnostics,
  type HotTickResult,
  type HotTimerAdapter,
} from '@mnemosin/core';

function result(tick: number, durationMs = 0): HotTickResult {
  return {
    acknowledgements: [],
    diagnostics: { simulationTick: SimulationTick.parse(tick), durationMs, overrun: durationMs > 50 },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('P04 HOT scheduler · fixed-step accumulator и diagnostics', () => {
  it('выполняет ограниченный catch-up, измеряет lag и не запускается дважды', () => {
    let now = 0;
    let ticks = 0;
    let callback: (() => void) | undefined;
    let timerCalls = 0;
    let clears = 0;
    const diagnostics: HotSchedulerDiagnostics[] = [];
    const timers: HotTimerAdapter = {
      setInterval(cb, intervalMs) {
        expect(intervalMs).toBe(50);
        callback = cb;
        timerCalls += 1;
        return { timerCalls };
      },
      clearInterval() {
        clears += 1;
      },
    };
    const scheduler = new HotTickScheduler({
      tick: () => result(++ticks),
      now: () => now,
      timers,
      onDiagnostics: (entry) => diagnostics.push(entry),
    });

    scheduler.start();
    scheduler.start();
    expect(timerCalls).toBe(1);
    now = 120;
    callback?.();
    expect(ticks).toBe(2);
    expect(scheduler.status().backlogMs).toBeCloseTo(20, 10);
    expect(diagnostics.map((entry) => entry.catchUpStep)).toEqual([1, 2]);
    expect(diagnostics[0]).toMatchObject({ eventLoopLagMs: 70, pausedForBacklog: false });

    callback?.();
    expect(ticks).toBe(2);
    scheduler.stop();
    expect(clears).toBe(1);
    expect(scheduler.status()).toEqual({ started: false, backlogMs: 0, maxCatchUpSteps: 5 });
    callback?.();
    expect(ticks).toBe(2);
  });

  it('при чрезмерном backlog pauses без silent time drop и может возобновиться', () => {
    let now = 0;
    let ticks = 0;
    const diagnostics: HotSchedulerDiagnostics[] = [];
    const scheduler = new HotTickScheduler({
      tick: () => result(++ticks),
      now: () => now,
      maxCatchUpSteps: 2,
      timers: { setInterval: () => ({}), clearInterval: () => undefined },
      onDiagnostics: (entry) => diagnostics.push(entry),
    });
    scheduler.start();
    now = 350;
    scheduler.runOnce();
    expect(ticks).toBe(2);
    expect(scheduler.status()).toEqual({ started: false, backlogMs: 250, maxCatchUpSteps: 2 });
    expect(diagnostics[1]).toMatchObject({ pausedForBacklog: true, backlogMs: 250 });

    scheduler.start();
    scheduler.runOnce();
    expect(ticks).toBe(4);
    expect(scheduler.status().backlogMs).toBe(150);
    scheduler.stop();
  });

  it('не интегрирует backward wall-clock delta', () => {
    let now = 100;
    let ticks = 0;
    const scheduler = new HotTickScheduler({
      tick: () => result(++ticks),
      now: () => now,
      timers: { setInterval: () => ({}), clearInterval: () => undefined },
    });
    scheduler.start();
    now = 50;
    scheduler.runOnce();
    expect(ticks).toBe(0);
    scheduler.runOnce();
    expect(ticks).toBe(0);
    scheduler.stop();
  });

  it.each([0, -1, 1.5])('отклоняет maxCatchUpSteps=%s', (value) => {
    expect(() => new HotTickScheduler({ tick: () => result(1), maxCatchUpSteps: value })).toThrow(/maxCatchUpSteps/);
  });

  it('default timer adapter запускает 50 ms цикл и unref-совместимо останавливается', () => {
    vi.useFakeTimers();
    let ticks = 0;
    const scheduler = new HotTickScheduler({ tick: () => result(++ticks) });
    scheduler.start();
    vi.advanceTimersByTime(120);
    scheduler.stop();
    expect(ticks).toBe(2);
  });
});
