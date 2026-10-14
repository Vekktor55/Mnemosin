import { AppError, DomainEventSchema, nowIso, type DomainEvent, type OutboxRecord } from '@mnemosin/contracts';
import type { EventBus, MetricsSink, PublishReport, UnitOfWork } from '@mnemosin/core/domain/ports';

import type { DbLogger } from './client.js';

/**
 * Реконструкция DomainEvent из строки outbox (адаптерная функция, D211: ядро
 * не читает outbox — оно только пишет в него). Бросает AppError('VALIDATION')
 * на невалидной записи (отравленное сообщение): публикатор трактует это как
 * сбой доставки → attempts → DEAD (D210).
 */
export function eventFromOutboxRecord(record: OutboxRecord): DomainEvent {
  let payload: unknown;
  try {
    payload = JSON.parse(record.payloadJson) as unknown;
  } catch (cause) {
    throw new AppError('VALIDATION', `event_outbox#${record.id}: payloadJson не является JSON`, {
      eventName: record.eventName,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
  const parsed = DomainEventSchema.safeParse({
    type: record.eventName,
    payload,
    traceId: record.traceId,
    emittedAt: record.emittedAt,
  });
  if (!parsed.success) {
    throw new AppError('VALIDATION', `event_outbox#${record.id}: событие не прошло DomainEventSchema`, {
      eventName: record.eventName,
      issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  return parsed.data;
}

/**
 * OutboxPublisher — цикл публикации отложенных доменных событий (v3 §III.3; промпт 1.5).
 *
 * Зачем outbox (F-2.5, F-2.8, F-2.9, аудит §8.6): событие записывается в `event_outbox`
 * В ТОЙ ЖЕ транзакции, что и доменная мутация (core/events/outbox.ts). Публикатор —
 * единственный, кто достаёт записи и рассылает их в EventBus. Свойства:
 *
 *  - at-least-once: закоммиченная запись публикуется даже после краха процесса
 *    (при рестарте публикатор поднимает все PENDING);
 *  - глобальный порядок по id: батч читается `ORDER BY id ASC` и обрабатывается
 *    последовательно;
 *  - БЕЗ `SELECT … FOR UPDATE` — в SQLite его нет (F-2.5). Взамен: один публикатор
 *    на процесс (D108, Stage 1) + флаг `polling` против перекрывающихся прогонов;
 *    при переходе на несколько воркеров (Stage 3) claiming делается атомарным
 *    UPDATE…WHERE status='PENDING' (точка изменения — этот файл);
 *  - сбой обработчика (PublishReport.failed > 0) или отравленная запись (схема не
 *    парсится) → attempts+1, lastError; после `maxAttempts` попыток — status='DEAD'
 *    (D210), log error + метрика `outbox.dead` (алерт — этап 3);
 *  - остальные события батча продолжают публиковаться (сбой одной записи не стопит очередь);
 *  - обработка записи НЕ обернута в транзакцию: рассылка может быть долгой
 *    (WS, AI в обработчиках 1.9+), а долгие операции вне транзакций — правило проекта.
 *    В транзакцию (короткую, под мьютексом D196) завернуты только отметки статуса.
 *
 * Обработчики событий ОБЯЗАНЫ быть идемпотентными (D113): при сбое событие
 * публикуется повторно целиком.
 */

export interface OutboxPublisherOptions {
  readonly uow: UnitOfWork;
  readonly bus: EventBus;
  readonly metrics?: MetricsSink;
  readonly logger?: DbLogger;
  /** Сколько записей брать за один прогон (limits.outboxBatchSize, default 100). */
  readonly batchSize?: number;
  /** Лимит попыток доставки; после него запись становится DEAD (limits.outboxMaxAttempts, default 5). */
  readonly maxAttempts?: number;
}

export interface PollReport {
  /** Сколько записей просмотрено за прогон. */
  readonly scanned: number;
  /** Сколько отмечено PUBLISHED. */
  readonly published: number;
  /** Сколько получили attempts+1 (сбой обработчиков или отравленная запись). */
  readonly failed: number;
  /** Сколько стало DEAD в этом прогоне. */
  readonly dead: number;
  /** Прогон был пропущен: предыдущий ещё не завершился. */
  readonly skipped: boolean;
}

const EMPTY_REPORT: PollReport = { scanned: 0, published: 0, failed: 0, dead: 0, skipped: false };

export class OutboxPublisher {
  private readonly uow: UnitOfWork;
  private readonly bus: EventBus;
  private readonly metrics: MetricsSink | undefined;
  private readonly logger: DbLogger | undefined;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private polling = false;

  constructor(options: OutboxPublisherOptions) {
    this.uow = options.uow;
    this.bus = options.bus;
    this.metrics = options.metrics;
    this.logger = options.logger;
    this.batchSize = options.batchSize ?? 100;
    this.maxAttempts = options.maxAttempts ?? 5;
  }

  /**
   * Один прогон: SELECT PENDING (ORDER BY id, LIMIT batchSize) → доставить каждую →
   * UPDATE published_at/attempts. Вызывается планировщиком каждые outboxPollMs.
   */
  async pollOnce(): Promise<PollReport> {
    if (this.polling) return { ...EMPTY_REPORT, skipped: true };
    this.polling = true;
    const started = Date.now();
    try {
      // Чтение — через корневые репозитории (отдельное reader-соединение, D196):
      // SELECT не блокирует писателей и не занимает мьютекс.
      const batch = await this.uow.repos().outbox.listPending(this.batchSize);
      let report: PollReport = EMPTY_REPORT;
      for (const record of batch) {
        const outcome = await this.publishRecord(record);
        report = {
          scanned: report.scanned + 1,
          published: report.published + (outcome === 'published' ? 1 : 0),
          failed: report.failed + (outcome === 'failed' || outcome === 'dead' ? 1 : 0),
          dead: report.dead + (outcome === 'dead' ? 1 : 0),
          skipped: false,
        };
      }
      if (report.scanned > 0) {
        this.metrics?.timing('outbox.poll_duration_ms', Date.now() - started);
        this.logger?.debug({ ...report }, 'outbox_poll');
      }
      return report;
    } finally {
      this.polling = false;
    }
  }

  /**
   * Принудительная публикация остатка — вызывается при graceful shutdown ПОСЛЕ
   * остановки планировщика и ДО закрытия БД (промпт 1.5, п.2).
   *
   * Проходы повторяются, пока есть PENDING и прогресс (published > 0). Записи,
   * которые продолжают падать, остаются PENDING — они будут повторно доставлены
   * после рестарта (at-least-once), вместо того чтобы сжечь все попытки при
   * остановке и преждевременно уйти в DEAD.
   */
  async drain(maxPasses = 10): Promise<PollReport> {
    const total = { scanned: 0, published: 0, failed: 0, dead: 0 };
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const r = await this.pollOnce();
      total.scanned += r.scanned;
      total.published += r.published;
      total.failed += r.failed;
      total.dead += r.dead;
      if (r.scanned === 0 || r.published === 0) break;
    }
    return { ...total, skipped: false };
  }

  private async publishRecord(record: OutboxRecord): Promise<'published' | 'failed' | 'dead'> {
    // 1. Реконструкция + валидация (инвариант 16). Отравленная запись → сбой доставки.
    let event: DomainEvent;
    try {
      event = eventFromOutboxRecord(record);
    } catch (err: unknown) {
      return this.registerFailure(record, err);
    }

    // 2. Рассылка ВНЕ транзакции. bus.publish бросает только на невалидной схеме
    // (мы уже распарсили — практически невозможно); сбои обработчиков — в report.failed.
    let report: PublishReport;
    try {
      report = await this.bus.publish(event);
    } catch (err: unknown) {
      return this.registerFailure(record, err);
    }
    if (report.failed > 0) {
      const detail = report.errors.length > 0 ? `: ${report.errors.join('; ')}` : '';
      return this.registerFailure(
        record,
        `${report.failed}/${report.dispatched} обработчик(ов) упали (timedOut=${report.timedOut})${detail}`,
      );
    }

    // 3. Успех: короткая транзакция под мьютексом (D196) — status=PUBLISHED, published_at.
    //    Крах МЕЖДУ рассылкой и отметкой → повторная доставка (at-least-once, D113).
    const atIso = nowIso();
    await this.uow.runInTx(async (scope) => {
      await scope.repos.outbox.markPublished(record.id, atIso);
    });
    this.metrics?.counter('outbox.published', 1, { eventName: record.eventName });
    return 'published';
  }

  /** attempts+1 (+DEAD при исчерпании лимита). dead = attempts(после инкремента) >= maxAttempts (D210). */
  private async registerFailure(record: OutboxRecord, err: unknown): Promise<'failed' | 'dead'> {
    const message = err instanceof Error ? err.message : String(err);
    const attemptsAfter = record.attempts + 1;
    const dead = attemptsAfter >= this.maxAttempts;
    await this.uow.runInTx(async (scope) => {
      await scope.repos.outbox.registerFailure(record.id, message, dead);
    });
    if (dead) {
      this.metrics?.counter('outbox.dead', 1, { eventName: record.eventName });
      this.logger?.error(
        { outboxId: record.id, eventName: record.eventName, attempts: attemptsAfter, err, traceId: record.traceId },
        'outbox_record_dead',
      );
      return 'dead';
    }
    this.metrics?.counter('outbox.retry', 1, { eventName: record.eventName });
    this.logger?.warn(
      { outboxId: record.id, eventName: record.eventName, attempts: attemptsAfter, err, traceId: record.traceId },
      'outbox_delivery_failed',
    );
    return 'failed';
  }
}
