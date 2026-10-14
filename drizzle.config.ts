import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit конфигурация (промпт 1.4).
 *
 * `dialect: 'sqlite'` — схема описана в sqlite-core; драйвер libsql (D195) совместим.
 * Миграции кладём ВНУТРЬ пакета infrastructure/database/migrations и коммитим:
 * схема БД — часть артефакта, а не генерируемый на лету мусор.
 */
export default defineConfig({
  schema: './infrastructure/database/src/schema.ts',
  out: './infrastructure/database/migrations',
  dialect: 'sqlite',
  strict: true,
  verbose: false,
  breakpoints: true,
});
