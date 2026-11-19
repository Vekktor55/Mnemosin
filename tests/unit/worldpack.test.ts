import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SpatialWorldPackSchema, type SpatialWorldPack } from '@mnemosin/contracts';
import { parseWorldPack, validateWorldPack, WorldPackValidationError } from '@mnemosin/core';

/**
 * P03: World Pack loader + validator (WORLD_SIMULATION.md §3.6).
 * Проверка загрузки тестовой комнаты без PixiJS и без браузера.
 */

const fixture = readFileSync(join(process.cwd(), 'tests/fixtures/worldpack.v4.test.json'), 'utf8');

function loadFixture(): SpatialWorldPack {
  return parseWorldPack(fixture);
}

function expectValidationError(input: unknown, needle?: string): WorldPackValidationError {
  try {
    validateWorldPack(input);
  } catch (err) {
    if (err instanceof WorldPackValidationError) {
      if (needle) {
        expect(err.issues.map((i) => i.message).join('\n')).toContain(needle);
      }
      return err;
    }
    throw err;
  }
  throw new Error('ожидалась WorldPackValidationError');
}

describe('World Pack loader (P03)', () => {
  it('успешно загружает тестовую комнату', () => {
    const pack = loadFixture();
    expect(pack.manifest.packId).toBe('mnemosin-test-room');
    expect(pack.cells).toHaveLength(16);
    expect(pack.portals).toHaveLength(1);
    expect(pack.spawnPoints).toHaveLength(2);
  });

  it('Zod-схема принимает валидный pack и round-trip через JSON', () => {
    const pack = loadFixture();
    const roundTripped = SpatialWorldPackSchema.parse(JSON.parse(JSON.stringify(pack)));
    expect(roundTripped.manifest.packId).toBe(pack.manifest.packId);
  });

  it('некорректный JSON отклоняется с понятной ошибкой', () => {
    expect(() => parseWorldPack('{ не json')).toThrow(WorldPackValidationError);
  });

  it('неизвестный формат (не объект) отклоняется', () => {
    expectValidationError(null);
    expectValidationError('строка');
    expectValidationError(42);
  });
});

describe('World Pack validator: границы карты', () => {
  it('клетка вне bounds отклоняется', () => {
    const pack = loadFixture();
    const bad = { ...pack, cells: [...pack.cells, { gx: 99, gy: 0, walkable: true }] };
    expectValidationError(bad, 'вне bounds');
  });

  it('spawn-позиция вне bounds отклоняется', () => {
    const pack = loadFixture();
    const bad = {
      ...pack,
      spawnPoints: [...pack.spawnPoints, { spawnPointId: 'bad', position: { x: 99, y: 99 } }],
    };
    expectValidationError(bad, 'вне bounds');
  });

  it('bounds с max < min отклоняется', () => {
    const pack = loadFixture();
    const bad = {
      ...pack,
      manifest: { ...pack.manifest, bounds: { minGx: 5, minGy: 0, maxGx: 0, maxGy: 3 } },
    };
    expectValidationError(bad, 'maxGx/maxGy');
  });
});

describe('World Pack validator: ссылочная целостность', () => {
  it('ребро ссылается на отсутствующую клетку', () => {
    const pack = loadFixture();
    const bad = {
      ...pack,
      edges: [...pack.edges, { from: { gx: 99, gy: 0 }, to: { gx: 99, gy: 1 }, blocksMovement: false }],
    };
    expectValidationError(bad, 'отсутствующую клетку');
  });

  it('ребро ссылается на несуществующий portalId', () => {
    const pack = loadFixture();
    const bad = {
      ...pack,
      edges: [...pack.edges, { from: { gx: 0, gy: 1 }, to: { gx: 0, gy: 2 }, blocksMovement: true, portalId: 'nope' }],
    };
    expectValidationError(bad, 'несуществующий portalId');
  });

  it('портал ссылается на отсутствующую клетку', () => {
    const pack = loadFixture();
    const bad = {
      ...pack,
      portals: [
        ...pack.portals,
        {
          portalId: 'bad-portal',
          kind: 'door' as const,
          cells: [
            { gx: 99, gy: 0 },
            { gx: 99, gy: 1 },
          ],
        },
      ],
    };
    expectValidationError(bad, 'отсутствующую клетку');
  });

  it('портал с несоседними клетками отклоняется', () => {
    const pack = loadFixture();
    const bad = {
      ...pack,
      portals: [
        ...pack.portals,
        {
          portalId: 'bad-portal',
          kind: 'door' as const,
          cells: [
            { gx: 0, gy: 0 },
            { gx: 2, gy: 2 },
          ],
        },
      ],
    };
    expectValidationError(bad, 'не соседние');
  });
});

describe('World Pack validator: spawn points', () => {
  it('spawn на непроходимой клетке отклоняется', () => {
    const pack = loadFixture();
    // Клетка (1,1) — непроходимая стена.
    const bad = {
      ...pack,
      spawnPoints: [...pack.spawnPoints, { spawnPointId: 'bad', position: { x: 1.5, y: 1.5 } }],
    };
    expectValidationError(bad, 'непроходимую клетку');
  });

  it('spawn попадает в отсутствующую клетку', () => {
    const pack = loadFixture();
    // player-2 находится в (3.5, 0.5) → клетка (3, 0). Удаляем её.
    const bad = { ...pack, cells: pack.cells.filter((c) => !(c.gx === 3 && c.gy === 0)) };
    expectValidationError(bad, 'отсутствующую клетку');
  });

  it('дробные координаты spawn допустимы (G2)', () => {
    const pack = loadFixture();
    expect(pack.spawnPoints[0]?.position.x).toBe(0.5);
    expect(pack.spawnPoints[0]?.position.y).toBe(2.5);
  });
});

describe('World Pack validator: дубликаты', () => {
  it('дублирующиеся клетки отклоняются', () => {
    const pack = loadFixture();
    const bad = { ...pack, cells: [...pack.cells, { gx: 0, gy: 0, walkable: true }] };
    expectValidationError(bad, 'дублирует');
  });

  it('дублирующиеся portalId отклоняются', () => {
    const pack = loadFixture();
    const bad = {
      ...pack,
      portals: [
        ...pack.portals,
        {
          portalId: 'door-east',
          kind: 'door' as const,
          cells: [
            { gx: 0, gy: 1 },
            { gx: 0, gy: 2 },
          ],
        },
      ],
    };
    expectValidationError(bad, 'дублирующий portalId');
  });

  it('дублирующиеся spawnPointId отклоняются', () => {
    const pack = loadFixture();
    const bad = {
      ...pack,
      spawnPoints: [...pack.spawnPoints, { spawnPointId: 'player-1', position: { x: 2.5, y: 0.5 } }],
    };
    expectValidationError(bad, 'дублирующий spawnPointId');
  });
});

describe('World Pack: координатная конвенция G2', () => {
  it('клетка (gx, gy) содержит позицию floor(x), floor(y)', () => {
    const pack = loadFixture();
    const cell = pack.cells.find((c) => c.gx === 3 && c.gy === 0);
    expect(cell?.walkable).toBe(true);
    // spawn player-2 в (3.5, 0.5) попадает в клетку (3, 0)
    expect(Math.floor(3.5)).toBe(3);
    expect(Math.floor(0.5)).toBe(0);
  });

  it('центр клетки — (gx+0.5, gy+0.5)', () => {
    const pack = loadFixture();
    // Клетка (2,2) — проходимая; центр (2.5, 2.5) совпадает с позицией двери.
    const door = pack.objects.find((o) => o.position !== undefined);
    expect(door?.position).toEqual({ x: 2.5, y: 2.5 });
  });
});
