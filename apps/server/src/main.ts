import { CONTRACTS_VERSION } from '@mnemosin/contracts';
import { loadConfigOrExit, readPackageVersion } from '@mnemosin/config';
import { createLogger } from '@mnemosin/logging';
import { bootstrapDatabase } from '@mnemosin/database';
import { buildApp } from './app.js';
import { resolveProjectRoot } from './project-root.js';

/**
 * Точка входа (промпт 1.1, критерий A1.1).
 *
 * Порядок: loadConfig (fail-fast) → logger → buildApp → listen → graceful shutdown.
 * Конфигурация загружается ДО создания логгера, чтобы уровень и redact
 * брались из конфига, а не из значений по умолчанию.
 *
 * SB-01: минимальный bootstrap — только /health и /version.
 * Старый Turn Engine, AI Stack, Module Stack, reconcileOnBoot,
 * Core Services, Module Registry и Gateway dependencies удалены.
 */

async function main(): Promise<void> {
  const root = resolveProjectRoot();
  const config = loadConfigOrExit({ cwd: root, version: readPackageVersion(root) });
  const logger = createLogger({ config, name: 'mnemosin' });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled_rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught_exception');
    process.exit(1);
  });

  // SB-01: БД открывается ДО listen. Fail-fast если миграции не сошлись.
  const persistence = await bootstrapDatabase({
    url: config.env.DATABASE_URL,
    logger: logger.child({ component: 'database' }),
    seed: config.env.DB_SEED ?? !config.isProduction,
  });
  logger.info(
    {
      event: 'database_ready',
      url: config.env.DATABASE_URL,
      schemaVersion: persistence.version,
      seed: persistence.seed,
    },
    'database_ready',
  );

  // SB-01: только health и version — остальные маршруты опущены.
  const app = await buildApp({
    config,
    logger,
    cwd: root,
    persistence,
  });

  await app.listen({ host: '0.0.0.0', port: config.env.PORT });

  logger.info(
    {
      event: 'server_started',
      port: config.env.PORT,
      env: config.env.NODE_ENV,
      contractsVersion: CONTRACTS_VERSION,
      schemaVersion: persistence.version.applied,
      lastMigration: persistence.version.lastTag,
    },
    'server_started',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: 'shutdown_started', signal }, 'shutdown_started');
    const timer = setTimeout(() => {
      logger.error({ event: 'shutdown_timeout' }, 'shutdown_timeout');
      process.exit(1);
    }, 10_000);
    timer.unref();
    try {
      await app.close();
      await persistence.close();
      clearTimeout(timer);
      logger.info({ event: 'shutdown_complete', signal }, 'shutdown_complete');
      process.exit(0);
    } catch (cause) {
      clearTimeout(timer);
      logger.error({ err: cause, event: 'shutdown_failed' }, 'shutdown_failed');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main().catch((cause: unknown) => {
  process.stderr.write(`FATAL: ${(cause as Error).stack ?? (cause as Error).message}\n`);
  process.exit(1);
});
