import { CONTRACTS_VERSION } from '@mnemosin/contracts';
import { mkdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { loadConfigOrExit, readPackageVersion } from '@mnemosin/config';
import { createLogger } from '@mnemosin/logging';
import { bootstrapDatabase, OutboxPublisher } from '@mnemosin/database';
import { InMemoryMetricsSink, InProcessEventBus } from '@mnemosin/core';
import { registerStandardJobs, Scheduler } from '@mnemosin/jobs';
import { JwtService, type HttpGatewayDeps } from '@mnemosin/gateway-http';
import type { WsGatewayDeps, WsGatewayHandle } from '@mnemosin/gateway-ws';
import { buildAIStack } from './ai.js';
import { buildApp } from './app.js';
import { buildCoreServices } from './core-services.js';
import { buildModules } from './modules.js';
import { attachModulesRegistry, validateModulesRegistry } from './modules-registry.js';
import { buildProjectionProvider } from './projections.js';
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
    // DB_SEED=false отключает посев явно — для HTTP-приёмки/E2E (чистая база, D108).
    seed: config.env.DB_SEED ?? !config.isProduction,
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
  // Handle WS-шлюза появляется после buildApp; presenceSweep-джоб ссылается лениво.
  const wsGatewayRef: { current: WsGatewayHandle | undefined } = { current: undefined };

  // Промпт 1.7: AI-контур — CapabilityRegistry (цепочки fallback, breaker,
  // политики провайдеров) + AiDirectorService. Провайдер выбирается СТРОГО
  // через env/config (A1.12/D226): apps/server/src/ai.ts — единственная точка,
  // знающая конкретные адаптеры; core/ и modules/ от выбора не зависят.
  const ai = buildAIStack({
    config,
    uow: persistence.uow,
    bus,
    metrics,
    logger,
    root,
  });
  // Базовая линия доступности сразу (A1.13: /health честен со старта),
  // далее — джоб capabilityProbe каждые limits.capabilityProbeMs.
  ai.registry.probeOnce().catch((cause: unknown) => {
    logger.error({ err: cause, event: 'capability_probe_failed' }, 'capability_probe_failed');
  });

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
      // Промпт 1.11: sweep зависших WS-presence записей (мёртвые сокеты без
      // close-события) + чистка истёкшего dedupe-кэша requestId.
      presenceSweep: async () => {
        wsGatewayRef.current?.sweep();
      },
      // Промпт 1.7: healthProbe CapabilityRegistry — isAvailable() у провайдеров,
      // при изменении доступности регистр эмитит CAPABILITY_CHANGED (A1.13).
      capabilityProbe: async () => ai.registry.probeOnce(),
    },
    { outboxPollMs: config.limits.outboxPollMs, capabilityProbeMs: config.limits.capabilityProbeMs },
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

  // Промпт 1.8: прикладные модули — Turn Engine (resolveTurn/commitTurn/
  // rejectTurn/retryTurn) и gm-review (approve/reject/editAndApprove/retry).
  // Промпт 1.9: chat, story, gm, gm-audit + реестр всех 9 модулей (F-8.3).
  // Связи модуль→модуль — структурные порты, сборка здесь (D161/D227).
  const modules = buildModules({ config, persistence, services, ai, logger });
  validateModulesRegistry(modules.registrations); // fail-fast: невалидный реестр не стартует
  const detachModules = attachModulesRegistry(
    modules.registrations,
    bus,
    logger.child({ component: 'modules-registry' }),
  );
  logger.info(
    {
      event: 'modules_ready',
      modules: modules.registrations.map((registration) => registration.contract.moduleId),
    },
    'modules_ready',
  );

  // Промпт 1.10: зависимости HTTP-шлюза. JWT — jose HS256 (D252); players-репо
  // — корневой (чтение вне транзакций: auth-hook проверяет revoked_before, B-12.3).
  const mediaDir = resolvePath(config.stateDir, 'media');
  mkdirSync(mediaDir, { recursive: true });
  const buildHttpGateway = (): HttpGatewayDeps => ({
    jwt: new JwtService({
      secret: config.env.JWT_SECRET,
      accessTtlSeconds: config.env.JWT_TTL_SECONDS,
      refreshTtlSeconds: config.env.JWT_REFRESH_TTL_SECONDS,
    }),
    players: persistence.uow.repos().players,
    isProduction: config.isProduction,
    sessions: services.sessions,
    turns: services.turns,
    chat: modules.chat,
    gm: modules.gm,
    gmReview: modules.gmReview,
    projections: buildProjectionProvider(persistence.uow),
    // Этап 1: срез in-memory метрик текстом (prom-client — этап 3, D146).
    getMetricsText: () => `${JSON.stringify(metrics.snapshot(), null, 2)}\n`,
    mediaDir,
    limits: {
      authPerIpPerMin: config.limits.httpRateAuthPerIpPerMin,
      tokenPerMinute: config.limits.httpRatePerTokenPerMin,
      mutatingTurnPerMinute: config.limits.httpRateMutatingPerTokenPerMin,
    },
    logger: logger.child({ component: 'http-gateway' }),
  });

  // Промпт 1.11: зависимости WS-шлюза. Тот же JwtService/PlayerRepository,
  // что и в HTTP (D252/B-12.3); сервисы модулей — структурные порты (D227);
  // приватность — только projections.ts + WS_PRIVACY_POLICY (B-10).
  const jwtService = new JwtService({
    secret: config.env.JWT_SECRET,
    accessTtlSeconds: config.env.JWT_TTL_SECONDS,
    refreshTtlSeconds: config.env.JWT_REFRESH_TTL_SECONDS,
  });
  const buildWsGateway = (): WsGatewayDeps => ({
    jwt: jwtService,
    players: persistence.uow.repos().players,
    bus,
    serverVersion: config.version,
    getCapabilities: () => Object.values(ai.registry.snapshot().capabilities),
    sessions: services.sessions,
    turns: services.turns,
    chat: modules.chat,
    gm: modules.gm,
    gmReview: modules.gmReview,
    story: modules.story,
    projections: buildProjectionProvider(persistence.uow),
    limits: {
      wsAuthTimeoutMs: config.limits.wsAuthTimeoutMs,
      wsMaxConnectionsPerIp: config.limits.wsMaxConnectionsPerIp,
      wsMaxConnectionsPerPlayer: config.limits.wsMaxConnectionsPerPlayer,
      wsMaxPayloadBytes: config.limits.wsMaxPayloadBytes,
      heartbeat: {
        intervalMs: config.limits.heartbeat.intervalMs,
        idleTimeoutMs: config.limits.heartbeat.idleTimeoutMs,
      },
      wsRatePerConnection: {
        ACTION_SUBMIT: config.limits.wsRatePerConnection.ACTION_SUBMIT,
        CHAT_PUBLIC: config.limits.wsRatePerConnection.CHAT_PUBLIC,
        DEFAULT: config.limits.wsRatePerConnection.DEFAULT,
      },
      dedupeTtlMs: config.limits.dedupeTtlMs,
    },
    logger: logger.child({ component: 'ws-gateway' }),
  });

  const app = await buildApp({
    config,
    logger,
    cwd: root,
    persistence,
    // Промпт 1.7 (A1.13): /health.capabilities = срез CapabilityRegistry.
    getCapabilities: () => ai.registry.snapshot(),
    // Промпт 1.10: HTTP-шлюз — JWT-auth, все маршруты HTTP_ROUTES, единый
    // error handler, rate-limit. Сервисы модулей — структурные порты (D227).
    httpGateway: buildHttpGateway(),
    // Промпт 1.11: WS-шлюз — /ws, проекции, приватность, реконнект-контракт.
    wsGateway: buildWsGateway(),
  });
  wsGatewayRef.current = app.wsGateway;

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
      // Промпт 1.11: сначала WS — отписка broadcast'а от шины и закрытие
      // соединений (1001), чтобы клиенты reconnect'ились уже на свежий процесс.
      app.wsGateway?.detach();
      app.wsGateway?.closeAll();
      // Промпт 1.9: отписка модулей от шины — обработчики больше не вызываются.
      for (const detach of detachModules) detach();
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
