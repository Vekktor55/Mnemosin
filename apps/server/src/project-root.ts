import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Корень монорепо: .env, config/ и data/ относительны к нему.
 *
 * Нужен отдельный резолвер, потому что `npm run dev --workspace @mnemosin/server`
 * меняет cwd на каталог пакета, и dotenv/config тогда не находятся.
 * Порядок: MNEMOSIN_HOME → поиск ближайшего предка с package.json { name: 'mnemosin' } → cwd.
 */
export function resolveProjectRoot(start: string = process.cwd()): string {
  const explicit = process.env['MNEMOSIN_HOME'];
  if (typeof explicit === 'string' && explicit.length > 0) return resolve(explicit);

  let dir = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    const pkgPath = resolve(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown };
        if (parsed.name === 'mnemosin') return dir;
      } catch {
        // битый package.json — продолжаем поиск вверх
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(start);
}
