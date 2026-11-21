import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  compileHotWorldGeometry,
  isCirclePositionFree,
  moveCircleWithCollisions,
  parseWorldPack,
  sweepCircleAgainstSegment,
} from '@mnemosin/core';

const pack = parseWorldPack(readFileSync(join(process.cwd(), 'tests/fixtures/worldpack.v4.test.json'), 'utf8'));
const radius = 0.2;
const epsilon = 1e-9;

function geometry(options: Parameters<typeof compileHotWorldGeometry>[1] = {}) {
  return compileHotWorldGeometry(pack, options);
}

function move(start: { x: number; y: number }, displacement: { x: number; y: number }, world = geometry()) {
  return moveCircleWithCollisions(start, displacement, radius, epsilon, world);
}

describe('P04 swept-circle · free movement, walls and sliding', () => {
  it('сохраняет fractional coordinates в свободном пространстве', () => {
    const result = move({ x: 0.5, y: 2.5 }, { x: 0.4, y: 0 });
    expect(result.position).toEqual({ x: 0.9, y: 2.5 });
    expect(result.collided).toBe(false);
  });

  it('останавливает круг на радиусе от solid cell, а не в центре стены', () => {
    const result = move({ x: 0.5, y: 1.5 }, { x: 1, y: 0 });
    expect(result.position.x).toBeCloseTo(0.8, 8);
    expect(result.position.y).toBeCloseTo(1.5, 8);
    expect(result.collided).toBe(true);
  });

  it('сохраняет tangent remainder при sliding вдоль стены', () => {
    const result = move({ x: 0.5, y: 1.5 }, { x: 1, y: 1 });
    expect(result.position.x).toBeCloseTo(0.8, 8);
    expect(result.position.y).toBeCloseTo(2.5, 8);
  });

  it('диагональный подход к углу использует rounded corner, без срезания сквозь него', () => {
    const result = move({ x: 2.5, y: 2.5 }, { x: -1, y: -1 });
    const distanceToCorner = Math.hypot(result.position.x - 2, result.position.y - 2);
    expect(result.collided).toBe(true);
    expect(result.position.x).toBeGreaterThan(2);
    expect(result.position.y).toBeGreaterThan(2);
    expect(distanceToCorner).toBeGreaterThanOrEqual(radius - 1e-7);
  });

  it('start touching: inward блокируется, tangent и separating разрешены', () => {
    expect(move({ x: 0.8, y: 1.5 }, { x: 0.5, y: 0 }).position.x).toBeCloseTo(0.8, 8);
    expect(move({ x: 0.8, y: 1.5 }, { x: 0, y: 0.5 }).position.y).toBeCloseTo(2, 8);
    expect(move({ x: 0.8, y: 1.5 }, { x: -0.3, y: 0 }).position.x).toBeCloseTo(0.5, 8);
  });

  it('нулевое смещение и degenerate segment не создают NaN', () => {
    expect(move({ x: 0.5, y: 2.5 }, { x: 0, y: 0 }).position).toEqual({ x: 0.5, y: 2.5 });
    expect(
      sweepCircleAgainstSegment({ x: 0.5, y: 0.5 }, { x: 1, y: 0 }, radius, epsilon, {
        id: 'point',
        ax: 1,
        ay: 1,
        bx: 1,
        by: 1,
      }),
    ).toBeNull();
  });
});

describe('P04 swept-circle · edges, doors and bounds', () => {
  it('блокирующее edge работает в обе стороны и сохраняет sliding у endpoint', () => {
    expect(move({ x: 0.5, y: 0.5 }, { x: 1, y: 0 }).position.x).toBeCloseTo(0.8, 8);
    expect(move({ x: 1.5, y: 0.5 }, { x: -1, y: 0 }).position.x).toBeCloseTo(1.2, 8);
    const diagonal = move({ x: 0.5, y: 0.5 }, { x: 1, y: 1 });
    expect(diagonal.position.x).toBeCloseTo(0.8, 8);
    expect(diagonal.position.y).toBeCloseTo(1.5, 8);
  });

  it('закрытая и locked дверь блокируют, открытый портал пропускает', () => {
    expect(move({ x: 2.5, y: 2.5 }, { x: 1, y: 0 }).position.x).toBeCloseTo(2.8, 8);
    expect(
      move({ x: 2.5, y: 2.5 }, { x: 1, y: 0 }, geometry({ portalStates: new Map([['door-east', 'locked']]) })).position
        .x,
    ).toBeCloseTo(2.8, 8);
    expect(
      move({ x: 2.5, y: 2.5 }, { x: 1, y: 0 }, geometry({ portalStates: new Map([['door-east', 'open']]) })).position,
    ).toEqual({ x: 3.5, y: 2.5 });
  });

  it('портал блокирует свою пару клеток даже без дублирующего edge', () => {
    const withoutEdge = structuredClone(pack);
    withoutEdge.edges = [];
    const world = compileHotWorldGeometry(withoutEdge);
    const result = moveCircleWithCollisions({ x: 2.5, y: 2.5 }, { x: 1, y: 0 }, radius, epsilon, world);
    expect(result.position.x).toBeCloseTo(2.8, 8);
  });

  it('passage без initialState открыт по контракту, door без состояния отклоняется', () => {
    const passage = structuredClone(pack);
    passage.portals[0]!.kind = 'passage';
    delete passage.portals[0]!.initialState;
    const openWorld = compileHotWorldGeometry(passage);
    expect(moveCircleWithCollisions({ x: 2.5, y: 2.5 }, { x: 1, y: 0 }, radius, epsilon, openWorld).position).toEqual({
      x: 3.5,
      y: 2.5,
    });

    const ambiguous = structuredClone(pack);
    delete ambiguous.portals[0]!.initialState;
    expect(() => compileHotWorldGeometry(ambiguous)).toThrow(/initialState/);
    expect(() => compileHotWorldGeometry(ambiguous, { portalStates: new Map([['door-east', 'open']]) })).not.toThrow();
  });

  it('неизвестная ссылка edge→portal изолируется ошибкой геометрии', () => {
    const broken = structuredClone(pack);
    broken.edges[1]!.portalId = 'missing-door';
    expect(() => compileHotWorldGeometry(broken)).toThrow(/неизвестный portal/);
  });

  it('внешние bounds удерживают весь круг внутри карты', () => {
    const result = move({ x: 0.5, y: 0.5 }, { x: -10, y: -10 });
    expect(result.position.x).toBeCloseTo(0.2, 8);
    expect(result.position.y).toBeCloseTo(0.2, 8);
  });

  it('не допускает tunneling при очень большом разрешённом displacement', () => {
    const result = move({ x: 0.5, y: 1.5 }, { x: 100, y: 0 });
    expect(result.position.x).toBeCloseTo(0.8, 8);
    expect(result.position.x).toBeLessThan(1);
  });

  it('objects[].position само по себе не создаёт неподтверждённый collider', () => {
    const result = move({ x: 1.5, y: 2.5 }, { x: 1, y: 0 });
    expect(result.position).toEqual({ x: 2.5, y: 2.5 });
  });
});

describe('P04 geometry queries и исходная runtime-проекция', () => {
  it('проверяет walkable cell, outside bounds, overlap и допустимое касание', () => {
    const world = geometry();
    expect(isCirclePositionFree({ x: 0.5, y: 1.5 }, radius, epsilon, world)).toBe(true);
    expect(isCirclePositionFree({ x: 1.5, y: 1.5 }, radius, epsilon, world)).toBe(false);
    expect(isCirclePositionFree({ x: -0.1, y: 1.5 }, radius, epsilon, world)).toBe(false);
    expect(isCirclePositionFree({ x: 0.8, y: 1.5 }, radius, epsilon, world)).toBe(true);
    expect(isCirclePositionFree({ x: 0.81, y: 1.5 }, radius, epsilon, world)).toBe(false);
  });

  it('отсутствующая клетка внутри bounds считается solid', () => {
    const incomplete = structuredClone(pack);
    incomplete.cells = incomplete.cells.filter((cell) => !(cell.gx === 0 && cell.gy === 2));
    const world = compileHotWorldGeometry(incomplete);
    expect(isCirclePositionFree({ x: 0.5, y: 2.5 }, radius, epsilon, world)).toBe(false);
  });

  it('физические границы дедуплицируются независимо от повторных определений', () => {
    const world = geometry();
    expect(new Set(world.segments.map((segment) => segment.id)).size).toBe(world.segments.length);
  });
});
