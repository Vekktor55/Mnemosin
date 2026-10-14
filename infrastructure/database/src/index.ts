/**
 * @mnemosin/database — реализация портов ядра (промпт 1.4).
 *
 * Слои: schema (таблицы) → client (соединение + PRAGMA) → migrate (миграции) →
 * repositories (реализации портов) → tx (UnitOfWork) → idempotency/bootstrap (сервисы).
 *
 * Ядро (@mnemosin/core) знает только интерфейсы; этот пакет — единственное место,
 * где встречается SQLite. Замена драйвера (libsql → better-sqlite3 → Postgres, D195)
 * затрагивает client.ts и, при смене диалекта, миграции.
 */
export const PACKAGE_ID = '@mnemosin/database';
export const IMPLEMENTED_IN_PROMPT = '1.4 → 1.5 (outbox-публикатор)';

export * from './client.js';
export * from './migrate.js';
export * from './schema.js';
export * from './tx.js';
export * from './idempotency.js';
export * from './bootstrap.js';
export * from './outbox-publisher.js';
export { createRepositories } from './repositories/index.js';
export * from './repositories/sessions.js';
export * from './repositories/turns.js';
export * from './repositories/state.js';
export * from './repositories/locations.js';
export * from './repositories/chat.js';
export * from './repositories/journal.js';
export * from './repositories/idempotency.js';
export * from './repositories/snapshots.js';
export { parseBody, assertMatches, checksumOf, stableStringify, rowsAffectedOf, asJson } from './mappers/index.js';
export * from './mappers/session-mappers.js';
export * from './mappers/turn-mappers.js';
export * from './mappers/state-mappers.js';
export * from './mappers/misc-mappers.js';
