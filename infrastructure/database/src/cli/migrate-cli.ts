import process from 'node:process';

import { openDatabase } from '../client.js';
import { defaultMigrationsFolder, runMigrations } from '../migrate.js';

/** `npm run db:migrate -w @mnemosin/database -- file:./data/mnemosin.sqlite` */
async function main(): Promise<void> {
  const url = process.argv[2] ?? process.env['DATABASE_URL'];
  if (!url) {
    process.stderr.write('Использование: db:migrate <DATABASE_URL> (например file:./data/mnemosin.sqlite)\n');
    process.exitCode = 2;
    return;
  }
  const folder = process.argv[3] ?? defaultMigrationsFolder();
  const handle = await openDatabase({ url });
  const result = await runMigrations(handle.db, folder);
  process.stdout.write(
    `migrations: applied=${result.version.applied}/${result.version.available} last=${result.version.lastTag ?? '—'} changed=${result.changed}\n`,
  );
  await handle.close();
}

main().catch((err: unknown) => {
  process.stderr.write(`db:migrate FAILED: ${String(err instanceof Error ? err.message : err)}\n`);
  process.exitCode = 1;
});
