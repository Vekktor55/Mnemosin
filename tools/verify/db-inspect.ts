import process from 'node:process';

import { bootstrapDatabase } from '@mnemosin/database';

/**
 * tools/verify/db-inspect.ts — читает существующую БД и печатает counts одной JSON-строкой.
 *
 * Нужен приёмке A1.11: проверка, что данные переживают РЕСТАРТ процесса, делается снаружи
 * этого процесса — поэтому отдельный читатель. Миграции НЕ применяет (migrate:false),
 * посев не делает (seed:false): инструмент смотрит, а не меняет.
 *
 * Запуск: npx tsx --conditions=development tools/verify/db-inspect.ts <DATABASE_URL>
 */
const url = process.argv[2];
if (!url) {
  process.stderr.write('нужен <DATABASE_URL>\n');
  process.exit(2);
}

const boot = await bootstrapDatabase({ url, seed: false, migrate: false });
const repos = boot.uow.repos();
const sessions = await repos.sessions.listAll();
const active = await repos.sessions.findActive();

const report = {
  sessions: sessions.length,
  activeSessionId: active?.sessionId ?? null,
  players: active ? (await repos.players.listBySession(active.sessionId)).length : 0,
  characters: active ? (await repos.characters.listBySession(active.sessionId)).length : 0,
  locations: await repos.locations.count(),
  hasState: active ? (await repos.state.findBySession(active.sessionId)) !== null : false,
  stateVersion: active ? ((await repos.state.findBySession(active.sessionId))?.version ?? null) : null,
  migrations: boot.version.applied,
  lastMigration: boot.version.lastTag,
};

await boot.close();
process.stdout.write(`${JSON.stringify(report)}\n`);
