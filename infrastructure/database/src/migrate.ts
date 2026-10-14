import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { migrate as drizzleMigrate } from 'drizzle-orm/libsql/migrator';

import type { Db } from './client.js';

/**
 * Миграции (промпт 1.4).
 *
 * Путь к папке миграций выводится из import.meta.url, а НЕ хардкодится: в песочнице
 * абсолютные пути "$ARENA_WORKSPACE" переписываются в $ARENA_WORKSPACE у дочерних процессов.
 * Работает одинаково из src/ (tsx) и из dist/ (прод) — обе папки на одной глубине от корня пакета.
 */
export function defaultMigrationsFolder(): string {
  return fileURLToPath(new URL('../migrations', import.meta.url));
}

export interface JournalEntryMeta {
  readonly idx: number;
  readonly when: number;
  readonly tag: string;
  readonly breakpoints: boolean;
}

export function readJournal(folder: string): JournalEntryMeta[] {
  const path = join(folder, 'meta', '_journal.json');
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { entries?: JournalEntryMeta[] };
  return parsed.entries ?? [];
}

export interface SchemaVersion {
  /** Сколько миграций реально применено к этой БД. */
  readonly applied: number;
  /** Тег последней применённой миграции (например `0000_init`) или null для пустой БД. */
  readonly lastTag: string | null;
  /** Сколько миграций описано в папке — расхождение с applied означает «БД отстала». */
  readonly available: number;
  readonly folder: string;
}

interface MigrationRow {
  hash: string;
  created_at: number | string | null;
}

async function readApplied(db: Db): Promise<MigrationRow[]> {
  try {
    const rows = await db.all<MigrationRow>(
      sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC`,
    );
    return rows;
  } catch {
    return []; // таблицы ещё нет — БД чистая
  }
}

export async function readSchemaVersion(db: Db, folder: string = defaultMigrationsFolder()): Promise<SchemaVersion> {
  const applied = await readApplied(db);
  const journal = readJournal(folder);
  const lastMillis = applied.length > 0 ? Number(applied[applied.length - 1]!.created_at) : null;
  const lastTag =
    lastMillis === null ? null : (journal.find((e) => e.when === lastMillis)?.tag ?? `millis:${lastMillis}`);
  return { applied: applied.length, lastTag, available: journal.length, folder };
}

export interface MigrateResult {
  readonly version: SchemaVersion;
  readonly changed: boolean;
}

/** Применяет все неприменённые миграции. Идемпотентна: повторный вызов ничего не делает. */
export async function runMigrations(db: Db, folder: string = defaultMigrationsFolder()): Promise<MigrateResult> {
  const before = await readSchemaVersion(db, folder);
  await drizzleMigrate(db, { migrationsFolder: folder });
  const after = await readSchemaVersion(db, folder);
  return { version: after, changed: after.applied !== before.applied };
}

export interface RollbackResult {
  readonly rolledBackTag: string | null;
  readonly version: SchemaVersion;
}

/**
 * Откатывает ПОСЛЕДНЮЮ применённую миграцию её `<tag>_down.sql`.
 *
 * down-файлы не генерируются drizzle-kit — они пишутся вручную и лежат рядом с up-файлом.
 * Это осознанно: откат схемы с данными автоматически не выводится, а в Stage 1 откат
 * нужен только разработчику (сбросить dev-БД), поэтому down.sql для 0000 = DROP всех таблиц.
 */
export async function rollbackLast(db: Db, folder: string = defaultMigrationsFolder()): Promise<RollbackResult> {
  const applied = await readApplied(db);
  const journal = readJournal(folder);
  if (applied.length === 0) {
    return { rolledBackTag: null, version: await readSchemaVersion(db, folder) };
  }
  const last = applied[applied.length - 1]!;
  const millis = Number(last.created_at);
  const entry = journal.find((e) => e.when === millis);
  if (!entry) {
    throw new Error(`[migrate] не найден journal-элемент для applied created_at=${millis}; откат невозможен`);
  }
  const downPath = join(folder, `${entry.tag}_down.sql`);
  if (!existsSync(downPath)) {
    throw new Error(`[migrate] нет down-файла ${downPath}; откат невозможен`);
  }
  const statements = readFileSync(downPath, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.split('\n').every((l) => l.trim().startsWith('--')));

  for (const statement of statements) {
    for (const one of statement
      .split(/;\s*\n/)
      .map((x) => x.trim())
      .filter(Boolean)) {
      await db.run(sql.raw(one.replace(/;$/, '')));
    }
  }
  await db.run(sql`DELETE FROM __drizzle_migrations WHERE created_at = ${millis}`);
  return { rolledBackTag: entry.tag, version: await readSchemaVersion(db, folder) };
}
