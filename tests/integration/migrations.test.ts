import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { nowIso } from '@mnemosin/contracts';
import { defaultMigrationsFolder, openDatabase, runMigrations, type DatabaseHandle } from '@mnemosin/database';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

interface TableNameRow {
  readonly name: string;
}

interface JournalRow {
  readonly turn_id: string;
  readonly session_id: string;
  readonly payload_json: string;
}

describe('forward migration 0001 · удаление Turn Engine таблиц', () => {
  it('0000 → 0001 удаляет turns/actions/ai_decisions, сохраняет journal_entries и идемпотентна', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mnemosin-migration-'));
    const initialFolder = join(dir, 'initial');
    const currentFolder = defaultMigrationsFolder();
    mkdirSync(join(initialFolder, 'meta'), { recursive: true });
    copyFileSync(join(currentFolder, '0000_init.sql'), join(initialFolder, '0000_init.sql'));
    copyFileSync(join(currentFolder, 'meta', '0000_snapshot.json'), join(initialFolder, 'meta', '0000_snapshot.json'));

    const currentJournal = JSON.parse(readFileSync(join(currentFolder, 'meta', '_journal.json'), 'utf8')) as {
      entries: unknown[];
    };
    writeFileSync(
      join(initialFolder, 'meta', '_journal.json'),
      JSON.stringify({ version: '7', dialect: 'sqlite', entries: currentJournal.entries.slice(0, 1) }, null, 2),
    );

    let handle: DatabaseHandle | undefined;
    try {
      handle = await openDatabase({ url: `file:${join(dir, 'legacy.sqlite')}` });
      await runMigrations(handle.db, initialFolder);

      const initialTables = await handle.db.all<TableNameRow>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`);
      expect(initialTables.map((row) => row.name)).toEqual(
        expect.arrayContaining(['turns', 'actions', 'ai_decisions', 'journal_entries']),
      );

      const at = nowIso();
      const sessionId = randomUUID();
      const turnId = randomUUID();
      await handle.db.run(sql`
        INSERT INTO sessions
          (session_id, title, status, gm_player_id, current_turn_id, world_pack_id, world_pack_version,
           archived_at, created_at, updated_at, body_json)
        VALUES
          (${sessionId}, 'legacy', 'ACTIVE', ${randomUUID()}, NULL, NULL, NULL, NULL, ${at}, ${at}, '{}')
      `);
      await handle.db.run(sql`
        INSERT INTO turns
          (turn_id, session_id, number, status, locked_at, processing_started_at, review_ready_at,
           committed_at, created_at, updated_at, body_json)
        VALUES
          (${turnId}, ${sessionId}, 1, 'OPEN', NULL, NULL, NULL, NULL, ${at}, ${at}, '{}')
      `);
      await handle.db.run(sql`PRAGMA foreign_keys = OFF`);
      await handle.db.run(sql`
        INSERT INTO actions
          (action_id, turn_id, player_id, sequence_id, intent, idempotency_key, created_at, body_json)
        VALUES
          (${randomUUID()}, ${turnId}, ${randomUUID()}, 1, NULL, ${`legacy-${randomUUID()}`}, ${at}, '{}')
      `);
      await handle.db.run(sql`
        INSERT INTO ai_decisions
          (session_id, turn_id, provider_id, model, status, prompt_hash, response_json,
           violations_count, latency_ms, error_code, trace_id, created_at)
        VALUES
          (${sessionId}, ${turnId}, 'legacy', 'legacy-model', 'OK', NULL, NULL, 0, 0, NULL, 'trace-legacy', ${at})
      `);
      await handle.db.run(sql`PRAGMA foreign_keys = ON`);
      await handle.db.run(sql`
        INSERT INTO journal_entries (turn_id, session_id, trace_id, kind, payload_json, created_at)
        VALUES (${turnId}, ${sessionId}, 'trace-journal', 'turn_opened', '{"number":1}', ${at})
      `);

      const migrated = await runMigrations(handle.db);
      expect(migrated.changed).toBe(true);
      expect(migrated.version.applied).toBe(2);
      expect(migrated.version.available).toBe(2);
      expect(migrated.version.lastTag).toBe('0001_faithful_leper_queen');

      const migratedTables = await handle.db.all<TableNameRow>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table'`,
      );
      expect(migratedTables.map((row) => row.name)).not.toEqual(
        expect.arrayContaining(['turns', 'actions', 'ai_decisions']),
      );

      const journal = await handle.db.all<JournalRow>(
        sql`SELECT turn_id, session_id, payload_json FROM journal_entries WHERE turn_id = ${turnId}`,
      );
      expect(journal).toEqual([{ turn_id: turnId, session_id: sessionId, payload_json: '{"number":1}' }]);

      const repeated = await runMigrations(handle.db);
      expect(repeated.changed).toBe(false);
      expect(repeated.version.applied).toBe(2);
    } finally {
      await handle?.close();
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // Windows может задерживать освобождение SQLite handles; это не влияет на assertions миграции.
      }
    }
  });
});
