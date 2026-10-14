import type { AppConfig } from '@mnemosin/config';

/**
 * GET /health и GET /version (v3 §VI.4; критерий A1.1).
 *
 * Поля capabilities/db/schemaVersion в промпте 1.1 — заглушки:
 *   capabilities заполняется в промпте 1.7 (Capability Registry),
 *   db и schemaVersion — в промпте 1.4 (Drizzle + миграции).
 * Контракт ответа фиксируется в @mnemosin/contracts (промпт 1.2) и после
 * этого отдаётся через Zod-сериализацию.
 */

export interface HealthExtras {
  readonly capabilities?: Record<string, unknown>;
  readonly db?: 'ok' | 'degraded' | 'unknown';
  readonly schemaVersion?: number;
  readonly phase?: string;
}

export interface HealthPayload {
  readonly ok: boolean;
  readonly version: string;
  readonly contractsVersion: string;
  readonly env: string;
  readonly uptime: number;
  readonly capabilities: Record<string, unknown>;
  readonly db: 'ok' | 'degraded' | 'unknown';
  readonly schemaVersion: number | null;
  readonly phase: string;
}

export function buildHealthPayload(
  config: AppConfig,
  contractsVersion: string,
  extras: HealthExtras = {},
): HealthPayload {
  return {
    ok: extras.db !== 'degraded',
    version: config.version,
    contractsVersion,
    env: config.env.NODE_ENV,
    uptime: Math.round(process.uptime() * 1000) / 1000,
    capabilities: extras.capabilities ?? {},
    db: extras.db ?? 'unknown',
    schemaVersion: extras.schemaVersion ?? null,
    phase: extras.phase ?? 'init',
  };
}

export interface VersionPayload {
  readonly version: string;
  readonly contractsVersion: string;
  readonly gitTag: string | null;
  readonly node: string;
}

export function buildVersionPayload(config: AppConfig, contractsVersion: string): VersionPayload {
  return {
    version: config.version,
    contractsVersion,
    gitTag: process.env['GIT_TAG'] ?? null,
    node: process.version,
  };
}
