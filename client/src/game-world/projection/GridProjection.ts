/**
 * GridProjection — фронтальная ортографическая 3/4 проекция grid → screen
 * (top-down oblique, yaw = 0°, наклон только по вертикали; WORLD_SIMULATION.md §4.4).
 *
 * Изометрическая ромбическая проекция (поворот на 45° по yaw) НЕ используется.
 * Независимый от PixiJS Container transforms модуль. Сервер этот модуль не
 * импортирует (dependency-cruiser + arch-тест «клиент импортирует только
 * контракты»). Конвенция G2: клетка (gx, gy) занимает [gx, gx+1) × [gy, gy+1),
 * центр — (gx+0.5, gy+0.5); координаты непрерывны, клетка = floor(x), floor(y).
 */

export interface GridProjectionConfig {
  /** Ширина тайла по горизонтали (worldX → screenX). */
  readonly tileWidth: number;
  /** Глубина тайла по вертикали (worldY → screenY), т.е. высота строки пола. */
  readonly tileDepth: number;
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
 * при yaw = 0° ближе к камере объекты с большим worldY.
 */
export function depthKey(position: WorldPoint): number {
  return position.y;
}

/** Стабильный tie-breaker для объектов на одной глубине (одинаковое worldY). */
export function depthTieBreak(position: WorldPoint): number {
  return position.x;
}

export class GridProjection {
  readonly config: GridProjectionConfig;

  constructor(config: GridProjectionConfig) {
    this.config = Object.freeze({ ...config });
  }

  /**
   * Прямая проекция (WORLD_SIMULATION.md §4.4):
   *   screenX = originX + worldX * tileWidth
   *   screenY = originY + worldY * tileDepth - elevation * elevationStep
   */
  worldToScreen(position: WorldPoint, elevation = 0): ScreenPoint {
    const c = this.config;
    return {
      x: c.originX + position.x * c.tileWidth,
      y: c.originY + position.y * c.tileDepth - elevation * c.elevationStep,
    };
  }

  /** Обратное преобразование на плоскости пола (elevation = 0) для hit testing. */
  screenToWorld(point: ScreenPoint): WorldPoint {
    const c = this.config;
    return {
      x: (point.x - c.originX) / c.tileWidth,
      y: (point.y - c.originY) / c.tileDepth,
    };
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
