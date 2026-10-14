import type { MetricLabels, MetricsSink } from '../domain/ports/index.js';

/**
 * Метрики этапа 1 (промпт 1.5): интерфейс MetricsSink объявлен в портах core,
 * здесь — две реализации:
 *  - NOOP_METRICS — когда метрики не нужны (тесты без проверок метрик, вложенные шины);
 *  - InMemoryMetricsSink — счётчики в памяти процесса: тесты, диагностика,
 *    /health-подобные отчёты. В этапе 3 заменяется на prom-client
 *    (infrastructure/metrics) БЕЗ изменения ядра (инвариант 9).
 */

export const NOOP_METRICS: MetricsSink = {
  counter(): void {},
  timing(): void {},
};

/** Ключ метрики с лейблами: `name{k1=v1,k2=v2}` (лейблы сортируются — ключ стабилен). */
export function metricKey(name: string, labels?: MetricLabels): string {
  if (labels === undefined) return name;
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return name;
  return `${name}{${keys.map((k) => `${k}=${String(labels[k])}`).join(',')}}`;
}

export interface TimingStat {
  readonly count: number;
  readonly sumMs: number;
  readonly maxMs: number;
}

export interface MetricsSnapshot {
  readonly counters: Readonly<Record<string, number>>;
  readonly timings: Readonly<Record<string, TimingStat>>;
}

export class InMemoryMetricsSink implements MetricsSink {
  private readonly counters = new Map<string, number>();
  private readonly timings = new Map<string, { count: number; sumMs: number; maxMs: number }>();

  counter(name: string, value = 1, labels?: MetricLabels): void {
    const key = metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  timing(name: string, durationMs: number, labels?: MetricLabels): void {
    const key = metricKey(name, labels);
    const prev = this.timings.get(key);
    if (prev === undefined) {
      this.timings.set(key, { count: 1, sumMs: durationMs, maxMs: durationMs });
    } else {
      prev.count += 1;
      prev.sumMs += durationMs;
      prev.maxMs = Math.max(prev.maxMs, durationMs);
    }
  }

  /** Значение счётчика (0, если не увеличивался) — для тестов и диагностики. */
  counterOf(name: string, labels?: MetricLabels): number {
    return this.counters.get(metricKey(name, labels)) ?? 0;
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      timings: Object.fromEntries(this.timings),
    };
  }

  reset(): void {
    this.counters.clear();
    this.timings.clear();
  }
}
