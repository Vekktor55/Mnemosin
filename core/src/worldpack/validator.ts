import { SpatialWorldPackSchema, type SpatialWorldPack } from '@mnemosin/contracts';

/**
 * Валидатор World Pack (P03, WORLD_SIMULATION.md §3.6).
 *
 * Двухступенчатая проверка:
 *  1. Zod-схема (структура, типы, границы значений);
 *  2. Перекрёстная целостность (дубли ID, ссылки на отсутствующие сущности,
 *     координаты вне границ, некорректная геометрия, недопустимые spawn points).
 *
 * Валидатор собирает ВСЕ ошибки (а не падает на первой) и возвращает их списком,
 * чтобы автор карты видел полную картину за один прогон.
 */

export interface WorldPackIssue {
  /** Локатор проблемной сущности в pack'е (например `cells[3]`, `portals[0]`). */
  readonly path: string;
  readonly message: string;
}

export class WorldPackValidationError extends Error {
  readonly issues: readonly WorldPackIssue[];

  constructor(issues: readonly WorldPackIssue[]) {
    super(`World Pack не прошёл валидацию: ${issues.length} ошибок`);
    this.name = 'WorldPackValidationError';
    this.issues = issues;
  }
}

function cellKey(gx: number, gy: number): string {
  return `${gx},${gy}`;
}

/** true, если две клетки — соседи по ортогонали (манхэттенское расстояние 1). */
function isAdjacent(a: { gx: number; gy: number }, b: { gx: number; gy: number }): boolean {
  return Math.abs(a.gx - b.gx) + Math.abs(a.gy - b.gy) === 1;
}

/** Проходит ли позиция по границам клеточной области `[minGx, maxGx+1) × [minGy, maxGy+1)`. */
function inBounds(
  pos: { x: number; y: number },
  b: { minGx: number; minGy: number; maxGx: number; maxGy: number },
): boolean {
  return pos.x >= b.minGx && pos.x < b.maxGx + 1 && pos.y >= b.minGy && pos.y < b.maxGy + 1;
}

export function validateWorldPack(input: unknown): SpatialWorldPack {
  const parsed = SpatialWorldPackSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
      message: issue.message,
    }));
    throw new WorldPackValidationError(issues);
  }

  const pack = parsed.data;
  const issues: WorldPackIssue[] = [];
  const b = pack.manifest.bounds;

  // --- manifest.bounds sanity ---
  if (b.maxGx < b.minGx || b.maxGy < b.minGy) {
    issues.push({ path: 'manifest.bounds', message: 'maxGx/maxGy должны быть ≥ minGx/minGy' });
  }

  // --- cells: дубли и границы ---
  const seenCells = new Map<string, number>();
  pack.cells.forEach((cell, i) => {
    const key = cellKey(cell.gx, cell.gy);
    const prev = seenCells.get(key);
    if (prev !== undefined) {
      issues.push({ path: `cells[${i}]`, message: `клетка (${cell.gx},${cell.gy}) дублирует cells[${prev}]` });
    } else {
      seenCells.set(key, i);
    }
    if (cell.gx < b.minGx || cell.gx > b.maxGx || cell.gy < b.minGy || cell.gy > b.maxGy) {
      issues.push({ path: `cells[${i}]`, message: `клетка (${cell.gx},${cell.gy}) вне bounds` });
    }
  });

  const cellExists = (gx: number, gy: number): boolean => seenCells.has(cellKey(gx, gy));

  // --- portals: дубли ID и целостность ссылок ---
  const portalIds = new Set<string>();
  pack.portals.forEach((portal, i) => {
    const path = `portals[${i}]`;
    if (portalIds.has(portal.portalId)) {
      issues.push({ path, message: `дублирующий portalId «${portal.portalId}»` });
    }
    portalIds.add(portal.portalId);

    if (!isAdjacent(portal.cells[0], portal.cells[1])) {
      issues.push({
        path,
        message: `клетки портала не соседние: ${cellKey(portal.cells[0].gx, portal.cells[0].gy)} и ${cellKey(portal.cells[1].gx, portal.cells[1].gy)}`,
      });
    }
    for (const cell of portal.cells) {
      if (!cellExists(cell.gx, cell.gy)) {
        issues.push({ path, message: `портал ссылается на отсутствующую клетку (${cell.gx},${cell.gy})` });
      }
    }
  });

  // --- edges: соседство, ссылки на клетки и на порталы ---
  pack.edges.forEach((edge, i) => {
    const path = `edges[${i}]`;
    if (!isAdjacent(edge.from, edge.to)) {
      issues.push({
        path,
        message: `клетки ребра не соседние: ${cellKey(edge.from.gx, edge.from.gy)} и ${cellKey(edge.to.gx, edge.to.gy)}`,
      });
    }
    for (const cell of [edge.from, edge.to]) {
      if (!cellExists(cell.gx, cell.gy)) {
        issues.push({ path, message: `ребро ссылается на отсутствующую клетку (${cell.gx},${cell.gy})` });
      }
    }
    if (edge.portalId !== undefined && !portalIds.has(edge.portalId)) {
      issues.push({ path, message: `ребро ссылается на несуществующий portalId «${edge.portalId}»` });
    }
  });

  // --- spawn points: дубли ID, границы и проходимость ---
  const spawnIds = new Set<string>();
  pack.spawnPoints.forEach((spawn, i) => {
    const path = `spawnPoints[${i}]`;
    if (spawnIds.has(spawn.spawnPointId)) {
      issues.push({ path, message: `дублирующий spawnPointId «${spawn.spawnPointId}»` });
    }
    spawnIds.add(spawn.spawnPointId);

    if (!inBounds(spawn.position, b)) {
      issues.push({
        path,
        message: `spawn-позиция (${spawn.position.x},${spawn.position.y}) вне bounds`,
      });
    } else {
      const gx = Math.floor(spawn.position.x);
      const gy = Math.floor(spawn.position.y);
      const cell = pack.cells.find((c) => c.gx === gx && c.gy === gy);
      if (!cell) {
        issues.push({ path, message: `spawn-позиция попадает в отсутствующую клетку (${gx},${gy})` });
      } else if (!cell.walkable) {
        issues.push({ path, message: `spawn-позиция попадает в непроходимую клетку (${gx},${gy})` });
      }
    }
  });

  // --- objects: дубли ID и границы позиции ---
  const objectIds = new Set<string>();
  pack.objects.forEach((ref, i) => {
    const path = `objects[${i}]`;
    if (objectIds.has(ref.objectId)) {
      issues.push({ path, message: `дублирующий objectId «${ref.objectId}»` });
    }
    objectIds.add(ref.objectId);
    if (ref.position !== undefined && !inBounds(ref.position, b)) {
      issues.push({ path, message: `позиция объекта вне bounds` });
    }
  });

  if (issues.length > 0) {
    throw new WorldPackValidationError(issues);
  }
  return pack;
}
