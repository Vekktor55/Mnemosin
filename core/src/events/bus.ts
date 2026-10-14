import { AppError, DomainEventSchema, type DomainEvent, type EventName } from '@mnemosin/contracts';
import type { EventBus, EventHandler, MetricsSink, PublishReport, Unsubscribe } from '../domain/ports/index.js';

/**
 * InProcessEventBus — доменная шина событий одного процесса (v3 §III.3; промпт 1.5).
 *
 * Правила (D113, D209):
 *  - publish() ПЕРЕД рассылкой прогоняет событие через DomainEventSchema (инвариант 16):
 *    невалидный payload → AppError('VALIDATION'), событие НЕ публикуется;
 *  - обработчики вызываются ПОСЛЕДОВАТЕЛЬНО в порядке регистрации (общий список
 *    для конкретных типов и '*', фильтр по совпадению);
 *  - исключение в одном обработчике НЕ ломает остальные: логируется (error, с traceId
 *    и именем события), учитывается в PublishReport.failed;
 *  - async-обработчик ограничен handlerTimeoutMs (config limits, default 5000):
 *    по таймауту — log error и продолжение. Прервать висящий обработчик нельзя —
 *    он может дописать эффекты ПОСЛЕ таймаута, поэтому обработчики обязаны быть
 *    идемпотентными (D113);
 *  - publishMany() сохраняет порядок серии.
 *
 * Шина НЕ знает про outbox: персистентность и at-least-once обеспечивает OutboxPublisher
 * (infrastructure/database), который читает PublishReport и ретраит событие целиком.
 */

/** Минимальный структурный интерфейс логгера: core не импортирует pino (инвариант 2). */
export interface EventLog {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export interface EventBusOptions {
  /** Таймаут одного async-обработчика (limits.handlerTimeoutMs, default 5000). */
  readonly handlerTimeoutMs?: number;
  readonly logger?: EventLog;
  readonly metrics?: MetricsSink;
}

export const DEFAULT_HANDLER_TIMEOUT_MS = 5000;

interface HandlerEntry {
  readonly matcher: EventName | '*';
  readonly handler: EventHandler;
}

/** Ошибка таймаута обработчика — внутренняя, наружу уходит текстом в логе и report.timedOut. */
class HandlerTimeoutError extends Error {
  constructor(
    readonly eventName: string,
    readonly timeoutMs: number,
  ) {
    super(`обработчик события ${eventName} не завершился за ${timeoutMs} мс`);
    this.name = 'HandlerTimeoutError';
  }
}

export class InProcessEventBus implements EventBus {
  private readonly handlers: HandlerEntry[] = [];
  private readonly handlerTimeoutMs: number;
  private readonly logger: EventLog | undefined;
  private readonly metrics: MetricsSink | undefined;

  constructor(options: EventBusOptions = {}) {
    this.handlerTimeoutMs = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
    this.logger = options.logger;
    this.metrics = options.metrics;
  }

  subscribe(eventName: EventName | '*', handler: EventHandler): Unsubscribe {
    const entry: HandlerEntry = { matcher: eventName, handler };
    this.handlers.push(entry);
    let active = true;
    return () => {
      if (!active) return; // повторная отписка — no-op (идемпотентность)
      active = false;
      const index = this.handlers.indexOf(entry);
      if (index >= 0) this.handlers.splice(index, 1);
    };
  }

  async publish(event: DomainEvent): Promise<PublishReport> {
    // Инвариант 16: невалидное событие не публикуется. Ошибка пробрасывается вызывающему
    // (публикатор outbox трактует её как отравленное сообщение → attempts/DEAD).
    const parsed = DomainEventSchema.safeParse(event);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`);
      throw new AppError('VALIDATION', 'DomainEvent не прошёл DomainEventSchema (инвариант 16)', {
        issues,
        ...(typeof (event as { type?: unknown })?.type === 'string' ? { type: (event as { type: string }).type } : {}),
      });
    }
    const started = Date.now();
    const report = await this.dispatch(parsed.data);
    this.metrics?.timing('events.dispatch.duration_ms', Date.now() - started, { type: report.type });
    this.metrics?.counter('events.published', 1, { type: report.type });
    if (report.failed > 0) this.metrics?.counter('events.handler_failed', report.failed, { type: report.type });
    return report;
  }

  async publishMany(events: readonly DomainEvent[]): Promise<PublishReport[]> {
    const reports: PublishReport[] = [];
    // Строго последовательно: порядок серии — часть контракта доставки (D113).
    for (const event of events) reports.push(await this.publish(event));
    return reports;
  }

  /** Рассылка прошедшего валидацию события: последовательно, с изоляцией сбоев. */
  private async dispatch(event: DomainEvent): Promise<PublishReport> {
    // Копия списка: subscribe/unsubscribe во время рассылки не ломают итерацию.
    const matching = this.handlers.filter((entry) => entry.matcher === '*' || entry.matcher === event.type);
    let dispatched = 0;
    let failed = 0;
    let timedOut = 0;
    const errors: string[] = [];

    for (const entry of matching) {
      dispatched += 1;
      try {
        await this.runWithTimeout(entry.handler, event);
      } catch (err: unknown) {
        failed += 1;
        if (err instanceof HandlerTimeoutError) timedOut += 1;
        if (errors.length < 3) errors.push((err instanceof Error ? err.message : String(err)).slice(0, 200));
        this.metrics?.counter('events.handler_error', 1, { type: event.type });
        // Исключение обработчика не ломает остальные (промпт 1.5, п.1).
        this.logger?.error(
          { err, event: event.type, traceId: event.traceId, timedOut: err instanceof HandlerTimeoutError },
          'event_handler_failed',
        );
      }
    }
    return { type: event.type, dispatched, failed, timedOut, errors };
  }

  private async runWithTimeout(handler: EventHandler, event: DomainEvent): Promise<void> {
    // Гонка: обработчик против таймера. Проигравший таймер гасится в finally.
    const work: Promise<void> = Promise.resolve().then(() => handler(event));
    // Страховка: если обработчик отвалится ПОСЛЕ таймаута, его reject не должен
    // становиться unhandledRejection (main.ts на нём.exit(1)).
    work.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new HandlerTimeoutError(event.type, this.handlerTimeoutMs)),
            this.handlerTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
