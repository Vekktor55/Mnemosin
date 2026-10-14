import {
  AppError,
  DomainEventSchema,
  nowIso,
  type DomainEvent,
  type EventName,
  type EventPayload,
  type OutboxRecord,
} from '@mnemosin/contracts';
import type { OutboxDraft, TxScope } from '../domain/ports/index.js'; /**
 * Запись доменных событий в outbox (v3 §III.3; промпт 1.5).
 *
 * Главное правило: `appendOutbox(events, scope)` вызывается ВНУТРИ той же транзакции,
 * что и доменная мутация. Следствия (D113):
 *  - транзакция откатилась → события не существует (публиковать нечего);
 *  - транзакция закоммичена → событие ОБЯЗАНО быть опубликовано (at-least-once):
 *    публикатор поднимет его из event_outbox даже после краха процесса;
 *  - долгие операции (AI, media, WS-рассылка) никогда не попадают в транзакцию —
 *    они выполняются обработчиками УЖЕ опубликованного события.
 *
 * Инвариант 16: каждое событие валидируется DomainEventSchema ДО записи —
 * невалидное событие не попадает в outbox вовсе (иначе публикатор получил бы
 * отравленное сообщение).
 */

/**
 * Фабрика валидного DomainEvent: собирает конверт и прогоняет его через схему.
 * Бренды id (SessionId, TurnId, …) вызывают `as SessionId` на месте создания —
 * здесь проверка формы и содержимого payload.
 */
export function createEvent<T extends EventName>(
  type: T,
  payload: EventPayload<T>,
  traceId: string,
  emittedAt: string = nowIso(),
): DomainEvent {
  const candidate = { type, payload, traceId: traceId.slice(0, 64), emittedAt };
  const parsed = DomainEventSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new AppError('VALIDATION', `createEvent: payload ${type} не прошёл DomainEventSchema`, {
      issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  return parsed.data;
}

/** Преобразование DomainEvent → черновик строки event_outbox. */
export function toOutboxDraft(event: DomainEvent): OutboxDraft {
  return {
    eventName: event.type,
    // payloadJson — строка (контракт OutboxRecord.payloadJson: z.string(), схема БД — text).
    payloadJson: JSON.stringify(event.payload),
    traceId: event.traceId,
    emittedAt: event.emittedAt,
  };
}

/**
 * Обратное преобразование (строка outbox → DomainEvent) живёт в адаптере
 * (infrastructure/database/outbox-publisher.ts): ядро не читает outbox,
 * оно только пишет в него внутри транзакции. Граница 1.3: инфраструктура
 * импортирует core только через domain/ports (D211).
 */

/**
 * Записать события в event_outbox ВНУТРЕННЕЙ транзакции (вместе с доменной мутацией).
 *
 * @param events валидные доменные события (createEvent или DomainEventSchema.parse);
 * @param scope  TxScope активной транзакции — запись идёт через `scope.repos.outbox`,
 *               поэтому commit/rollback транзакции решает судьбу событий атомарно.
 */
export async function appendOutbox(events: readonly DomainEvent[], scope: TxScope): Promise<OutboxRecord[]> {
  if (events.length === 0) return [];
  // Валидация ДО записи: частичный append невалидной серии невозможен (инвариант 16).
  const drafts = events.map((event) => toOutboxDraft(DomainEventSchema.parse(event)));
  return scope.repos.outbox.appendMany(drafts);
}
