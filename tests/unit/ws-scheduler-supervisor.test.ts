import { afterEach, describe, expect, it, vi } from 'vitest';

import { InputSequence, InputStreamId, SimulationTick } from '@mnemosin/contracts';
import { HotTickScheduler, type HotTickResult } from '@mnemosin/core';
import { HotSchedulerSupervisor, realtimeNetworkConfig } from '@mnemosin/gateway-ws';

const inputStreamId = InputStreamId.parse('00000000-0000-4000-8000-000000000601');

function result(tick: number): HotTickResult {
  const simulationTick = SimulationTick.parse(tick);
  return {
    acknowledgements: [
      {
        inputStreamId,
        lastProcessedInputSequence: InputSequence.parse(tick),
        simulationTick,
        authoritativePosition: { x: 0, y: 0 },
        authoritativeVelocity: { x: 0, y: 0 },
      },
    ],
    diagnostics: { simulationTick, durationMs: 0, overrun: false },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('P05-A scheduler supervisor', () => {
  it('догоняет 1 s backlog за 200 ms при production heartbeat 20 s и публикует все ACK', () => {
    vi.useFakeTimers();
    const network = realtimeNetworkConfig({ heartbeat: { intervalMs: 20_000, idleTimeoutMs: 45_000 } });
    expect(network.schedulerRecoveryIntervalMs).toBe(50);

    let now = 0;
    let publishedAcks = 0;
    let callback: (() => void) | undefined;
    const scheduler = new HotTickScheduler({
      tick: () => {
        const next = result(publishedAcks + 1);
        publishedAcks += next.acknowledgements.length;
        return next;
      },
      now: () => now,
      timers: {
        setInterval: (next) => {
          callback = next;
          return next;
        },
        clearInterval: () => {
          callback = undefined;
        },
      },
    });
    const supervisor = new HotSchedulerSupervisor(scheduler, network.schedulerRecoveryIntervalMs);

    supervisor.start();
    now = 1_000;
    callback?.();
    expect(publishedAcks).toBe(5);
    expect(scheduler.status()).toMatchObject({ started: false, backlogMs: 750 });

    const recoveryStartedAt = now;
    for (let cycle = 0; cycle < 4; cycle += 1) {
      vi.advanceTimersByTime(network.schedulerRecoveryIntervalMs);
      now += network.schedulerRecoveryIntervalMs;
      callback?.();
    }

    expect(now - recoveryStartedAt).toBe(200);
    expect(network.heartbeat.intervalMs).toBe(20_000);
    expect(scheduler.status()).toMatchObject({ started: true, backlogMs: 0 });
    expect(publishedAcks).toBe(24);

    supervisor.stop();
    expect(scheduler.status().started).toBe(false);
  });

  it('не допускает recovery cadence медленнее HOT tick', () => {
    expect(() => realtimeNetworkConfig({ schedulerRecoveryIntervalMs: 51 })).toThrow('1..50');
  });
});
