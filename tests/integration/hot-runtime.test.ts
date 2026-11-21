import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { InputStreamId, ParticipantId } from '@mnemosin/contracts';
import {
  HotRuntime,
  HotTickScheduler,
  parseWorldPack,
  type HotRuntimeOptions,
  type HotTimerAdapter,
} from '@mnemosin/core';

const fixture = readFileSync(join(process.cwd(), 'tests/fixtures/worldpack.v4.test.json'), 'utf8');
const PLAYER_1 = ParticipantId.parse('00000000-0000-4000-8000-000000001001');
const PLAYER_2 = ParticipantId.parse('00000000-0000-4000-8000-000000001002');
const STREAM_1 = InputStreamId.parse('00000000-0000-4000-8000-000000002001');
const STREAM_2 = InputStreamId.parse('00000000-0000-4000-8000-000000002002');

function makeRuntime(options: Partial<HotRuntimeOptions> = {}): HotRuntime {
  return new HotRuntime({
    pack: parseWorldPack(fixture),
    players: [
      { participantId: PLAYER_1, spawnPointId: 'player-1' },
      { participantId: PLAYER_2, spawnPointId: 'player-2' },
    ],
    config: {
      movementSpeedCellsPerSecond: 2,
      entityRadius: 0.2,
      collisionEpsilon: 1e-9,
      inputLeaseTicks: 100,
    },
    ...options,
  });
}

function input(stream: string, sequence: number, x: number, y: number) {
  return { inputStreamId: stream, inputSequence: sequence, input: { directionX: x, directionY: y } };
}

function position(runtime: HotRuntime, participantId: typeof PLAYER_1) {
  return runtime.getState().players.find((player) => player.participantId === participantId)?.position;
}

describe('P04 integration · authoritative движение двух игроков в P03 test room', () => {
  it('два игрока непрерывно движутся на сервере и останавливаются у непроходимой геометрии', () => {
    const runtime = makeRuntime();
    expect(runtime.receiveInput(PLAYER_1, input(STREAM_1, 1, 1, 0))).toMatchObject({ accepted: true });
    expect(runtime.receiveInput(PLAYER_2, input(STREAM_2, 1, -1, 0))).toMatchObject({ accepted: true });

    const first = runtime.tick();
    expect(first.diagnostics.simulationTick).toBe(1);
    expect(position(runtime, PLAYER_1)?.x).toBeCloseTo(0.6, 10);
    expect(position(runtime, PLAYER_2)?.x).toBeCloseTo(3.4, 10);
    expect(first.acknowledgements.map((ack) => ack.inputStreamId)).toEqual([STREAM_1, STREAM_2]);

    for (let index = 1; index < 30; index += 1) runtime.tick();
    expect(runtime.getState().simulationTick).toBe(30);
    expect(position(runtime, PLAYER_1)?.x).toBeCloseTo(2.8, 8);
    expect(position(runtime, PLAYER_1)?.y).toBe(2.5);
    expect(position(runtime, PLAYER_2)?.x).toBeCloseTo(1.2, 8);
    expect(position(runtime, PLAYER_2)?.y).toBe(0.5);
  });

  it('состояние той же P03 door определяет closed collision и open passage', () => {
    const simulate = (portalState: 'closed' | 'open'): number => {
      const pack = parseWorldPack(fixture);
      pack.spawnPoints[1]!.position = { x: 2.5, y: 2.5 };
      const runtime = makeRuntime({
        pack,
        portalStates: new Map([['door-east', portalState]]),
        players: [{ participantId: PLAYER_2, spawnPointId: 'player-2' }],
      });
      runtime.receiveInput(PLAYER_2, input(STREAM_2, 1, 1, 0));
      for (let index = 0; index < 10; index += 1) runtime.tick();
      return position(runtime, PLAYER_2)?.x ?? Number.NaN;
    };
    expect(simulate('closed')).toBeCloseTo(2.8, 8);
    expect(simulate('open')).toBeCloseTo(3.5, 8);
  });

  it('scheduler доставляет fixed ticks в runtime, а ingress остаётся внешней операцией', () => {
    let now = 0;
    let scheduled: (() => void) | undefined;
    const timers: HotTimerAdapter = {
      setInterval(callback) {
        scheduled = callback;
        return {};
      },
      clearInterval: () => undefined,
    };
    const runtime = makeRuntime();
    const scheduler = new HotTickScheduler({ tick: () => runtime.tick(), now: () => now, timers });
    runtime.receiveInput(PLAYER_1, input(STREAM_1, 1, 1, 0));
    runtime.receiveInput(PLAYER_2, input(STREAM_2, 2, 0, -1));
    scheduler.start();
    now = 125;
    scheduled?.();

    expect(runtime.getState().simulationTick).toBe(2);
    expect(position(runtime, PLAYER_1)?.x).toBeCloseTo(0.7, 10);
    expect(position(runtime, PLAYER_2)?.y).toBeCloseTo(0.3, 10);
    expect(scheduler.status().backlogMs).toBe(25);
    scheduler.stop();
  });

  it('stable participant order не зависит от порядка внешней доставки игроков', () => {
    const simulate = (reverse: boolean): unknown => {
      const runtime = makeRuntime();
      const deliveries = [
        () => runtime.receiveInput(PLAYER_1, input(STREAM_1, 1, 1, 0)),
        () => runtime.receiveInput(PLAYER_2, input(STREAM_2, 1, 0, 1)),
      ];
      if (reverse) deliveries.reverse();
      deliveries.forEach((deliver) => deliver());
      const tick = runtime.tick();
      expect(tick.acknowledgements.map((ack) => ack.inputStreamId)).toEqual([STREAM_1, STREAM_2]);
      return runtime.getState();
    };
    expect(simulate(true)).toEqual(simulate(false));
  });

  it('даже экстремальная prototype speed не даёт tunneling за один server tick', () => {
    const pack = parseWorldPack(fixture);
    pack.spawnPoints[0]!.position = { x: 0.5, y: 1.5 };
    const runtime = makeRuntime({
      pack,
      players: [{ participantId: PLAYER_1, spawnPointId: 'player-1' }],
      config: {
        movementSpeedCellsPerSecond: 1_000,
        entityRadius: 0.2,
        collisionEpsilon: 1e-9,
        inputLeaseTicks: 100,
      },
    });
    runtime.receiveInput(PLAYER_1, input(STREAM_1, 1, 1, 0));
    runtime.tick();
    expect(position(runtime, PLAYER_1)?.x).toBeCloseTo(0.8, 8);
    expect(position(runtime, PLAYER_1)?.x).toBeLessThan(1);
  });
});
