import {
  JournalEntrySchema,
  nowIso,
  type JournalEntry,
  type JournalKind,
  type SessionId,
  type TurnId,
} from '@mnemosin/contracts';
import type { JournalDraft, TxScope, UnitOfWork } from '../domain/ports/index.js';

/**
 * JournalService — журнал хода (v3 §III.3, §II.18; промпт 1.5).
 *
 * Журнал — append-only хронология шагов обработки хода (`JournalKind`:
 * turn_opened → … → committed/failed). Назначение:
 *  - аудит и диагностика (каждый шаг несёт traceId, v3 §VIII.4);
 *  - восстановление после сбоя: `reconciled_on_boot` сверяется с последним id
 *    (journal.lastId) в промпте 1.8.
 *
 * Запись обязана идти В ТОЙ ЖЕ транзакции, что и фиксируемый шаг: для этого
 * `append` принимает опциональный `TxScope`. Без scope запись идёт через
 * `uow.repos()` (присоединяется к активной транзакции ALS, если она есть,
 * иначе — одиночная запись).
 *
 * Чтение (`list`, `tail`) дополнительно прогоняет каждую строку через
 * JournalEntrySchema (инвариант 16 на границе чтения; маппер БД парсит тоже —
 * двойная защита от порчи body_json).
 */

export interface JournalAppendInput {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly kind: JournalKind;
  readonly payload?: Record<string, unknown>;
  readonly traceId: string;
  readonly createdAt?: string;
}

export class JournalService {
  constructor(private readonly uow: UnitOfWork) {}

  /**
   * append(turnId, kind, payload, traceId, tx) из промпта 1.5 — в форме объекта:
   * схема journal_entries требует ещё и sessionId (FK на sessions), поэтому он
   * часть входа (данных не хватает — не изобретаем: поле объявлено в 1.4).
   */
  async append(input: JournalAppendInput, scope?: TxScope): Promise<JournalEntry> {
    const draft: JournalDraft = {
      turnId: input.turnId,
      sessionId: input.sessionId,
      traceId: input.traceId.slice(0, 64),
      kind: input.kind,
      payload: input.payload ?? {},
      createdAt: input.createdAt ?? nowIso(),
    };
    const repos = scope?.repos ?? this.uow.repos();
    const entry = await repos.journal.append(draft);
    return JournalEntrySchema.parse(entry);
  }

  /** Все записи хода по порядку id (парсинг через JournalEntrySchema). */
  async list(turnId: TurnId): Promise<JournalEntry[]> {
    const entries = await this.uow.repos().journal.listByTurn(turnId);
    return entries.map((entry) => JournalEntrySchema.parse(entry));
  }

  /** Последние `limit` записей сессии в хронологическом порядке (по возрастанию id). */
  async tail(sessionId: SessionId, limit = 100): Promise<JournalEntry[]> {
    const entries = await this.uow.repos().journal.listBySession(sessionId, limit);
    return entries.map((entry) => JournalEntrySchema.parse(entry));
  }

  /** Последний записанный id сессии — для reconciled_on_boot (промпт 1.8). */
  async lastId(sessionId: SessionId): Promise<number> {
    return this.uow.repos().journal.lastId(sessionId);
  }
}
