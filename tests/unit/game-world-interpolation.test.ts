import { describe, expect, it } from 'vitest';

import { InterpolationBuffer } from '@mnemosin/client';

const config = { interpolationDelayMs: 100, extrapolationLimitMs: 100, maxBufferSize: 16 };
const p2 = '00000000-0000-4000-8000-000000000102';

describe('InterpolationBuffer (NETWORK_PROTOCOL.md §8.4–8.5)', () => {
  it('линейная интерполяция между двумя snapshot с задержкой ~100 мс', () => {
    const buffer = new InterpolationBuffer(config);
    buffer.add(p2, { simulationTick: 0, serverTimeMs: 0, position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 } });
    buffer.add(p2, { simulationTick: 1, serverTimeMs: 50, position: { x: 1, y: 0 }, velocity: { x: 0, y: 0 } });

    // renderServerTimeMs=125 → target=25 → середина между 0 и 50.
    const mid = buffer.sample(p2, 125);
    expect(mid).not.toBeNull();
    expect(mid?.x).toBeCloseTo(0.5, 10);
    expect(mid?.y).toBeCloseTo(0, 10);
  });

  it('до первого snapshot — удержание первой позиции (нет экстраполяции назад)', () => {
    const buffer = new InterpolationBuffer(config);
    buffer.add(p2, { simulationTick: 10, serverTimeMs: 100, position: { x: 5, y: 5 }, velocity: { x: 0, y: 0 } });
    const sample = buffer.sample(p2, 0);
    expect(sample).toEqual({ x: 5, y: 5 });
  });

  it('ограниченная экстраполяция по velocity, затем удержание позиции', () => {
    const buffer = new InterpolationBuffer(config);
    buffer.add(p2, { simulationTick: 0, serverTimeMs: 0, position: { x: 0, y: 0 }, velocity: { x: 2, y: 0 } });
    // target = render - 100; при render=300 target=200, overshoot=100 → +2*0.1=0.2.
    const capped = buffer.sample(p2, 300);
    expect(capped?.x).toBeCloseTo(0.2, 10);
    // При ещё большем опоздании (render=1000, target=900) позиция удерживается на том же пределе.
    const held = buffer.sample(p2, 1000);
    expect(held?.x).toBeCloseTo(0.2, 10);
  });

  it('устаревший snapshot (simulationTick ≤ последнего) игнорируется', () => {
    const buffer = new InterpolationBuffer(config);
    buffer.add(p2, { simulationTick: 5, serverTimeMs: 50, position: { x: 1, y: 0 }, velocity: { x: 0, y: 0 } });
    buffer.add(p2, { simulationTick: 5, serverTimeMs: 55, position: { x: 9, y: 9 }, velocity: { x: 0, y: 0 } });
    buffer.add(p2, { simulationTick: 4, serverTimeMs: 40, position: { x: 9, y: 9 }, velocity: { x: 0, y: 0 } });
    expect(buffer.participantIds()).toEqual([p2]);
  });

  it('reset очищает буферы (reconnect)', () => {
    const buffer = new InterpolationBuffer(config);
    buffer.add(p2, { simulationTick: 0, serverTimeMs: 0, position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 } });
    buffer.reset();
    expect(buffer.sample(p2, 0)).toBeNull();
  });

  it('remove удаляет сущность (entityRemovals)', () => {
    const buffer = new InterpolationBuffer(config);
    buffer.add(p2, { simulationTick: 0, serverTimeMs: 0, position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 } });
    buffer.remove(p2);
    expect(buffer.participantIds()).toEqual([]);
  });
});
