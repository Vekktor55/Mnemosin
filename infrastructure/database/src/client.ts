import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { createClient, type Client } from '@libsql/client';
import { sql } from 'drizzle-orm';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';

import * as schema from './schema.js';

/**
 * Драйвер БД (промпт 1.4).
 *
 * D195: вместо better-sqlite3 используется libsql (@libsql/client).
 * Причина — факт окружения, а не предпочтение: better-sqlite3@13 требует Node >= 22 и его
 * prebuild на Node 20 падает в SIGSEGV, а better-sqlite3@12 собирается через node-gyp
 * (в среде нет make/g++). libsql — тот же SQLite (3.45.1) с готовыми бинарниками под
 * платформу, без компиляции. Drizzle-схема описана в диалекте sqlite-core, поэтому
 * обратный переход на better-sqlite3 (Node 22) или на Postgres (Stage 3) — это замена
 * ОДНОГО файла (client.ts) + перегенерация миграций; схема и репозитории не меняются.
 *
 * Обязательные PRAGMA (критерий A1.4) проверяются ПОСЛЕ установки: если foreign_keys
 * не включился, процесс падает сразу, а не молча пишет сирот.
 */

export type Db = LibSQLDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Общий тип для «db или активная транзакция» — репозитории работают с обоими одинаково. */
export type Executor = Db | Tx;

/** Минимальный интерфейс логгера, чтобы пакет не тянул pino в рантайм-зависимости. */
export interface DbLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export interface DatabaseHandle {
  readonly client: Client;
  /** Соединение для ЗАПИСИ (транзакции). Одно на процесс — см. serial.ts. */
  readonly db: Db;
  /** Отдельное соединение для ЧТЕНИЯ: в WAL читатели не блокируют писателя и не попадают в его транзакцию. */
  readonly readerClient: Client;
  readonly reader: Db;
  readonly url: string;
  /** Реально применённые PRAGMA — для /health и диагностики. */
  readonly pragmas: Readonly<Record<string, string | number>>;
  close(): Promise<void>;
}

export interface OpenDatabaseOptions {
  /** `file:./data/mnemosin.sqlite` или `file::memory:`. */
  readonly url: string;
  readonly logger?: DbLogger;
  /** Отключить WAL (нужно для :memory: в некоторых сценариях тестов). */
  readonly journalMode?: 'wal' | 'memory' | 'delete';
}

const PRAGMA_PLAN = {
  foreign_keys: 'ON',
  busy_timeout: '5000',
  synchronous: 'NORMAL',
} as const;

async function readPragma(client: Client, name: string): Promise<string | number> {
  const rs = await client.execute(`PRAGMA ${name}`);
  const row = rs.rows[0];
  if (!row) return '';
  const value = Object.values(row)[0];
  return typeof value === 'bigint' ? Number(value) : (value as string | number);
}

/** Для file: URL создаёт каталог, если его нет — иначе libsql падает с «unable to open database file». */
export function ensureFileUrlDir(url: string, cwd: string = process.cwd()): void {
  if (!url.startsWith('file:')) return;
  const path = url.slice('file:'.length);
  if (path.length === 0 || path === ':memory:') return;
  mkdirSync(dirname(resolve(cwd, path)), { recursive: true });
}

export async function openDatabase(options: OpenDatabaseOptions): Promise<DatabaseHandle> {
  ensureFileUrlDir(options.url);
  const client = createClient({ url: options.url });

  const journalMode = options.journalMode ?? 'wal';
  if (journalMode !== 'wal' || !options.url.includes(':memory:')) {
    await client.execute(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`);
  }
  for (const [name, value] of Object.entries(PRAGMA_PLAN)) {
    await client.execute(`PRAGMA ${name} = ${value}`);
  }

  const pragmas: Record<string, string | number> = {
    journal_mode: String(await readPragma(client, 'journal_mode')),
    foreign_keys: Number(await readPragma(client, 'foreign_keys')),
    busy_timeout: Number(await readPragma(client, 'busy_timeout')),
    synchronous: Number(await readPragma(client, 'synchronous')),
  };

  if (pragmas.foreign_keys !== 1) {
    await client.close();
    throw new Error(
      `[database] PRAGMA foreign_keys не применился (получено ${String(pragmas.foreign_keys)}). ` +
        'Работать без FK-контроля нельзя: схема потеряет смысл (критерий A1.4).',
    );
  }

  const db = drizzle(client, { schema, logger: false });

  // Второе соединение — только чтение. Для :memory: отдельное соединение дало бы ПУСТУЮ базу,
  // поэтому в in-memory режиме читатель = писатель (тесты это учитывают).
  const isMemory = options.url.includes(':memory:');
  const readerClient = isMemory ? client : createClient({ url: options.url });
  const reader = isMemory ? db : drizzle(readerClient, { schema, logger: false });

  options.logger?.info({ url: options.url, pragmas, sharedConnection: isMemory }, 'database opened');

  return {
    client,
    db,
    readerClient,
    reader,
    url: options.url,
    pragmas,
    async close(): Promise<void> {
      if (!isMemory) await readerClient.close();
      await client.close();
    },
  };
}

/** Быстрая проверка живости соединения — для /health (критерий A1.1: сервер жив с промпта 1). */
export async function ping(db: Db): Promise<boolean> {
  try {
    await db.run(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

export { schema };
