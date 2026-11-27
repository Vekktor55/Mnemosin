import { describe, expect, it } from 'vitest';

import { ClientPrediction, normalizeDirection, directionFromKeys } from '@mnemosin/client';

const config = { speedCellsPerSecond: 2, fixedDtSeconds: 0.05 };
const start = { x: 0.5, y: 2.5 };

describe('normalizeDirection / directionFromKeys (G1)', () => {
  it('ось: единичный вектор', () => {
    expect(normalizeDirection(1, 0)).toEqual({ directionX: 1, directionY: 0 });
    expect(normalizeDirection(0, -1)).toEqual({ directionX: 0, directionY: -1 });
  });

  it('диагональ нормализуется (длина 1, не быстрее оси)', () => {
    const diagonal = normalizeDirection(1, 1);
    expect(diagonal.directionX).toBeCloseTo(Math.SQRT1_2, 10);
    expect(diagonal.directionY).toBeCloseTo(Math.SQRT1_2, 10);
  });

  it('(0,0) останавливает движение', () => {
    expect(normalizeDirection(0, 0)).toEqual({ directionX: 0, directionY: 0 });
  });

  it('масштаб не влияет на направление (3,4) → (0.6, 0.8)', () => {
    const normalized = normalizeDirection(3, 4);
    expect(normalized.directionX).toBeCloseTo(0.6, 10);
    expect(normalized.directionY).toBeCloseTo(0.8, 10);
  });

  it('directionFromKeys: WASD/стрелки и диагональ', () => {
    expect(directionFromKeys({ up: false, down: false, left: false, right: true })).toEqual({
      directionX: 1,
      directionY: 0,
    });
    const diagonal = directionFromKeys({ up: false, down: true, left: false, right: true });
    expect(diagonal.directionX).toBeCloseTo(Math.SQRT1_2, 10);
    expect(diagonal.directionY).toBeCloseTo(Math.SQRT1_2, 10);
    expect(directionFromKeys({ up: false, down: false, left: false, right: false })).toEqual({
      directionX: 0,
      directionY: 0,
    });
  });
});

describe('ClientPrediction (NETWORK_PROTOCOL.md §8.2–8.3)', () => {
  it('advance интегрирует по направлению со скоростью speed', () => {
    const prediction = new ClientPrediction(start, config);
    prediction.onInput({ directionX: 1, directionY: 0 });
    const position = prediction.advance(0.05);
    expect(position.x).toBeCloseTo(0.5 + 2 * 0.05, 10);
    expect(position.y).toBeCloseTo(2.5, 10);
  });

  it('reconcile удаляет подтверждённые inputs и переигрывает неподтверждённые', () => {
    const prediction = new ClientPrediction(start, config);
    const first = prediction.onInput({ directionX: 1, directionY: 0 });
    prediction.onInput({ directionX: 0, directionY: -1 });
    expect(first).toBe(1);
    // Сервер подтвердил первый input: baseline = (0.5+0.1, 2.5); остался один неподтверждённый.
    prediction.reconcile({
      lastProcessedInputSequence: 1,
      authoritativePosition: { x: 0.6, y: 2.5 },
    });
    const snap = prediction.snapshot();
    expect(snap.pendingCount).toBe(1);
    expect(snap.predicted.x).toBeCloseTo(0.6, 10);
    expect(snap.predicted.y).toBeCloseTo(2.5 - 2 * 0.05, 10);
    expect(snap.authoritative).toEqual({ x: 0.6, y: 2.5 });
  });

  it('клиентское сообщение не меняет authoritative позицию (authority на сервере)', () => {
    const prediction = new ClientPrediction(start, config);
    prediction.onInput({ directionX: 1, directionY: 0 });
    prediction.advance(0.5);
    // predicted сдвинулся, но authoritative остался на серверной позиции.
    expect(prediction.snapshot().authoritative).toEqual(start);
  });

  it('детерминизм: одинаковая последовательность inputs и acks → одинаковый predicted', () => {
    const run = (): { x: number; y: number } => {
      const prediction = new ClientPrediction(start, config);
      prediction.onInput({ directionX: 1, directionY: 0 });
      prediction.advance(0.03);
      prediction.onInput({ directionX: 1, directionY: 0 });
      prediction.reconcile({ lastProcessedInputSequence: 1, authoritativePosition: { x: 0.6, y: 2.5 } });
      prediction.advance(0.02);
      return prediction.snapshot().predicted;
    };
    expect(run()).toEqual(run());
  });

  it('reset при reconnect сбрасывает очередь и направление', () => {
    const prediction = new ClientPrediction(start, config);
    prediction.onInput({ directionX: 1, directionY: 0 });
    prediction.advance(0.1);
    prediction.reset({ x: 3.5, y: 0.5 });
    const snap = prediction.snapshot();
    expect(snap.pendingCount).toBe(0);
    expect(snap.predicted).toEqual({ x: 3.5, y: 0.5 });
    expect(snap.authoritative).toEqual({ x: 3.5, y: 0.5 });
  });
});
