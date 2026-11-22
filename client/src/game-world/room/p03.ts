/**
 * PROTOTYPE-ONLY: статичная визуальная геометрия тестовой комнаты P03
 * (tests/fixtures/worldpack.v4.test.json).
 *
 * Только для ОТРИСОВКИ. Авторитетной collision-геометрией остаётся сервер
 * (core/src/hot): клиент никогда не решает проходимость по этой карте.
 * Production-геометрия придёт через asset/content flow (P14, NETWORK_PROTOCOL §9.7).
 */

export interface RoomBounds {
  readonly minGx: number;
  readonly minGy: number;
  readonly maxGx: number;
  readonly maxGy: number;
}

export interface RoomWallCell {
  readonly gx: number;
  readonly gy: number;
}

export interface RoomDoorEdge {
  readonly from: { readonly gx: number; readonly gy: number };
  readonly to: { readonly gx: number; readonly gy: number };
}

export interface RoomPrototypeGeometry {
  readonly bounds: RoomBounds;
  readonly wallCells: readonly RoomWallCell[];
  readonly doorEdges: readonly RoomDoorEdge[];
}

/** P03: 4×4 пол, стена в (1,1), закрытая дверь между (2,2)↔(3,2). */
export const P03_PROTOTYPE_ROOM: RoomPrototypeGeometry = Object.freeze({
  bounds: Object.freeze({ minGx: 0, minGy: 0, maxGx: 3, maxGy: 3 }),
  wallCells: Object.freeze([{ gx: 1, gy: 1 }]),
  doorEdges: Object.freeze([{ from: { gx: 2, gy: 2 }, to: { gx: 3, gy: 2 } }]),
});
