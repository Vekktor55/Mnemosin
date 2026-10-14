/**
 * MetricsSink — порт метрик (промпт 1.5).
 *
 * Этап 1: заглушка `InMemoryMetricsSink` (core/events/metrics.ts) — счётчики
 * в памяти процесса, доступны для тестов и диагностики.
 * Этап 3: реализация на prom-client (infrastructure/metrics) — тот же интерфейс,
 * ядро и инфраструктура не меняются (инвариант 9).
 */

export type MetricLabels = Readonly<Record<string, string | number | boolean>>;

export interface MetricsSink {
  /** Монотонный счётчик (published, failed, dead, …). value по умолчанию 1. */
  counter(name: string, value?: number, labels?: MetricLabels): void;
  /** Длительность операции в мс (dispatch, job, poll). */
  timing(name: string, durationMs: number, labels?: MetricLabels): void;
}
