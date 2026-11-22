/**
 * GridProjection — чистая изометрическая проекция grid → screen (WORLD_SIMULATION.md §4.4).
 *
 * Независимый от PixiJS Container transforms модуль. Сервер этот модуль не
 * импортирует (dependency-cruiser + arch-тест «клиент импортирует только
 * контракты»). Конвенция G2: клетка (gx, gy) занимает [gx, gx+1) × [gy, gy+1),
 * центр — (gx+0.5, gy+0.5); координаты непрерывны, клетка = floor(x), floor(y).
 */

export interface GridProjectionConfig {
  /** Полуширина ромба тайла в пикселях (по X). */
  readonly halfTileWidth: number;
  /** Полувысота ромба тайла в пикселях (по Y). */
  readonly halfTileHeight: number;
  /** Экранная точка, куда проецируется мировое начало (0,0). */
  readonly originX: number;
  readonly originY: number;
  /** Смещение по Y за единицу elevation (presentation-only). */
  readonly elevationStep: number;
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface WorldPoint {
  readonly x: number;
  readonly y: number;
}

export interface GridCell {
  readonly gx: number;
  readonly gy: number;
}

/**
 * Ключ сортировки по глубине — foot point / ground anchor (WORLD_SIMULATION.md §4.5):
 * worldX + worldY. Высота спрайта не влияет на порядок относительно пола.
 */
export function depthKey(position: WorldPoint): number {
  return position.x + position.y;
}

export class GridProjection {
  readonly config: GridProjectionConfig;

  constructor(config: GridProjectionConfig) {
    this.config = Object.freeze({ ...config });
  }

  /**
   * Прямая проекция (WORLD_SIMULATION.md §4.4):
   *   screenX = originX + (worldX - worldY) * halfTileWidth
   *   screenY = originY + (worldX + worldY) * halfTileHeight - elevation * elevationStep
   */
  worldToScreen(position: WorldPoint, elevation = 0): ScreenPoint {
    const c = this.config;
    return {
      x: c.originX + (position.x - position.y) * c.halfTileWidth,
      y: c.originY + (position.x + position.y) * c.halfTileHeight - elevation * c.elevationStep,
    };
  }

  /** Обратное преобразование на плоскости пола (elevation = 0) для hit testing. */
  screenToWorld(point: ScreenPoint): WorldPoint {
    const c = this.config;
    const u = (point.x - c.originX) / c.halfTileWidth;
    const v = (point.y - c.originY) / c.halfTileHeight;
    return { x: (u + v) / 2, y: (v - u) / 2 };
  }

  /** Anchor клетки — её центр (gx+0.5, gy+0.5) → экранная точка. */
  cellToAnchor(gx: number, gy: number): ScreenPoint {
    return this.worldToScreen({ x: gx + 0.5, y: gy + 0.5 });
  }

  /** Указатель → потенциальная клетка (floor по G2). */
  pointerToCell(point: ScreenPoint): GridCell {
    const world = this.screenToWorld(point);
    return { gx: Math.floor(world.x), gy: Math.floor(world.y) };
  }
}
