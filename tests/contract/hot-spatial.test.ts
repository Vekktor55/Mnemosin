import { describe, expect, it } from 'vitest';

import { MovementInputSchema, SceneInputAckMessageSchema, SceneInputMessageSchema } from '@mnemosin/contracts';

const STREAM_ID = '00000000-0000-4000-8000-000000003001';
const MESSAGE = {
  inputStreamId: STREAM_ID,
  inputSequence: 4,
  input: { directionX: 0.5, directionY: -0.25 },
  clientSentAt: 123,
};

describe('P04 contract · client movement input ограничен held direction', () => {
  it('сохраняет существующие transport keys и не добавляет position/speed/mode в контракт', () => {
    expect(Object.keys(SceneInputMessageSchema.shape)).toEqual([
      'inputStreamId',
      'inputSequence',
      'input',
      'clientSentAt',
    ]);
    expect(Object.keys(MovementInputSchema.shape)).toEqual(['directionX', 'directionY']);
  });

  it('Zod stripping не сохраняет spoofed authoritativePosition/speed/acceleration', () => {
    const parsed = SceneInputMessageSchema.parse({
      ...MESSAGE,
      authoritativePosition: { x: 99, y: 99 },
      speed: 10_000,
      acceleration: 500,
      input: { ...MESSAGE.input, position: { x: 99, y: 99 }, speed: 10_000 },
    });
    expect(parsed).toEqual(MESSAGE);
    expect(parsed).not.toHaveProperty('authoritativePosition');
    expect(parsed).not.toHaveProperty('speed');
    expect(parsed.input).not.toHaveProperty('position');
  });

  it.each([
    { directionX: -1.01, directionY: 0 },
    { directionX: 0, directionY: 1.01 },
    { directionX: Number.NaN, directionY: 0 },
    { directionX: 0, directionY: Number.POSITIVE_INFINITY },
  ])('отклоняет некорректное направление %j', (direction) => {
    expect(MovementInputSchema.safeParse(direction).success).toBe(false);
  });

  it.each([
    { ...MESSAGE, inputStreamId: 'not-a-stream' },
    { ...MESSAGE, inputSequence: -1 },
    { ...MESSAGE, inputSequence: 1.5 },
    { ...MESSAGE, input: { directionX: 2, directionY: 0 } },
  ])('отклоняет invalid stream/sequence/input %#', (message) => {
    expect(SceneInputMessageSchema.safeParse(message).success).toBe(false);
  });
});

describe('P04 contract · server ACK', () => {
  it('подтверждает cumulative sequence/tick и authoritative server position/velocity', () => {
    const ack = SceneInputAckMessageSchema.parse({
      inputStreamId: STREAM_ID,
      lastProcessedInputSequence: 4,
      simulationTick: 8,
      authoritativePosition: { x: 0.6000000000000001, y: 2.5 },
      authoritativeVelocity: { x: 2, y: 0 },
    });
    expect(ack.lastProcessedInputSequence).toBe(4);
    expect(ack.simulationTick).toBe(8);
    expect(ack.authoritativePosition.x).toBeCloseTo(0.6, 10);
  });

  it('требует authoritativePosition и nonnegative sequence/tick', () => {
    const ack = {
      inputStreamId: STREAM_ID,
      lastProcessedInputSequence: 4,
      simulationTick: 8,
      authoritativePosition: { x: 0.6, y: 2.5 },
    };
    const { authoritativePosition: _position, ...withoutPosition } = ack;
    expect(SceneInputAckMessageSchema.safeParse(withoutPosition).success).toBe(false);
    expect(SceneInputAckMessageSchema.safeParse({ ...ack, lastProcessedInputSequence: -1 }).success).toBe(false);
    expect(SceneInputAckMessageSchema.safeParse({ ...ack, simulationTick: -1 }).success).toBe(false);
  });
});
