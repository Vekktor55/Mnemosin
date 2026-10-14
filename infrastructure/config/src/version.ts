import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Читает версию из package.json (для /health и /version, критерий A1.1). */
export function readPackageVersion(cwd: string = process.cwd()): string {
  try {
    const raw = readFileSync(resolve(cwd, 'package.json'), 'utf8') as string;
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0-unknown';
  } catch {
    return '0.0.0-unknown';
  }
}
