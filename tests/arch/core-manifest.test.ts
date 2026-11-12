import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { manifestOf, ROOT } from './helpers.js';

/**
 * Хэш-манифест `core/` — механическая гарантия инвариантов 1–3 и 9
 * (критерии A1.14, A3.5): добавление провайдера, модуля или контента
 * НЕ меняет ядро.
 *
 * Если тест упал, значит файлы core/ изменились. Это допустимо только как
 * осознанное решение: обновите манифест (`npm run arch:manifest`) и добавьте
 * запись D* в docs/ARCHITECTURE.md с обоснованием «почему это нельзя было
 * сделать модулем или адаптером».
 */

const MANIFEST_PATH = resolve(ROOT, 'tests/arch/core-manifest.json');

function readManifest(): Record<string, string> {
  if (!existsSync(MANIFEST_PATH)) return {};
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Record<string, string>;
}

describe('Манифест core/ (A1.14, A3.5)', () => {
  it('файлы core/ не изменились относительно зафиксированного манифеста', () => {
    const actual = manifestOf('core');
    const expected = readManifest();

    const added = Object.keys(actual).filter((file) => !(file in expected));
    const removed = Object.keys(expected).filter((file) => !(file in actual));
    const changed = Object.keys(actual).filter((file) => file in expected && actual[file] !== expected[file]);

    const report = [
      added.length > 0 ? `добавлены: ${added.join(', ')}` : '',
      removed.length > 0 ? `удалены: ${removed.join(', ')}` : '',
      changed.length > 0 ? `изменены: ${changed.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    expect(
      { added, removed, changed },
      `core/ изменён — требуется осознанное решение D* и npm run arch:manifest:\n${report}`,
    ).toEqual({ added: [], removed: [], changed: [] });
  });

  it('манифест покрывает все файлы core/ (нет незамеченных)', () => {
    const actual = manifestOf('core');
    const expected = readManifest();
    expect(Object.keys(expected).sort()).toEqual(Object.keys(actual).sort());
  });
});
