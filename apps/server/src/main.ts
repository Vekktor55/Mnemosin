import { CONTRACTS_VERSION } from '@mnemosin/contracts';
import { loadConfigOrExit, readPackageVersion } from '@mnemosin/config';
import { createLogger } from '@mnemosin/logging';
import { bootstrapDatabase, OutboxPublisher } from '@mnemosin/database';
import { InMemoryMetricsSink, InProcessEventBus } from '@mnemosin/core';
import { registerStandardJobs, Scheduler } from '@mnemosin/jobs';
import { buildApp } from './app.js';
import { buildCoreServices } from './core-services.js';
import { resolveProjectRoot } from './project-root.js';

/**
 * Точка входа (промпт 1.1, критерий A1.1).
 *
 * Порядок: loadConfig (fail-fast) → logger → buildApp → listen → graceful shutdown.
 * Конфигурация загружается ДО создания логгера, чтобы уровень и redact
 * брались из конфига, а не из значений по умолчанию.
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

  // Промпт 1.4: БД открывается ДО listen. Миграции не сошлись — процесс не стартует (fail-fast).
  const persistence = await bootstrapDatabase({
    url: config.env.DATABASE_URL,
    logger: logger.child({ component: 'database' }),
    // Посев dev-сессии только вне production: в проде сессию создаёт GM через лобби (промпт 1.10).
    seed: !config.isProduction,
  });
  logger.info(
    {
      event: 'database_ready',
      url: config.env.DATABASE_URL,
      pragmas: persistence.handle.pragmas,
      schemaVersion: persistence.version,
      seed: persistence.seed,
    },
    'database_ready',
  );

  // Промпт 1.5: шина событий, outbox-публикатор и фоновые джобы — ДО listen.
  // Метрики этапа 1 — в памяти процесса (этап 3: prom-client, тот же MetricsSink).
  const metrics = new InMemoryMetricsSink();
  const bus = new InProcessEventBus({
    handlerTimeoutMs: config.limits.handlerTimeoutMs,
    logger: logger.child({ component: 'event-bus' }),
    metrics,
  });
  const outboxPublisher = new OutboxPublisher({
    uow: persistence.uow,
    bus,
    metrics,
    logger: logger.child({ component: 'outbox' }),
    batchSize: config.limits.outboxBatchSize,
    maxAttempts: config.limits.outboxMaxAttempts,
  });

  const scheduler = new Scheduler({ logger: logger.child({ component: 'jobs' }), metrics });
  registerStandardJobs(
    scheduler,
    {
      // Джоб из промпта 1.4: удаление истёкших idempotency-ключей (каждый час).
      cleanupIdempotency: async () => {
        const removed = await persistence.idempotency.cleanupExpired();
        if (removed > 0) logger.info({ removed, event: 'idempotency_cleanup' }, 'idempotency_cleanup');
      },
      // Цикл публикации outbox (каждые outboxPollMs). PENDING, пережившие крах,
      // публикуются автоматически — at-least-once (D113).
      outboxPublisher: async () => {
        const report = await outboxPublisher.pollOnce();
        if (report.scanned > 0) {
          logger.info({ ...report, event: 'outbox_poll' }, 'outbox_poll');
        }
      },
      // Промпт 1.11: sweep зависших WS-presence записей. До 1.11 — честный no-op.
      presenceSweep: async () => {},
    },
    { outboxPollMs: config.limits.outboxPollMs },
  );
  scheduler.start();
  logger.info(
    {
      event: 'jobs_started',
      jobs: scheduler.status().map((j) => ({ name: j.name, intervalMs: j.intervalMs })),
    },
    'jobs_started',
  );

  // Промпт 1.6: доменные сервисы core (машины состояний Turn/Session, StateService,
  // LocationService). Транспорт получит их в 1.10 (HTTP) и 1.11 (WS); здесь —
  // сборка на живой инфраструктуре: сервисы конструируются из BootstrapResult
  // и config без единого импорта инфраструктуры внутрь ядра (D216/D221).
  const services = buildCoreServices(persistence, config);
  logger.info({ event: 'core_services_ready', services: Object.keys(services) }, 'core_services_ready');

  const app = await buildApp({ config, logger, cwd: root, persistence });

  await app.listen({ host: '0.0.0.0', port: config.env.PORT });

  logger.info(
    {
      event: 'server_started',
      port: config.env.PORT,
      env: config.env.NODE_ENV,
      aiProvider: config.env.AI_PROVIDER,
      mediaProvider: config.env.MEDIA_PROVIDER,
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
      // Промпт 1.5: порядок остановки — сначала прекращаем ЗАПУСКАТЬ новое
      // (scheduler.stop дожидается текущих джобов), затем принудительно
      // публикуем остаток outbox (drain), и только потом закрываем HTTP и БД.
      // В промпте 1.11 сюда добавится закрытие WS-соединений (до drain).
      await scheduler.stop();
      try {
        const drained = await outboxPublisher.drain();
        if (drained.scanned > 0) {
          logger.info({ ...drained, event: 'outbox_drained' }, 'outbox_drained');
        }
      } catch (cause) {
        // Невыполнимый drain не должен блокировать остановку: незаписанные
        // PENDING опубликуются после рестарта (at-least-once, D113).
        logger.error({ err: cause, event: 'outbox_drain_failed' }, 'outbox_drain_failed');
      }
      await app.close();
      await persistence.close();
      logger.info({ event: 'shutdown_complete', signal }, 'shutdown_complete');
      process.exit(0);
    } catch (cause) {
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
