import type {
  CommandRunner,
  JournalService,
  MetricsSink,
  RulesPort,
  StateService,
  TurnService,
  UnitOfWork,
} from '@mnemosin/core';
import type { SessionId, TurnId, TurnResolution } from '@mnemosin/contracts';

/**
 * Зависимости Turn Engine (промпт 1.8). Всё — инъекции из wiring (apps/server):
 * модуль не создаёт инфраструктуру сам (D161/D216).
 */

/**
 * Consumer-side интерфейс AI-Директора (D227): модули не импортируют друг друга,
 * `AiDirectorService` удовлетворяет интерфейсу структурно. Вызов — КОМАНДА,
 * не событие (D115/B-09).
 */
export interface DraftGeneratorPort {
  generateDraft(input: {
    turnId: TurnId;
    traceId: string;
  }): Promise<{ turnId: TurnId; sessionId: SessionId; resolution: TurnResolution }>;
}

export interface TurnEngineLog {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export interface TurnEngineLimits {
  /**
   * Allowlist ключей objectStates, которые AI вправе менять (F-9.4/F-4.8):
   * limits.aiMutable.objectStateKeys; `['*']` в этапе 1 — разрешены все ключи,
   * сужается в этапе 2 (промпт 2.14).
   */
  readonly aiMutableObjectKeys: readonly string[];
}

export interface TurnEngineDeps {
  readonly uow: UnitOfWork;
  /** CommandRunner (IdempotencyService, D216) — для commit/reject/retry. */
  readonly guard: CommandRunner;
  readonly services: {
    readonly turns: TurnService;
    readonly state: StateService;
    readonly journal: JournalService;
  };
  readonly aiDirector: DraftGeneratorPort;
  readonly rules: RulesPort;
  readonly limits: TurnEngineLimits;
  readonly metrics?: MetricsSink;
  readonly logger?: TurnEngineLog;
  /** TTL записи идемпотентности (limits.idempotencyTtlHours), default 24ч. */
  readonly idempotencyTtlMs?: number;
}
