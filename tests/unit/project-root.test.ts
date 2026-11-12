import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

import { resolveProjectRoot } from '@mnemosin/server';

/**
 * Регрессия на баг, найденный при выполнении промпта 1.1:
 * `npm run dev --workspace @mnemosin/server` меняет cwd на каталог пакета,
 * из-за чего .env и config/ не находились и процесс падал с CONFIG_INVALID.
 */

const ROOT = process.cwd();

describe('resolveProjectRoot', () => {
  it('находит корень монорепо из корня', () => {
    expect(resolveProjectRoot(ROOT)).toBe(resolve(ROOT));
  });

  it('находит корень из каталога пакета (npm run dev -w …)', () => {
    expect(resolveProjectRoot(resolve(ROOT, 'apps/server'))).toBe(resolve(ROOT));
  });

  it('находит корень из глубоко вложенного каталога', () => {
    expect(resolveProjectRoot(resolve(ROOT, 'infrastructure/config/src'))).toBe(resolve(ROOT));
  });

  it('MNEMOSIN_HOME имеет приоритет', () => {
    const previous = process.env['MNEMOSIN_HOME'];
    process.env['MNEMOSIN_HOME'] = '/tmp/explicit-home';
    try {
      expect(resolveProjectRoot(resolve(ROOT, 'apps/server'))).toBe('/tmp/explicit-home');
    } finally {
      if (previous === undefined) delete process.env['MNEMOSIN_HOME'];
      else process.env['MNEMOSIN_HOME'] = previous;
    }
  });

  it('из каталога вне проекта возвращает стартовый путь (не падает)', () => {
    expect(resolveProjectRoot('/tmp')).toBe('/tmp');
  });
});
