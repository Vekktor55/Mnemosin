import { clearInterval, setInterval } from 'node:timers';

import type { MetricsSink } from '@mnemosin/core/domain/ports';

/**
 * Scheduler — простой интервальный планировщик фоновых джобов (промпт 1.5, п.4).
 *
 * Без внешних зависимостей (никаких bull/cron): Stage 1 — один процесс (D108),
 * джобов три (cleanupIdempotency, outboxPublisher, presenceSweep), и все они —
 * «выполнить периодически, не чаще интервала». В Stage 3 при нескольких воркерах
 * планировщик заменяется на распределённую очередь — интерфейс (register/start/stop/status)
 * сохраняется, точка замены — этот пакет.
 *
 * Гарантии:
 *  - каждый запуск обёрнут в try/catch: сбой джоба НЕ останавливает планировщик
 *    и не роняет процесс (логируется error + метрика jobs.failed);
 *  - длительность каждого запуска уходит в MetricsSink.timing('jobs.duration_ms');
 *  - защита от перекрытия: если предыдущий запуск ещё выполняется, тик пропускается
 *    (счётчик skipped) — джоб никогда не выполняется в двух экземплярах;
 *  - таймеры unref(): планировщик не удерживает процесс живым (сервер держит
 *    listen-сокет; тесты завершаются без зависания);
 *  - stop() останавливает тики и ДОЖИДАЕТСЬ текущих запусков (graceful shutdown:
 *    main.ts вызывает stop() до drain() outbox и закрытия БД).
 */

/** Минимальный структурный интерфейс логгера (pino-совместим; пакет не тянет pino). */
export interface SchedulerLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export type Job = () => void | Promise<void>;

export interface RegisterOptions {
  /** Выполнить сразу при start(), не дожидаясь первого тика. */
  readonly immediate?: boolean;
}

export interface JobStatus {
  readonly name: string;
  readonly intervalMs: number;
  readonly running: boolean;
  readonly runs: number;
  readonly failures: number;
  readonly skipped: number;
  readonly lastDurationMs: number | null;
  readonly lastError: string | null;
  readonly lastRunAt: string | null;
}

export interface SchedulerOptions {
  readonly logger?: SchedulerLogger;
  readonly metrics?: MetricsSink;
}

interface JobEntry {
  readonly name: string;
  readonly intervalMs: number;
  readonly job: Job;
  readonly immediate: boolean;
  timer: ReturnType<typeof setInterval> | null;
  /** Promise текущего запуска (null, если джоб не выполняется) — stop() дожидается его. */
  completion: Promise<void> | null;
  running: boolean;
  runs: number;
  failures: number;
  skipped: number;
  lastDurationMs: number | null;
  lastError: string | null;
  lastRunAt: string | null;
}

export class Scheduler {
  private readonly entries = new Map<string, JobEntry>();
  private readonly logger: SchedulerLogger | undefined;
  private readonly metrics: MetricsSink | undefined;
  private started = false;

  constructor(options: SchedulerOptions = {}) {
    this.logger = options.logger;
    this.metrics = options.metrics;
  }

  /** Регистрация джоба. Дубликат имени — ошибка (опечатка должна падать сразу). */
  register(name: string, intervalMs: number, job: Job, options: RegisterOptions = {}): void {
    if (this.entries.has(name)) throw new Error(`[jobs] джоб уже зарегистрирован: ${name}`);
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
      throw new Error(`[jobs] intervalMs должен быть положительным целым: ${name}=${String(intervalMs)}`);
    }
    const entry: JobEntry = {
      name,
      intervalMs,
      job,
      immediate: options.immediate ?? false,
      timer: null,
      completion: null,
      running: false,
      runs: 0,
      failures: 0,
      skipped: 0,
      lastDurationMs: null,
      lastError: null,
      lastRunAt: null,
    };
    this.entries.set(name, entry);
    // Регистрация после start() (не используется в Stage 1, но поддерживаем честность):
    if (this.started) entry.timer = this.armTimer(entry);
  }

  /** Запуск всех таймеров. Повторный вызов — no-op. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const entry of this.entries.values()) {
      entry.timer = this.armTimer(entry);
      if (entry.immediate) void this.execute(entry);
    }
    this.logger?.info({ jobs: [...this.entries.keys()], event: 'scheduler_started' }, 'scheduler_started');
  }

  /** Остановка: снять таймеры и дождаться текущих запусков (graceful shutdown). */
  async stop(): Promise<void> {
    this.started = false;
    for (const entry of this.entries.values()) {
      if (entry.timer !== null) {
        clearInterval(entry.timer);
        entry.timer = null;
      }
    }
    // Текущие запуски: execute() никогда не отклоняется (всё под try/catch).
    const pending = [...this.entries.values()]
      .map((entry) => entry.completion)
      .filter((completion): completion is Promise<void> => completion !== null);
    await Promise.all(pending);
    this.logger?.info({ event: 'scheduler_stopped' }, 'scheduler_stopped');
  }

  /** Срез состояния джобов — для диагностики, /health (1.7+) и тестов. */
  status(): JobStatus[] {
    return [...this.entries.values()].map((entry) => ({
      name: entry.name,
      intervalMs: entry.intervalMs,
      running: entry.running,
      runs: entry.runs,
      failures: entry.failures,
      skipped: entry.skipped,
      lastDurationMs: entry.lastDurationMs,
      lastError: entry.lastError,
      lastRunAt: entry.lastRunAt,
    }));
  }

  get isStarted(): boolean {
    return this.started;
  }

  private armTimer(entry: JobEntry): ReturnType<typeof setInterval> {
    const timer = setInterval(() => {
      void this.execute(entry);
    }, entry.intervalMs);
    // Планировщик не должен удерживать event loop: процесс держит HTTP-сервер.
    timer.unref?.();
    return timer;
  }

  /** Один запуск джоба: защита от перекрытия, try/catch, метрика длительности. */
  private execute(entry: JobEntry): Promise<void> {
    if (entry.running) {
      entry.skipped += 1;
      this.metrics?.counter('jobs.skipped', 1, { job: entry.name });
      this.logger?.warn({ job: entry.name, event: 'job_skipped_overlapping' }, 'job_skipped_overlapping');
      return Promise.resolve();
    }
    entry.running = true;
    const startedAt = Date.now();
    const completion = (async (): Promise<void> => {
      try {
        await entry.job();
        entry.runs += 1;
        entry.lastDurationMs = Date.now() - startedAt;
        entry.lastRunAt = new Date(startedAt).toISOString();
        entry.lastError = null;
        this.metrics?.timing('jobs.duration_ms', entry.lastDurationMs, { job: entry.name });
        this.logger?.debug({ job: entry.name, durationMs: entry.lastDurationMs }, 'job_completed');
      } catch (err: unknown) {
        entry.failures += 1;
        entry.lastError = err instanceof Error ? err.message : String(err);
        this.metrics?.counter('jobs.failed', 1, { job: entry.name });
        this.logger?.error({ job: entry.name, err, event: 'job_failed' }, 'job_failed');
      } finally {
        entry.running = false;
        entry.completion = null;
      }
    })();
    entry.completion = completion;
    return completion;
  }
}
