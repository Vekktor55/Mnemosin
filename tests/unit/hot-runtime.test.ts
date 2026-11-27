import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  InputStreamId,
  ParticipantId,
  SceneInputMessageSchema,
  type ParticipantId as ParticipantIdType,
} from '@mnemosin/contracts';
import {
  FIXED_DT,
  FIXED_DT_MS,
  HotRuntime,
  SIMULATION_HZ,
  parseWorldPack,
  runHotSimulationStep,
  type HotQueuedInput,
  type HotRuntimeConfig,
  type HotRuntimeOptions,
} from '@mnemosin/core';

const pack = parseWorldPack(readFileSync(join(process.cwd(), 'tests/fixtures/worldpack.v4.test.json'), 'utf8'));
const PLAYER_1 = ParticipantId.parse('00000000-0000-4000-8000-000000000101');
const PLAYER_2 = ParticipantId.parse('00000000-0000-4000-8000-000000000102');
const UNKNOWN_PLAYER = ParticipantId.parse('00000000-0000-4000-8000-000000000999');
const STREAM_1 = InputStreamId.parse('00000000-0000-4000-8000-000000000201');
const STREAM_2 = InputStreamId.parse('00000000-0000-4000-8000-000000000202');
const STREAM_3 = InputStreamId.parse('00000000-0000-4000-8000-000000000203');
const CONFIG: HotRuntimeConfig = {
  movementSpeedCellsPerSecond: 2,
  entityRadius: 0.2,
  collisionEpsilon: 1e-9,
  inputLeaseTicks: 100,
};

function makeRuntime(options: Partial<HotRuntimeOptions> = {}): HotRuntime {
  return new HotRuntime({
    pack,
    players: [{ participantId: PLAYER_1, spawnPointId: 'player-1' }],
    config: CONFIG,
    ...options,
  });
}

function input(stream: string, sequence: number, x: number, y: number) {
  return { inputStreamId: stream, inputSequence: sequence, input: { directionX: x, directionY: y } };
}

function player(runtime: HotRuntime, participantId: ParticipantIdType = PLAYER_1) {
  const result = runtime.getState().players.find((candidate) => candidate.participantId === participantId);
  if (result === undefined) throw new Error('player not found');
  return result;
}

describe('P04 HOT clock и authoritative movement', () => {
  it('фиксирует 20 Hz / 50 ms и монотонно увеличивает simulationTick', () => {
    expect(SIMULATION_HZ).toBe(20);
    expect(FIXED_DT).toBe(0.05);
    expect(FIXED_DT_MS).toBe(50);
    const runtime = makeRuntime();
    expect(runtime.getState().simulationTick).toBe(0);
    runtime.tick();
    runtime.tick();
    expect(runtime.getState().simulationTick).toBe(2);
  });

  it('двигает горизонтально и вертикально с серверной скоростью и fractional coordinates', () => {
    const horizontal = makeRuntime();
    horizontal.receiveInput(PLAYER_1, input(STREAM_1, 1, 1, 0));
    horizontal.tick();
    expect(player(horizontal).position.x).toBeCloseTo(0.6, 10);
    expect(player(horizontal).position.y).toBe(2.5);
    expect(player(horizontal).velocity.x).toBeCloseTo(2, 10);

    const vertical = makeRuntime();
    vertical.receiveInput(PLAYER_1, input(STREAM_1, 1, 0, -1));
    vertical.tick();
    expect(player(vertical).position.x).toBe(0.5);
    expect(player(vertical).position.y).toBeCloseTo(2.4, 10);
  });

  it('нормализует диагональ: длина displacement равна осевому', () => {
    const runtime = makeRuntime();
    runtime.receiveInput(PLAYER_1, input(STREAM_1, 1, 1, 1));
    runtime.tick();
    const position = player(runtime).position;
    expect(position.x - 0.5).toBeCloseTo(0.1 / Math.sqrt(2), 10);
    expect(position.y - 2.5).toBeCloseTo(0.1 / Math.sqrt(2), 10);
    expect(Math.hypot(position.x - 0.5, position.y - 2.5)).toBeCloseTo(0.1, 10);
  });

  it('held direction сохраняется между тиками, явный zero останавливает', () => {
    const runtime = makeRuntime();
    runtime.receiveInput(PLAYER_1, input(STREAM_1, 1, 1, 0));
    runtime.tick();
    runtime.tick();
    runtime.tick();
    expect(player(runtime).position.x).toBeCloseTo(0.8, 10);
    runtime.receiveInput(PLAYER_1, input(STREAM_1, 2, 0, 0));
    runtime.tick();
    const stopped = player(runtime).position.x;
    runtime.tick();
    expect(player(runtime).position.x).toBe(stopped);
    expect(player(runtime).velocity).toEqual({ x: 0, y: 0 });
  });

  it('input lease автоматически сбрасывает движение после configured ticks', () => {
    const runtime = makeRuntime({ config: { ...CONFIG, inputLeaseTicks: 2 } });
    runtime.receiveInput(PLAYER_1, input(STREAM_1, 1, 1, 0));
    runtime.tick();
    runtime.tick();
    expect(player(runtime).position.x).toBeCloseTo(0.7, 10);
    runtime.tick();
    expect(player(runtime).position.x).toBeCloseTo(0.7, 10);
    expect(player(runtime).direction).toEqual({ directionX: 0, directionY: 0 });
  });

  it('выдаёт контрактный cumulative ACK с authoritative position/velocity', () => {
    const runtime = makeRuntime();
    runtime.receiveInput(PLAYER_1, input(STREAM_1, 7, 1, 0));
    const result = runtime.tick();
    expect(result.acknowledgements).toHaveLength(1);
    expect(result.acknowledgements[0]).toMatchObject({
      inputStreamId: STREAM_1,
      lastProcessedInputSequence: 7,
      simulationTick: 1,
      authoritativePosition: player(runtime).position,
      authoritativeVelocity: player(runtime).velocity,
    });
  });
});

describe('P04 movement input · sequence, streams и недоверенные поля', () => {
  it('повторные и устаревшие sequence не меняют направление', () => {
    const runtime = makeRuntime();
    expect(runtime.receiveInput(PLAYER_1, input(STREAM_1, 5, 1, 0))).toEqual({
      accepted: true,
      arrivalSequence: 1,
    });
    expect(runtime.receiveInput(PLAYER_1, input(STREAM_1, 5, -1, 0))).toEqual({
      accepted: false,
      reason: 'stale_sequence',
    });
    expect(runtime.receiveInput(PLAYER_1, input(STREAM_1, 4, 0, 1))).toEqual({
      accepted: false,
      reason: 'stale_sequence',
    });
    runtime.tick();
    expect(player(runtime).direction).toEqual({ directionX: 1, directionY: 0 });
    expect(player(runtime).position.x).toBeCloseTo(0.6, 10);
  });

  it('несколько fresh inputs применяются в arrival order; ACK подтверждает последний', () => {
    const runtime = makeRuntime();
    runtime.receiveInput(PLAYER_1, input(STREAM_1, 1, 1, 0));
    runtime.receiveInput(PLAYER_1, input(STREAM_1, 2, 0, -1));
    const result = runtime.tick();
    expect(player(runtime).position.x).toBe(0.5);
    expect(player(runtime).position.y).toBeCloseTo(2.4, 10);
    expect(result.acknowledgements[0]?.lastProcessedInputSequence).toBe(2);
  });

  it('смена stream требует явной активации и отсекает старые packets', () => {
    const runtime = makeRuntime();
    runtime.receiveInput(PLAYER_1, input(STREAM_1, 10, 1, 0));
    runtime.tick();
    expect(runtime.receiveInput(PLAYER_1, input(STREAM_2, 0, -1, 0))).toEqual({
      accepted: false,
      reason: 'inactive_stream',
    });
    runtime.tick();
    expect(player(runtime).position.x).toBeCloseTo(0.7, 10);

    runtime.activateInputStream(PLAYER_1, STREAM_2);
    expect(player(runtime).direction).toEqual({ directionX: 0, directionY: 0 });
    expect(runtime.receiveInput(PLAYER_1, input(STREAM_1, 11, 1, 0))).toEqual({
      accepted: false,
      reason: 'inactive_stream',
    });
    expect(runtime.receiveInput(PLAYER_1, input(STREAM_2, 0, -1, 0))).toMatchObject({ accepted: true });
    runtime.tick();
    expect(player(runtime).position.x).toBeCloseTo(0.6, 10);
  });

  it('повторная активация того же stream не сбрасывает последовательность', () => {
    const runtime = makeRuntime();
    runtime.receiveInput(PLAYER_1, input(STREAM_1, 3, 1, 0));
    runtime.activateInputStream(PLAYER_1, STREAM_1);
    expect(runtime.receiveInput(PLAYER_1, input(STREAM_1, 3, 0, 0))).toEqual({
      accepted: false,
      reason: 'stale_sequence',
    });
  });

  it('некорректные сообщения и unknown player не меняют состояние', () => {
    const runtime = makeRuntime();
    const invalid = [
      null,
      {},
      input(STREAM_1, -1, 1, 0),
      input(STREAM_1, 1, 2, 0),
      input(STREAM_1, 1, Number.NaN, 0),
      { inputStreamId: 'not-a-uuid', inputSequence: 1, input: { directionX: 1, directionY: 0 } },
    ];
    for (const message of invalid) {
      expect(runtime.receiveInput(PLAYER_1, message)).toEqual({ accepted: false, reason: 'invalid_message' });
    }
    expect(runtime.receiveInput(UNKNOWN_PLAYER, input(STREAM_1, 1, 1, 0))).toEqual({
      accepted: false,
      reason: 'unknown_player',
    });
    runtime.tick();
    expect(player(runtime).position).toEqual({ x: 0.5, y: 2.5 });
    expect(player(runtime).activeInputStreamId).toBeNull();
    expect(() => runtime.activateInputStream(UNKNOWN_PLAYER, STREAM_1)).toThrow(/неизвестный participantId/);
  });

  it('клиентские position/speed/acceleration не телепортируют и не ускоряют игрока', () => {
    const runtime = makeRuntime();
    const spoofedStop = {
      ...input(STREAM_1, 1, 0, 0),
      authoritativePosition: { x: 3.5, y: 3.5 },
      speed: 10_000,
      acceleration: 500,
    };
    expect(runtime.receiveInput(PLAYER_1, spoofedStop)).toMatchObject({ accepted: true });
    runtime.tick();
    expect(player(runtime).position).toEqual({ x: 0.5, y: 2.5 });

    const spoofedMove = {
      ...input(STREAM_1, 2, 1, 0),
      input: { directionX: 1, directionY: 0, position: { x: 3.5, y: 3.5 }, speed: 10_000 },
    };
    runtime.receiveInput(PLAYER_1, spoofedMove);
    runtime.tick();
    expect(player(runtime).position.x).toBeCloseTo(0.6, 10);
    expect(player(runtime).position.y).toBe(2.5);
  });

  it('одинаковая последовательность входов детерминированно воспроизводит состояние', () => {
    const simulate = (): unknown => {
      const runtime = makeRuntime({
        players: [
          { participantId: PLAYER_1, spawnPointId: 'player-1' },
          { participantId: PLAYER_2, spawnPointId: 'player-2' },
        ],
      });
      runtime.receiveInput(PLAYER_2, input(STREAM_2, 1, 0, 1));
      runtime.receiveInput(PLAYER_1, input(STREAM_1, 1, 1, 1));
      runtime.tick();
      runtime.receiveInput(PLAYER_1, input(STREAM_1, 2, -1, 0));
      runtime.receiveInput(PLAYER_2, input(STREAM_2, 2, 0, 0));
      runtime.tick();
      return runtime.getState();
    };
    expect(simulate()).toEqual(simulate());
  });

  it('чистый step не мутирует state и повторно отсекает stale/inactive/unknown inputs', () => {
    const runtime = makeRuntime();
    runtime.activateInputStream(PLAYER_1, STREAM_1);
    const before = runtime.getState();
    const snapshot = structuredClone(before);
    const queued = (arrivalSequence: number, participantId: ParticipantIdType, stream: string, sequence: number) =>
      ({
        arrivalSequence,
        participantId,
        message: SceneInputMessageSchema.parse(input(stream, sequence, 1, 0)),
      }) satisfies HotQueuedInput;
    const valid = queued(2, PLAYER_1, STREAM_1, 5);
    const result = runHotSimulationStep(
      before,
      [queued(1, UNKNOWN_PLAYER, STREAM_3, 1), valid, queued(3, PLAYER_1, STREAM_2, 6)],
      runtime.geometry,
      CONFIG,
    );
    expect(before).toEqual(snapshot);
    expect(result.acknowledgements).toHaveLength(1);
    const repeated = runHotSimulationStep(result.state, [valid], runtime.geometry, CONFIG);
    expect(repeated.acknowledgements).toHaveLength(0);
    expect(repeated.state.players[0]?.lastProcessedInputSequence).toBe(5);
    expect(repeated.state.players[0]?.direction).toEqual(result.state.players[0]?.direction);
  });
});

describe('P04 runtime config и tick diagnostics', () => {
  it('диагностирует tick overrun по monotonic clock, не меняя FIXED_DT', () => {
    const times = [100, 100, 100, 151];
    const runtime = makeRuntime({ now: () => times.shift() ?? 151 });
    expect(runtime.tick().diagnostics).toMatchObject({ simulationTick: 1, durationMs: 0, overrun: false });
    expect(runtime.tick().diagnostics).toMatchObject({ simulationTick: 2, durationMs: 51, overrun: true });
  });

  it.each([
    ['movementSpeedCellsPerSecond', 0],
    ['movementSpeedCellsPerSecond', Number.NaN],
    ['entityRadius', 0],
    ['collisionEpsilon', 0],
    ['collisionEpsilon', 0.3],
    ['inputLeaseTicks', 0],
    ['inputLeaseTicks', 1.5],
  ])('отклоняет config %s=%s', (key, value) => {
    expect(() => makeRuntime({ config: { ...CONFIG, [key]: value } })).toThrow(/HOT config/);
  });

  it('отклоняет duplicate player, unknown spawn и spawn внутри collision geometry', () => {
    expect(() =>
      makeRuntime({
        players: [
          { participantId: PLAYER_1, spawnPointId: 'player-1' },
          { participantId: PLAYER_1, spawnPointId: 'player-1' },
        ],
      }),
    ).toThrow(/дубликат/);
    expect(() => makeRuntime({ players: [{ participantId: PLAYER_1, spawnPointId: 'missing' }] })).toThrow(
      /spawnPointId/,
    );
    const badPack = structuredClone(pack);
    badPack.spawnPoints[0]!.position = { x: 1.5, y: 1.5 };
    expect(() => makeRuntime({ pack: badPack })).toThrow(/пересекается/);
  });
});
