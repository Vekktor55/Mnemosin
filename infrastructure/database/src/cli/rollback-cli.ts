import process from 'node:process';

import { openDatabase } from '../client.js';
import { defaultMigrationsFolder, rollbackLast } from '../migrate.js';

/** `npm run db:rollback -w @mnemosin/database -- file:./data/mnemosin.sqlite` */
async function main(): Promise<void> {
  const url = process.argv[2] ?? process.env['DATABASE_URL'];
  if (!url) {
    process.stderr.write('Использование: db:rollback <DATABASE_URL>\n');
    process.exitCode = 2;
    return;
  }
  const folder = process.argv[3] ?? defaultMigrationsFolder();
  const handle = await openDatabase({ url });
  const result = await rollbackLast(handle.db, folder);
  process.stdout.write(
    `rollback: tag=${result.rolledBackTag ?? 'нечего откатывать'} applied=${result.version.applied}\n`,
  );
  await handle.close();
}

main().catch((err: unknown) => {
  process.stderr.write(`db:rollback FAILED: ${String(err instanceof Error ? err.message : err)}\n`);
  process.exitCode = 1;
});
