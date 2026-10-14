import type { Scheduler } from './scheduler.js';

/**
 * Стандартные джобы Stage 1 (промпт 1.5, п.4).
 *
 * Пакет @mnemosin/jobs НЕ знает про БД и outbox (граница infrastructure: только
 * порты core). Конкретные обработчики передаёт wiring (apps/server) — замыканиями
 * на IdempotencyService и OutboxPublisher. Имена и интервалы фиксированы здесь,
 * чтобы /health и метрики всех окружений использовали один словарь.
 */

export const JOB_NAMES = {
  /** Удаление истёкших idempotency-ключей (каждый час; джоб из промпта 1.4). */
  cleanupIdempotency: 'cleanupIdempotency',
  /** Цикл публикации outbox (каждые limits.outboxPollMs, default 250). */
  outboxPublisher: 'outboxPublisher',
  /** Очистка зависших presence-записей WS (каждые 10 с; реализация — промпт 1.11). */
  presenceSweep: 'presenceSweep',
} as const;

export type StandardJobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

export const JOB_INTERVALS_MS = {
  cleanupIdempotency: 60 * 60 * 1000,
  presenceSweep: 10 * 1000,
} as const;

/** Обработчики стандартных джобов — их передаёт wiring (apps/server). */
export interface StandardJobHandlers {
  cleanupIdempotency(): Promise<void> | void;
  outboxPublisher(): Promise<void> | void;
  presenceSweep(): Promise<void> | void;
}

export interface RegisterStandardJobsOptions {
  /** Интервал опроса outbox (limits.outboxPollMs). */
  readonly outboxPollMs: number;
}

/** Регистрирует три стандартных джоба Stage 1 на планировщике. */
export function registerStandardJobs(
  scheduler: Scheduler,
  handlers: StandardJobHandlers,
  options: RegisterStandardJobsOptions,
): void {
  scheduler.register(JOB_NAMES.cleanupIdempotency, JOB_INTERVALS_MS.cleanupIdempotency, handlers.cleanupIdempotency);
  scheduler.register(JOB_NAMES.outboxPublisher, options.outboxPollMs, handlers.outboxPublisher);
  scheduler.register(JOB_NAMES.presenceSweep, JOB_INTERVALS_MS.presenceSweep, handlers.presenceSweep);
}
