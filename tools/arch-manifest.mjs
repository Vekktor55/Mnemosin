#!/usr/bin/env node
/**
 * tools/arch-manifest.mjs — пересборка хэш-манифеста core/.
 *
 * Запускать ТОЛЬКО осознанно: манифест доказывает, что ядро не менялось при
 * добавлении провайдеров и модулей (критерии A1.14, A3.5). После пересборки
 * добавьте запись D* в docs/ARCHITECTURE.md с обоснованием изменения core/.
 *
 *   npm run arch:manifest
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(ROOT, 'tests/arch/core-manifest.json');

function listFiles(dir) {
  const abs = resolve(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry);
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(relative(ROOT, full));
    }
  };
  walk(abs);
  return out.sort();
}

const manifest = {};
for (const file of listFiles('core')) {
  manifest[file] = createHash('sha256')
    .update(readFileSync(resolve(ROOT, file), 'utf8'))
    .digest('hex');
}

writeFileSync(TARGET, JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(`core-manifest.json: ${Object.keys(manifest).length} файл(ов)\n`);
for (const [file, hash] of Object.entries(manifest)) process.stdout.write(`  ${hash.slice(0, 12)}  ${file}\n`);
