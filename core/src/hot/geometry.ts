import type { GridCell, SpatialWorldPack, WorldPackPortal, WorldPosition } from '@mnemosin/contracts';

export type HotPortalState = 'open' | 'closed' | 'locked';

export interface HotCollisionSegment {
  readonly id: string;
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
}

export interface HotWorldGeometry {
  readonly bounds: SpatialWorldPack['manifest']['bounds'];
  readonly walkableCells: ReadonlySet<string>;
  /** Стабильно отсортированные отрезки; circle sweep строится против их capsule. */
  readonly segments: readonly HotCollisionSegment[];
}

export interface HotGeometryOptions {
  /** Начальная runtime-проекция; никаких COLD transitions этот модуль не выполняет. */
  readonly portalStates?: ReadonlyMap<string, HotPortalState>;
}

function cellKey(cell: Pick<GridCell, 'gx' | 'gy'>): string;
function cellKey(gx: number, gy: number): string;
function cellKey(cellOrGx: Pick<GridCell, 'gx' | 'gy'> | number, gy?: number): string {
  return typeof cellOrGx === 'number' ? `${cellOrGx},${String(gy)}` : `${cellOrGx.gx},${cellOrGx.gy}`;
}

function compareCells(a: GridCell, b: GridCell): number {
  return a.gy - b.gy || a.gx - b.gx;
}

function orderedCells(a: GridCell, b: GridCell): readonly [GridCell, GridCell] {
  return compareCells(a, b) <= 0 ? [a, b] : [b, a];
}

function boundaryBetween(a: GridCell, b: GridCell): Omit<HotCollisionSegment, 'id'> {
  if (a.gx === b.gx && Math.abs(a.gy - b.gy) === 1) {
    const y = Math.max(a.gy, b.gy);
    return { ax: a.gx, ay: y, bx: a.gx + 1, by: y };
  }
  if (a.gy === b.gy && Math.abs(a.gx - b.gx) === 1) {
    const x = Math.max(a.gx, b.gx);
    return { ax: x, ay: a.gy, bx: x, by: a.gy + 1 };
  }
  throw new Error(`HOT geometry: клетки (${cellKey(a)}) и (${cellKey(b)}) не являются соседями`);
}

function resolvePortalState(portal: WorldPackPortal, options: HotGeometryOptions): HotPortalState {
  const override = options.portalStates?.get(portal.portalId);
  if (override !== undefined) return override;
  if (portal.initialState !== undefined) return portal.initialState;
  if (portal.kind === 'passage') return 'open';
  throw new Error(
    `HOT geometry: door «${portal.portalId}» не имеет initialState; передайте начальное runtime-состояние явно`,
  );
}

/**
 * Компилирует server-side World Pack в неизменяемый набор collision queries.
 * Отсутствующие/непроходимые клетки — solid; внешняя граница bounds — solid.
 * Состояние portal заменяет статический флаг связанного edge: open открывает проход,
 * closed/locked блокирует его. Портал без edge также блокирует свою пару клеток.
 */
export function compileHotWorldGeometry(pack: SpatialWorldPack, options: HotGeometryOptions = {}): HotWorldGeometry {
  const bounds = pack.manifest.bounds;
  const walkableCells = new Set(pack.cells.filter((cell) => cell.walkable).map((cell) => cellKey(cell.gx, cell.gy)));
  const segments = new Map<string, HotCollisionSegment>();

  const addSegment = (segment: Omit<HotCollisionSegment, 'id'>): void => {
    const forward = `${segment.ax},${segment.ay}`;
    const backward = `${segment.bx},${segment.by}`;
    const id = forward < backward ? `${forward}|${backward}` : `${backward}|${forward}`;
    segments.set(id, { id, ...segment });
  };
  const addCellBoundary = (gx: number, gy: number): void => {
    addSegment({ ax: gx, ay: gy, bx: gx + 1, by: gy });
    addSegment({ ax: gx + 1, ay: gy, bx: gx + 1, by: gy + 1 });
    addSegment({ ax: gx + 1, ay: gy + 1, bx: gx, by: gy + 1 });
    addSegment({ ax: gx, ay: gy + 1, bx: gx, by: gy });
  };

  for (let gy = bounds.minGy; gy <= bounds.maxGy; gy += 1) {
    for (let gx = bounds.minGx; gx <= bounds.maxGx; gx += 1) {
      if (!walkableCells.has(cellKey(gx, gy))) addCellBoundary(gx, gy);
    }
  }

  addSegment({ ax: bounds.minGx, ay: bounds.minGy, bx: bounds.maxGx + 1, by: bounds.minGy });
  addSegment({
    ax: bounds.maxGx + 1,
    ay: bounds.minGy,
    bx: bounds.maxGx + 1,
    by: bounds.maxGy + 1,
  });
  addSegment({
    ax: bounds.maxGx + 1,
    ay: bounds.maxGy + 1,
    bx: bounds.minGx,
    by: bounds.maxGy + 1,
  });
  addSegment({ ax: bounds.minGx, ay: bounds.maxGy + 1, bx: bounds.minGx, by: bounds.minGy });

  const portalStates = new Map<string, HotPortalState>();
  for (const portal of [...pack.portals].sort((a, b) => a.portalId.localeCompare(b.portalId))) {
    portalStates.set(portal.portalId, resolvePortalState(portal, options));
  }

  const referencedPortals = new Set<string>();
  const edges = [...pack.edges].sort((a, b) => {
    const [aa, ab] = orderedCells(a.from, a.to);
    const [ba, bb] = orderedCells(b.from, b.to);
    return cellKey(aa).localeCompare(cellKey(ba)) || cellKey(ab).localeCompare(cellKey(bb));
  });
  for (const edge of edges) {
    if (edge.portalId !== undefined) {
      referencedPortals.add(edge.portalId);
      const state = portalStates.get(edge.portalId);
      if (state === undefined) throw new Error(`HOT geometry: неизвестный portal «${edge.portalId}»`);
      if (state !== 'open') addSegment(boundaryBetween(edge.from, edge.to));
    } else if (edge.blocksMovement) {
      addSegment(boundaryBetween(edge.from, edge.to));
    }
  }

  for (const portal of pack.portals) {
    if (!referencedPortals.has(portal.portalId) && portalStates.get(portal.portalId) !== 'open') {
      addSegment(boundaryBetween(portal.cells[0], portal.cells[1]));
    }
  }

  return {
    bounds: { ...bounds },
    walkableCells,
    segments: [...segments.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function distanceSquaredToSegment(position: WorldPosition, segment: HotCollisionSegment): number {
  const sx = segment.bx - segment.ax;
  const sy = segment.by - segment.ay;
  const lengthSquared = sx * sx + sy * sy;
  const projection =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((position.x - segment.ax) * sx + (position.y - segment.ay) * sy) / lengthSquared));
  const dx = position.x - (segment.ax + sx * projection);
  const dy = position.y - (segment.ay + sy * projection);
  return dx * dx + dy * dy;
}

/** Проверка начальной runtime-проекции; касание препятствия допустимо. */
export function isCirclePositionFree(
  position: WorldPosition,
  radius: number,
  epsilon: number,
  geometry: HotWorldGeometry,
): boolean {
  const { bounds } = geometry;
  if (
    position.x < bounds.minGx ||
    position.x >= bounds.maxGx + 1 ||
    position.y < bounds.minGy ||
    position.y >= bounds.maxGy + 1 ||
    !geometry.walkableCells.has(cellKey(Math.floor(position.x), Math.floor(position.y)))
  ) {
    return false;
  }
  const allowedDistance = Math.max(0, radius - epsilon);
  const allowedSquared = allowedDistance * allowedDistance;
  return geometry.segments.every((segment) => distanceSquaredToSegment(position, segment) >= allowedSquared);
}
