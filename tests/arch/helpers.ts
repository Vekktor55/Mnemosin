import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';

/**
 * Хелперы architecture-тестов (промпт 1.3, критерии A1.2 и A1.14).
 *
 * Статический сканер импортов дублирует dependency-cruiser намеренно:
 * cruiser проверяет граф по факту существующих файлов, а сканер — ещё и
 * правила в CI без установки/настройки инструмента (v3 §IX.6).
 */

export const ROOT = process.cwd();

export function listSourceFiles(dir: string, exts = ['.ts']): string[] {
  const abs = resolve(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (exts.some((ext) => full.endsWith(ext)) && !full.endsWith('.d.ts')) out.push(relative(ROOT, full));
    }
  };
  walk(abs);
  return out.sort();
}

const IMPORT_PATTERNS = [
  /(?:^|\n)\s*import\s+(?:[\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*export\s+(?:[\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** Все спецификаторы импортов файла (включая `import type` и динамические). */
export function importsOf(file: string): string[] {
  const source = readFileSync(resolve(ROOT, file), 'utf8');
  const found = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1];
      if (specifier !== undefined) found.add(specifier);
    }
  }
  return [...found];
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Хэш-манифест каталога: файл → sha256 содержимого. Основа критерия A1.14. */
export function manifestOf(dir: string): Record<string, string> {
  const manifest: Record<string, string> = {};
  for (const file of listSourceFiles(dir)) {
    manifest[file] = sha256(readFileSync(resolve(ROOT, file), 'utf8'));
  }
  return manifest;
}

export type PackageName = string;

/**
 * Матрица разрешённых зависимостей (docs/ARCHITECTURE.md §3).
 * Ключ — glob-префикс каталога пакета, значение — что разрешено импортировать.
 *
 * `external` — разрешённые внешние пакеты (точные имена или префиксы с `*`).
 * `internal` — разрешённые пакеты монорепо.
 */
export interface LayerRule {
  readonly layer: string;
  readonly dirs: readonly string[];
  /** Разрешённые ИМПОРТЫ пакетов монорепо (может быть подпуть: `@mnemosin/core/domain/ports`). */
  readonly internal: readonly string[];
  readonly external: readonly string[];
  /**
   * Разрешённые tsconfig project references. Project reference всегда указывает
   * на пакет ЦЕЛИКОМ, поэтому список шире `internal`: инфраструктуре разрешено
   * сослаться на `core`, но импортировать она может только `core/domain/ports`.
   */
  readonly refs?: readonly string[];
  readonly forbiddenNote: string;
}

export const LAYER_RULES: readonly LayerRule[] = [
  {
    layer: 'contracts-leaf',
    dirs: ['shared/contracts'],
    internal: [],
    external: ['zod', 'node:crypto'],
    forbiddenNote: 'contracts не зависит ни от кого (кроме zod и node:crypto)',
  },
  {
    layer: 'core-no-infra',
    dirs: ['core'],
    internal: ['@mnemosin/contracts'],
    external: ['zod', 'node:crypto', 'node:util'],
    forbiddenNote:
      'core не импортирует infrastructure/modules/gateways/client и вендоров (fastify, drizzle-orm, better-sqlite3, pino, jose, SDK провайдеров) — инварианты 1–3',
  },
  {
    layer: 'modules',
    dirs: [
      'modules/session',
      'modules/turn',
      'modules/chat',
      'modules/story',
      'modules/gm',
      'modules/gm-review',
      'modules/gm-audit',
      'modules/ai-director',
      'modules/media-director',
      'modules/audio-director',
      'modules/inventory',
    ],
    internal: ['@mnemosin/contracts', '@mnemosin/core'],
    external: ['zod', 'node:crypto'],
    forbiddenNote:
      'модули не импортируют БД и не импортируют друг друга (D161) — wiring в apps/server; media-director не импортирует StateRepository (инвариант 8)',
  },
  {
    layer: 'infrastructure',
    dirs: [
      'infrastructure/config',
      'infrastructure/logging',
      'infrastructure/database',
      'infrastructure/ai',
      'infrastructure/storage',
      'infrastructure/media',
      'infrastructure/audio',
      'infrastructure/metrics',
      'infrastructure/jobs',
    ],
    // core — ТОЛЬКО через подпуть портов (промпт 1.4 его реализовал и экспортировал в core/package.json);
    // базовый '@mnemosin/core' по-прежнему запрещён: инфраструктура не должна тянуть домен целиком.
    internal: ['@mnemosin/contracts', '@mnemosin/core/domain/ports', '@mnemosin/config', '@mnemosin/logging'],
    refs: ['@mnemosin/contracts', '@mnemosin/core', '@mnemosin/config', '@mnemosin/logging'],
    external: [
      'zod',
      'dotenv',
      'yaml',
      'pino',
      'pino-pretty',
      'better-sqlite3',
      // D195: драйвер libsql вместо better-sqlite3 (в песочнице нет C-тулчейна,
      // а prebuild better-sqlite3@13 на Node 20 падает в SIGSEGV). Замена драйвера —
      // изменение client.ts и этой строки, схема и репозитории не трогаются.
      '@libsql/client',
      'drizzle-orm',
      'drizzle-orm/*',
      'jose',
      'prom-client',
      'node:crypto',
      'node:fs',
      'node:path',
      'node:os',
      'node:url',
      // CLI-точки входа пакета (db:migrate, db:rollback) — единственные файлы в infrastructure,
      // которым legitimately нужны process.argv/exitCode.
      'node:process',
      // AsyncLocalStorage в tx.ts: проброс активной транзакции без протаскивания scope
      // через каждую сигнатуру (вложенный runInTx присоединяется к внешней транзакции).
      'node:async_hooks',
      // Планировщик фоновых джобов (infrastructure/jobs, промпт 1.5): setInterval/clearInterval
      // из node:timers — единственная зависимость пакета, внешних планировщиков нет (D212).
      'node:timers',
    ],
    forbiddenNote: 'адаптер знает интерфейс (порт), но не ядро; модули и транспорт из infrastructure не импортируются',
  },
  {
    layer: 'gateways',
    dirs: ['gateways/http', 'gateways/ws'],
    internal: ['@mnemosin/contracts', '@mnemosin/core/domain/ports'],
    refs: ['@mnemosin/contracts', '@mnemosin/core', '@mnemosin/module-*'],
    // jose — промпт 1.10: JWT HS256 (v3 §VI.1, B-12); собственная реализация
    // подписи отклонена как security-риск (D252).
    external: ['fastify', '@fastify/*', 'zod', 'jose', 'node:crypto', 'node:fs', 'node:path', 'node:url'],
    forbiddenNote:
      'транспорт не содержит игровой логики (инвариант 14): core и БД не импортируются, только контракты и команды модулей',
  },
  {
    layer: 'apps',
    dirs: ['apps/server'],
    // apps/server — точка сборки: здесь разрешены все слои, но не клиент
    internal: [
      '@mnemosin/contracts',
      '@mnemosin/config',
      '@mnemosin/logging',
      '@mnemosin/core',
      '@mnemosin/core/*',
      '@mnemosin/module-*',
      '@mnemosin/gateway-*',
      '@mnemosin/database',
      '@mnemosin/ai',
      // промпт 1.5: wiring собирает планировщик фоновых джобов (D212).
      '@mnemosin/jobs',
    ],
    external: ['fastify', '@fastify/*', 'zod', 'pino', 'node:crypto', 'node:fs', 'node:path', 'node:url', 'node:http'],
    forbiddenNote: 'apps/server — wiring; доменная логика здесь не пишется',
  },
  {
    layer: 'client',
    dirs: ['client'],
    internal: ['@mnemosin/contracts'],
    external: ['zod', 'svelte', 'svelte/*', 'svelte/store', 'node:crypto'],
    forbiddenNote: 'клиент импортирует только контракты (v3 §IX.6): core/modules/database/gateways недоступны',
  },
];

/** Пакеты монорепо по каталогам (для чтения package.json). */
export function packageDirs(): string[] {
  const dirs: string[] = [];
  for (const pattern of ['shared/*', 'core', 'modules/*', 'infrastructure/*', 'gateways/*', 'apps/*', 'client']) {
    const [head, tail] = pattern.includes('*') ? [pattern.split('/')[0] as string, true] : [pattern, false];
    if (tail) {
      const base = resolve(ROOT, head);
      if (existsSync(base)) {
        for (const entry of readdirSync(base).sort()) {
          const full = join(base, entry);
          if (statSync(full).isDirectory() && existsSync(join(full, 'package.json'))) dirs.push(`${head}/${entry}`);
        }
      }
    } else if (existsSync(resolve(ROOT, pattern, 'package.json'))) {
      dirs.push(pattern);
    }
  }
  return dirs;
}

export function packageName(dir: string): string {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, dir, 'package.json'), 'utf8')) as { name?: string };
  return pkg.name ?? dir;
}

export function ruleFor(dir: string): LayerRule | undefined {
  return LAYER_RULES.find((rule) =>
    rule.dirs.some((candidate) => dir === candidate || dir.startsWith(`${candidate}/`)),
  );
}

/** Проверка спецификатора по списку разрешённых. `*` на конце = префикс. */
export function isAllowed(specifier: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) =>
    entry.endsWith('*') ? specifier.startsWith(entry.slice(0, -1)) : specifier === entry,
  );
}
