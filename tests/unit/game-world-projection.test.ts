import { describe, expect, it } from 'vitest';

import { GridProjection, depthKey, depthTieBreak } from '@mnemosin/client';

/** Фронтальная ортографическая 3/4 (tileDepth/tileWidth = 40/64 = 0.625). */
const projection = new GridProjection({
  tileWidth: 64,
  tileDepth: 40,
  originX: 128,
  originY: 96,
  elevationStep: 48,
});

describe('GridProjection (WORLD_SIMULATION.md §4.4, фронтальная 3/4 oblique)', () => {
  it('worldToScreen использует фронтальную 3/4 формулу с elevation', () => {
    expect(projection.worldToScreen({ x: 0, y: 0 })).toEqual({ x: 128, y: 96 });
    expect(projection.worldToScreen({ x: 1, y: 0 })).toEqual({ x: 192, y: 96 });
    expect(projection.worldToScreen({ x: 0, y: 1 })).toEqual({ x: 128, y: 136 });
    // elevation смещает только screenY (presentation-only).
    expect(projection.worldToScreen({ x: 0, y: 0 }, 2)).toEqual({ x: 128, y: 96 - 96 });
  });

  it('screenToWorld — обратное преобразование (round-trip с погрешностью)', () => {
    for (const world of [
      { x: 2.5, y: 1.5 },
      { x: 0, y: 0 },
      { x: 3.25, y: 0.75 },
    ]) {
      const screen = projection.worldToScreen(world);
      const back = projection.screenToWorld(screen);
      expect(back.x).toBeCloseTo(world.x, 10);
      expect(back.y).toBeCloseTo(world.y, 10);
    }
  });

  it('cellToAnchor — центр клетки (gx+0.5, gy+0.5)', () => {
    const anchor = projection.cellToAnchor(2, 3);
    expect(anchor).toEqual(projection.worldToScreen({ x: 2.5, y: 3.5 }));
  });

  it('pointerToCell — floor(screenToWorld) по G2', () => {
    const center = projection.cellToAnchor(2, 3);
    expect(projection.pointerToCell(center)).toEqual({ gx: 2, gy: 3 });
  });

  it('depthKey — foot point worldY + стабильный tie-breaker worldX', () => {
    expect(depthKey({ x: 2.5, y: 1.5 })).toBe(1.5);
    expect(depthKey({ x: 0.25, y: 0.75 })).toBe(0.75);
    expect(depthTieBreak({ x: 2.5, y: 1.5 })).toBe(2.5);
    expect(depthTieBreak({ x: 0.25, y: 0.75 })).toBe(0.25);
  });

  it('серверная координата не меняется клиентской проекцией', () => {
    const world = { x: 1.25, y: 2.75 };
    const screen = projection.worldToScreen(world);
    const back = projection.screenToWorld(screen);
    expect(back.x).toBeCloseTo(world.x, 10);
    expect(back.y).toBeCloseTo(world.y, 10);
    // projection config неизменяем после конструктора.
    expect(Object.isFrozen(projection.config)).toBe(true);
  });
});
