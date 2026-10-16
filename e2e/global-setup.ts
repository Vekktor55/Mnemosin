import { execSync } from 'node:child_process';
import { readdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Global setup (промпт 1.12, п.8):
 *  1. tsc -b (весь монорепо) — сервер для e2e запускается из dist (лёгкий node,
 *     без tsx-транспиляции: экономия памяти в CI-песочницах);
 *  2. vite build клиента — сервер отдаёт client/dist статикой (каркас 1.1);
 *  3. чистка БД прошлых e2e-прогонов (D108: одна активная сессия на сервер).
 */
export default async function globalSetup(): Promise<void> {
  const root = path.resolve(import.meta.dirname, '..');
  execSync('npm run build', { cwd: root, stdio: 'inherit' });
  execSync('npm run build -w client', { cwd: root, stdio: 'inherit' });
  const dataDir = path.join(root, 'data');
  if (existsSync(dataDir)) {
    for (const file of readdirSync(dataDir)) {
      if (file.startsWith('e2e-')) rmSync(path.join(dataDir, file), { force: true });
    }
  }
}
