import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { AppError, CONTRACTS_VERSION, MatchId, ParticipantId } from '@mnemosin/contracts';
import { parseWorldPack } from '@mnemosin/core';
import { JwtService } from '@mnemosin/gateway-http';
import { verifyWsToken, type WsAuthenticationResult } from '@mnemosin/gateway-ws';
import { createPrototypeWsGateway, prototypeColdScene, prototypeRealtimeLimits } from './hot-wiring.js';
import { registerDevQuickJoinRoute, type DevQuickJoinContext } from './dev-quick-join.js';
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

  // P05-A: prototype room wiring; полный match lifecycle остаётся P10.
  let wsGateway;
  let devQuickJoin: DevQuickJoinContext | null = null;
  const configuredSessionId = persistence.seed.sessionId;
  if (configuredSessionId !== null) {
    const repositories = persistence.uow.repos();
    const configuredPlayers = (await repositories.players.listBySession(configuredSessionId))
      .filter((player) => !player.isGM)
      .slice(0, 2);
    if (configuredPlayers.length === 2) {
      const pack = parseWorldPack(readFileSync(resolve(root, 'tests/fixtures/worldpack.v4.test.json'), 'utf8'));
      const jwt = new JwtService({
        secret: config.env.JWT_SECRET,
        accessTtlSeconds: config.env.JWT_TTL_SECONDS,
        refreshTtlSeconds: config.env.JWT_REFRESH_TTL_SECONDS,
      });
      const playerIds = new Set(configuredPlayers.map((player) => player.playerId));
      // PROTOTYPE-ONLY: одна сессия = один match. matchId (HOT-контекст) и sessionId
      // (COLD-состояние) — разные идентификаторы, здесь они намеренно совпадают по значению.
      const prototypeMatchId = MatchId.parse(configuredSessionId);
      wsGateway = createPrototypeWsGateway({
        pack,
        players: configuredPlayers.map((player, index) => ({
          participantId: ParticipantId.parse(player.playerId),
          spawnPointId: index === 0 ? ('player-1' as const) : ('player-2' as const),
        })),
        matchId: prototypeMatchId,
        serverVersion: config.version,
        contractsVersion: CONTRACTS_VERSION,
        limits: prototypeRealtimeLimits(config.limits),
        logger,
        loadColdScene: async () =>
          prototypeColdScene(pack, await repositories.state.findBySession(configuredSessionId)),
        async authenticate(token): Promise<WsAuthenticationResult> {
          try {
            const identity = await verifyWsToken({ jwt, players: repositories.players }, token);
            if (identity.sessionId !== configuredSessionId || !playerIds.has(identity.playerId) || identity.isGM) {
              return { ok: false, code: 'AUTH_FORBIDDEN' };
            }
            return {
              ok: true,
              actor: {
                actorId: ParticipantId.parse(identity.playerId),
                actorType: 'player',
                matchId: prototypeMatchId,
                sessionId: configuredSessionId,
                projectionKind: 'player',
                permissions: ['scene:input', 'scene:resync'],
              },
            };
          } catch (cause) {
            return {
              ok: false,
              code: cause instanceof AppError && cause.code === 'AUTH_EXPIRED' ? 'AUTH_EXPIRED' : 'AUTH_INVALID',
            };
          }
        },
      });

      // DEV-ONLY: контекст быстрого входа (те же seeded-игроки, что и WS-прототип).
      devQuickJoin = {
        sessionId: configuredSessionId,
        jwt,
        players: await Promise.all(
          configuredPlayers.map(async (player) => ({
            playerId: player.playerId,
            displayName: player.displayName,
            characterName: (await repositories.characters.findByPlayer(player.playerId))?.name ?? null,
          })),
        ),
      };
    }
  }
  if (wsGateway === undefined) {
    logger.warn({ event: 'ws_prototype_not_configured' }, 'ws_prototype_not_configured');
  }

  const app = await buildApp({
    config,
    logger,
    cwd: root,
    persistence,
    ...(wsGateway === undefined ? {} : { wsGateway }),
  });

  // DEV-ONLY: быстрый вход для локального тестирования рендера.
  // В production маршрут не регистрируется вообще (404).
  if (
    registerDevQuickJoinRoute(app as unknown as FastifyInstance, {
      isProduction: config.isProduction,
      context: devQuickJoin,
    })
  ) {
    logger.info(
      {
        event: 'dev_quick_join_enabled',
        path: '/dev/quick-join',
        seedAvailable: devQuickJoin !== null,
      },
      'dev_quick_join_enabled',
    );
  }

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
