import { describe, expect, it } from 'vitest';

import { InMemoryMetricsSink } from '@mnemosin/core';
import { Scheduler, registerStandardJobs, JOB_NAMES } from '@mnemosin/jobs';

/**
 * Промпт 1.5 · Scheduler (infrastructure/jobs).
 *
 * Проверяются: периодический запуск, try/catch (сбой джоба не роняет планировщик),
 * защита от перекрытия (skipped), stop() дожидается текущего запуска, immediate,
 * дубликат имени — ошибка, метрики длительности и сбоев.
 *
 * Тайминги намеренно свободные (CI-машины бывают медленными): проверяем факты
 * («выполнился хотя бы дважды», «пропущен хотя бы один перекрывающийся тик»),
 * а не точные счётчики.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Scheduler · базовое поведение', () => {
  it('запускает джоб периодически и останавливается по stop()', async () => {
    const scheduler = new Scheduler();
    let runs = 0;
    scheduler.register('tick', 10, () => {
      runs += 1;
    });
    scheduler.start();
    await sleep(120);
    await scheduler.stop();
    const afterStop = runs;
    await sleep(50);
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(runs).toBe(afterStop); // после stop() новых запусков нет
    expect(scheduler.isStarted).toBe(false);
  });

  it('immediate=true выполняет джоб сразу при start()', async () => {
    const scheduler = new Scheduler();
    let runs = 0;
    scheduler.register(
      'once-now',
      60_000,
      () => {
        runs += 1;
      },
      { immediate: true },
    );
    scheduler.start();
    await sleep(20);
    await scheduler.stop();
    expect(runs).toBe(1);
  });

  it('сбой джоба логируется, считается и НЕ останавливает остальные джобы', async () => {
    const metrics = new InMemoryMetricsSink();
    const scheduler = new Scheduler({ metrics });
    let healthy = 0;
    scheduler.register('broken', 10, () => {
      throw new Error('джоб сломался');
    });
    scheduler.register('healthy', 10, () => {
      healthy += 1;
    });
    scheduler.start();
    await sleep(80);
    await scheduler.stop();

    const status = scheduler.status();
    const broken = status.find((s) => s.name === 'broken');
    expect(broken?.failures).toBeGreaterThanOrEqual(2);
    expect(broken?.lastError).toBe('джоб сломался');
    expect(healthy).toBeGreaterThanOrEqual(2);
    expect(metrics.counterOf('jobs.failed', { job: 'broken' })).toBeGreaterThanOrEqual(2);
    expect(metrics.snapshot().timings['jobs.duration_ms{job=healthy}']?.count).toBeGreaterThanOrEqual(2);
  });

  it('перекрывающийся тик пропускается: джоб никогда не выполняется в двух экземплярах', async () => {
    const scheduler = new Scheduler();
    let concurrent = 0;
    let maxConcurrent = 0;
    scheduler.register('slow', 10, async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(150);
      concurrent -= 1;
    });
    scheduler.start();
    await sleep(80);
    const mid = scheduler.status().find((s) => s.name === 'slow');
    expect(mid?.running).toBe(true);
    expect(mid?.skipped).toBeGreaterThanOrEqual(2);
    await scheduler.stop();
    expect(maxConcurrent).toBe(1);
    // stop() дождался текущего запуска:
    expect(scheduler.status().find((s) => s.name === 'slow')?.runs).toBe(1);
  });

  it('stop() дожидается текущего запуска джоба', async () => {
    const scheduler = new Scheduler();
    let finished = false;
    scheduler.register('long', 10, async () => {
      await sleep(100);
      finished = true;
    });
    scheduler.start();
    await sleep(20); // джоб уже выполняется
    await scheduler.stop();
    expect(finished).toBe(true);
  });

  it('дубликат имени и невалидный интервал — ошибка сразу', () => {
    const scheduler = new Scheduler();
    scheduler.register('dup', 1000, () => {});
    expect(() => scheduler.register('dup', 1000, () => {})).toThrow(/уже зарегистрирован/);
    expect(() => scheduler.register('bad-interval', 0, () => {})).toThrow(/intervalMs/);
  });
});

describe('registerStandardJobs · словарь Stage 1', () => {
  it('регистрирует cleanupIdempotency (час), outboxPublisher (из опций), presenceSweep (10 с)', () => {
    const scheduler = new Scheduler();
    const noop = (): void => {};
    registerStandardJobs(
      scheduler,
      { cleanupIdempotency: noop, outboxPublisher: noop, presenceSweep: noop },
      { outboxPollMs: 250 },
    );
    const status = scheduler.status();
    expect(status.map((s) => s.name).sort()).toEqual(
      [JOB_NAMES.cleanupIdempotency, JOB_NAMES.outboxPublisher, JOB_NAMES.presenceSweep].sort(),
    );
    expect(status.find((s) => s.name === JOB_NAMES.outboxPublisher)?.intervalMs).toBe(250);
    expect(status.find((s) => s.name === JOB_NAMES.cleanupIdempotency)?.intervalMs).toBe(3_600_000);
    expect(status.find((s) => s.name === JOB_NAMES.presenceSweep)?.intervalMs).toBe(10_000);
  });
});
