import type { DomainEvent, EventName } from '@mnemosin/contracts';

/**
 * EventBus — порт доменной шины событий (v3 §III.3, §II.16; промпт 1.5).
 *
 * Реализация — `InProcessEventBus` в `core/events/bus.ts` (один процесс, D108).
 * Порт объявлен здесь, чтобы инфраструктура (outbox-публикатор) и модули зависели
 * от интерфейса, а не от реализации (правило слоя из промпта 1.3: инфраструктура
 * импортирует core ТОЛЬКО через `@mnemosin/core/domain/ports`).
 *
 * Семантика доставки — D113 (at-least-once):
 *  - событие, опубликованное через outbox, может быть доставлено обработчикам
 *    БОЛЕЕ ОДНОГО раза (повтор при сбое обработчика, рестарт процесса);
 *  - обработчики ОБЯЗАНЫ быть идемпотентными;
 *  - порядок доставки одного публикатора — глобальный по id записи outbox.
 */

/** Обработчик события. Может быть синхронным или async. */
export type EventHandler = (event: DomainEvent) => void | Promise<void>;

/** Функция отписки, возвращаемая subscribe(). */
export type Unsubscribe = () => void;

/**
 * Отчёт о публикации ОДНОГО события.
 *
 * `failed` включает ошибки обработчиков И таймауты (`timedOut` — их подмножество).
 * Публикатор outbox использует `failed > 0` как сигнал «событие не обработано —
 * нужна повторная доставка» (attempts+1); см. D209.
 */
export interface PublishReport {
  readonly type: EventName;
  /** Сколько обработчиков было вызвано (включая упавшие и отвалившиеся по таймауту). */
  readonly dispatched: number;
  /** Сколько вызовов завершились ошибкой или таймаутом. */
  readonly failed: number;
  /** Подмножество failed: превышен handlerTimeoutMs. */
  readonly timedOut: number;
  /**
   * Сообщения ошибок обработчиков (первые 3, каждое ≤ 200 символов) — для
   * lastError в event_outbox и диагностики. Без содержимого payload'ов.
   */
  readonly errors: readonly string[];
}

export interface EventBus {
  /**
   * Подписка на событие конкретного типа ИЛИ на все события ('*').
   * Обработчики вызываются последовательно в порядке регистрации (D209).
   */
  subscribe(eventName: EventName | '*', handler: EventHandler): Unsubscribe;

  /**
   * Публикация события.
   *
   * Инвариант 16: payload ПЕРЕД рассылкой проходит `DomainEventSchema.parse`;
   * невалидное событие бросает ошибку (AppError 'VALIDATION') и НЕ публикуется.
   *
   * Исключение в обработчике НЕ ломает остальные и НЕ бросается вызывающему —
   * оно логируется и отражается в `PublishReport.failed`. Бросается publish
   * только на невалидном событии.
   */
  publish(event: DomainEvent): Promise<PublishReport>;

  /** Публикация серии событий строго по порядку (порядок массива сохраняется). */
  publishMany(events: readonly DomainEvent[]): Promise<PublishReport[]>;
}
