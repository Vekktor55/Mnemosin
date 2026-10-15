import { resolve as resolvePath } from 'node:path';

import { loadConfig, type AppConfig } from '@mnemosin/config';
import { createLogger, type Logger } from '@mnemosin/logging';
import { OutboxPublisher } from '@mnemosin/database';
import { InMemoryMetricsSink, InProcessEventBus, type CoreServices } from '@mnemosin/core';
import { buildAIStack, buildModules, attachModulesRegistry, validateModulesRegistry } from '@mnemosin/server';
import type { ChatService } from '@mnemosin/module-chat';
import type { StoryService } from '@mnemosin/module-story';
import type { GmService } from '@mnemosin/module-gm';
import type { GmAuditService } from '@mnemosin/module-gm-audit';
import type { TurnEngine } from '@mnemosin/module-turn';
import type { GmReviewService } from '@mnemosin/module-gm-review';
import type { DomainEvent, PlayerId, SessionId, TurnId } from '@mnemosin/contracts';

import { bootLobby, buildTestServices, openTempDb, testKey, type TempDb } from './helpers.js';

/**
 * Мир этапа 1 в сборе (промпт 1.9): те же wiring-функции, что и main.ts
 * (buildAIStack/buildModules/validate/attach) — интеграционные тесты модулей
 * проверяют РЕАЛЬНУЮ сборку, включая boot-подписку subscribes→bus и
 * outbox-публикатор (at-least-once доставка событий обработчикам).
 */

const ROOT = process.cwd();

export interface Stage1World {
  readonly db: TempDb;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly services: CoreServices;
  readonly bus: InProcessEventBus;
  readonly metrics: InMemoryMetricsSink;
  readonly publisher: OutboxPublisher;
  readonly chat: ChatService;
  readonly story: StoryService;
  readonly gm: GmService;
  readonly gmAudit: GmAuditService;
  readonly turn: TurnEngine;
  readonly gmReview: GmReviewService;
  readonly sessionId: SessionId;
  readonly gmPlayerId: PlayerId;
  readonly playerIds: PlayerId[];
  readonly turnId: TurnId;
  readonly captured: Array<{ type: string; payload: Record<string, unknown>; traceId: string }>;
  /** Опубликовать outbox → bus (доставка событий обработчикам модулей). */
  drain(): Promise<void>;
  /** Повторно доставить событие напрямую в шину (проверка идемпотентности). */
  redeliver(event: DomainEvent): Promise<void>;
  detach(): void;
  close(): Promise<void>;
}

export interface Stage1WorldOptions {
  readonly players?: number;
  readonly actions?: number;
  readonly lock?: boolean;
  readonly aiProvider?: string;
}

export async function bootStage1World(label: string, options: Stage1WorldOptions = {}): Promise<Stage1World> {
  const db = await openTempDb(label, { seed: false });
  const config = loadConfig({
    cwd: ROOT,
    ignoreDotenv: true,
    version: '0.0.0-test',
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: db.url,
      JWT_SECRET: 'stage1-world-secret-0123456789abcdef0123456789',
      LOG_LEVEL: 'silent',
      AI_PROVIDER: options.aiProvider ?? 'scripted',
      AI_SCRIPTED_FIXTURE: resolvePath(ROOT, 'tools/fixtures/resolution.ok.json'),
    },
  });
  const logger = createLogger({ config, name: `test-${label}` });
  const services = buildTestServices(db);

  const lobby = await bootLobby(services, { players: options.players ?? 3 });
  const turnId = lobby.turnId!;
  for (let i = 0; i < (options.actions ?? 2); i++) {
    await services.turns.submitAction({
      turnId,
      playerId: lobby.playerIds[i % lobby.playerIds.length]!,
      rawText: i === 0 ? 'Осматриваюсь в шлюзе' : 'Слушаю гул вентиляции',
      idempotencyKey: testKey('act'),
    });
  }
  if (options.lock !== false) {
    await services.turns.lockTurn({ turnId, idempotencyKey: testKey('lock') });
  }

  const bus = new InProcessEventBus();
  const metrics = new InMemoryMetricsSink();
  const captured: Array<{ type: string; payload: Record<string, unknown>; traceId: string }> = [];
  bus.subscribe('*', (event) => {
    captured.push({
      type: event.type,
      payload: event.payload as unknown as Record<string, unknown>,
      traceId: event.traceId,
    });
  });

  const ai = buildAIStack({ config, uow: db.boot.uow, bus, metrics, logger, root: ROOT });
  const modules = buildModules({ config, persistence: db.boot, services, ai, logger });
  validateModulesRegistry(modules.registrations);
  const detachHandles = attachModulesRegistry(modules.registrations, bus, logger.child({ component: 'registry' }));
  const publisher = new OutboxPublisher({ uow: db.boot.uow, bus, metrics });

  return {
    db,
    config,
    logger,
    services,
    bus,
    metrics,
    publisher,
    chat: modules.chat,
    story: modules.story,
    gm: modules.gm,
    gmAudit: modules.gmAudit,
    turn: modules.turn,
    gmReview: modules.gmReview,
    sessionId: lobby.sessionId,
    gmPlayerId: lobby.gmPlayerId,
    playerIds: lobby.playerIds,
    turnId,
    captured,
    async drain() {
      await publisher.drain();
    },
    async redeliver(event) {
      await bus.publish(event);
    },
    detach() {
      for (const detach of detachHandles) detach();
    },
    async close() {
      for (const detach of detachHandles) detach();
      await db.close();
    },
  };
}

/** Все события outbox (включая опубликованные) — имена. */
export async function outboxNames(world: Stage1World): Promise<string[]> {
  const records = await world.db.boot.uow.repos().outbox.listPending(1000);
  return records.map((record) => record.eventName);
}
