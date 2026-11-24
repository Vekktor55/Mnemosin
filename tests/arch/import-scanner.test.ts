import { describe, expect, it } from 'vitest';

import { importsFromSource } from './helpers.js';

describe('Статический сканер импортов', () => {
  it('не принимает JSON-поле from за re-export', () => {
    const source = `
      export const BLENDER_ROOM = {
        "bounds": { "minGx": 0 },
        "doorEdges": [{ "from": { "gx": 2 }, "to": { "gx": 3 } }],
        "image": "/rooms/blender-room.png"
      } as const;
    `;

    expect(importsFromSource(source)).toEqual([]);
  });

  it('сохраняет все поддерживаемые формы реальных импортов', () => {
    const source = `
      import type { Contract } from '@mnemosin/contracts';
      import {
        Container,
        Graphics,
      } from 'pixi.js';
      import './side-effect.js';
      export { GridProjection } from './projection.js';
      export type { WorldPoint } from './types.js';
      const dynamic = import('dynamic-package');
      const legacy = require('legacy-package');
      import importedEquals = require('import-equals-package');
    `;

    expect(importsFromSource(source)).toEqual([
      '@mnemosin/contracts',
      'pixi.js',
      './side-effect.js',
      './projection.js',
      './types.js',
      'dynamic-package',
      'legacy-package',
      'import-equals-package',
    ]);
  });

  it('игнорирует import-like текст в комментариях и строках', () => {
    const source = `
      // import fake from 'comment-package';
      /* export { fake } from 'block-comment-package'; */
      const example = "import('string-package')";
      export const answer = 42;
    `;

    expect(importsFromSource(source)).toEqual([]);
  });
});
