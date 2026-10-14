import type { AppConfig } from '@mnemosin/config';
import { createCoreServices, type CoreServices } from '@mnemosin/core';
import { loadLocationFixtures, type BootstrapResult } from '@mnemosin/database';

/**
 * Сборка доменных сервисов core на живой инфраструктуре (промпт 1.6, D216/D221).
 *
 * Wiring-точка: UnitOfWork и CommandRunner (IdempotencyService) приходят из
 * bootstrapDatabase(), world-pack — из фикстур locations.stage1.json
 * (loadLocationFixtures валидирует их LocationDefinitionSchema при чтении),
 * лимиты — из config/limits.yaml. В промпте 1.10 эти сервисы получат
 * HTTP-маршруты, в 1.11 — WS-команды; доменная логика от транспорта не зависит.
 */
export function buildCoreServices(persistence: BootstrapResult, config: AppConfig): CoreServices {
  return createCoreServices({
    uow: persistence.uow,
    guard: persistence.idempotency,
    pack: loadLocationFixtures(),
    limits: {
      maxPlayersPerSession: config.limits.maxPlayersPerSession,
      actionsPerPlayerPerTurn: config.limits.actionsPerPlayerPerTurn,
    },
  });
}
