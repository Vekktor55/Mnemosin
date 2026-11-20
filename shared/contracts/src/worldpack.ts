import { z } from 'zod';
import { FloorId, ObjectId, WorldId, WorldSpaceId } from './ids.js';
import { GridCellSchema, WorldPositionSchema } from './transport/spatial.js';

/**
 * World Pack — версионируемый набор пространственных игровых данных (P03,
 * WORLD_SIMULATION.md §3.2). Описывает серверную геометрию этажа независимо
 * от клиентского рендера (PixiJS) и PNG-ресурсов.
 *
 * Координатная конвенция — G2 (WORLD_SIMULATION.md §2.3):
 *  - клетка (gx, gy) занимает [gx, gx+1) × [gy, gy+1);
 *  - центр клетки — (gx+0.5, gy+0.5);
 *  - мировая позиция непрерывна, допускаются дробные значения;
 *  - клетка определяется floor(x), floor(y);
 *  - дополнительной квантизации нет.
 *
 * World Pack описывает СТАТИЧЕСКИЕ данные. `WorldEpoch` (ids.ts) описывает
 * поколение активного пространственного состояния и сюда НЕ входит: он меняется
 * только при реальном переходе/сбросе пространственного мира.
 */

/** Манифест: идентичность, версии и границы координатной области. */
export const WorldPackManifestSchema = z.object({
  /** Идентификатор pack'а (человекочитаемый, стабильный в пределах контента). */
  packId: z.string().min(1).max(60),
  /** Версия формата/схемы pack'а. */
  schemaVersion: z.number().int().nonnegative(),
  /** Версия содержимого и формата World Pack (НЕ WorldEpoch). */
  contentVersion: z.string().min(1).max(20),
  worldId: WorldId,
  floorId: FloorId,
  worldSpaceId: WorldSpaceId,
  /** Целочисленные границы клеток (включительно): допустимые gx/gy. */
  bounds: z.object({
    minGx: z.number().int(),
    minGy: z.number().int(),
    maxGx: z.number().int(),
    maxGy: z.number().int(),
  }),
  /** SHA-256 контента (hex, 64 символа) — опционально для целостности. */
  contentHash: z.string().length(64).optional(),
});
export type WorldPackManifest = z.infer<typeof WorldPackManifestSchema>;

/** Клетка сетки: проходимость и свойства площади (WORLD_SIMULATION.md §3.4). */
export const WorldPackCellSchema = z.object({
  gx: z.number().int(),
  gy: z.number().int(),
  walkable: z.boolean(),
  /** Блокирует ли площадь клетки обзор (по умолчанию false). */
  blocksVision: z.boolean().optional(),
  /** Тип поверхности (например `floor`, `wall`, `void`) — контентный тег. */
  terrain: z.string().min(1).max(40).optional(),
});
export type WorldPackCell = z.infer<typeof WorldPackCellSchema>;

/**
 * Граница между двумя СОСЕДНИМИ клетками (стена/проход).
 * `blocksMovement` — независимое от `blocksVision` свойство (WORLD_SIMULATION.md §3.5).
 */
export const WorldPackEdgeSchema = z.object({
  from: GridCellSchema,
  to: GridCellSchema,
  blocksMovement: z.boolean(),
  /** Блокирует ли граница обзор (по умолчанию false). */
  blocksVision: z.boolean().optional(),
  /** Если граница является дверью/проходом — ссылка на portal. */
  portalId: z.string().min(1).max(60).optional(),
});
export type WorldPackEdge = z.infer<typeof WorldPackEdgeSchema>;

/** Дверь или проход между двумя соседними клетками (WORLD_SIMULATION.md §3.4). */
export const WorldPackPortalSchema = z.object({
  portalId: z.string().min(1).max(60),
  kind: z.enum(['door', 'passage']),
  cells: z.tuple([GridCellSchema, GridCellSchema]),
  /** Ссылка на объект, представляющий дверь/механизм (если есть). */
  stateObjectId: ObjectId.optional(),
  /** Начальное состояние (по умолчанию для `passage` — открыто). */
  initialState: z.enum(['open', 'closed', 'locked']).optional(),
});
export type WorldPackPortal = z.infer<typeof WorldPackPortalSchema>;

/** Точка появления: непрерывная мировая позиция (G2) в пределах пространства. */
export const WorldPackSpawnPointSchema = z.object({
  spawnPointId: z.string().min(1).max(60),
  position: WorldPositionSchema,
  /** Человекочитаемая метка (например `player-1`, `gm`). */
  label: z.string().min(1).max(60).optional(),
});
export type WorldPackSpawnPoint = z.infer<typeof WorldPackSpawnPointSchema>;

/** Ссылка на объект мира (двери, станции и т.п.) с опциональной позицией. */
export const WorldPackObjectRefSchema = z.object({
  objectId: ObjectId,
  position: WorldPositionSchema.optional(),
});
export type WorldPackObjectRef = z.infer<typeof WorldPackObjectRefSchema>;

/**
 * Пространственный World Pack v4 (геометрия + проходимость + спавны + ссылки).
 * Отличается от легаси `WorldPackSchema` из `domain/location.ts` (нарративный
 * slug-пак локаций): здесь — серверная геометрия, независимая от клиента.
 */
export const SpatialWorldPackSchema = z.object({
  manifest: WorldPackManifestSchema,
  cells: z.array(WorldPackCellSchema).min(1),
  /** Стены/проходы между соседними клетками. */
  edges: z.array(WorldPackEdgeSchema).default([]),
  /** Двери и проходы. */
  portals: z.array(WorldPackPortalSchema).default([]),
  /** Точки появления игроков/кукол/сущностей. */
  spawnPoints: z.array(WorldPackSpawnPointSchema).min(1),
  /** Ссылки на объекты мира. */
  objects: z.array(WorldPackObjectRefSchema).default([]),
});
export type SpatialWorldPack = z.infer<typeof SpatialWorldPackSchema>;
