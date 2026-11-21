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
 * JournalService — журнал событий (v4: сессионный, не привязанный к ходам).
 *
 * Журнал — append-only хронология событий сессии. Назначение:
 *  - аудит и диагностика (каждый шаг несёт traceId);
 *  - восстановление после сбоя: `reconciled_on_boot` сверяется с последним id
 *    (journal.lastId).
 *
 * Запись обязана идти В ТОЙ ЖЕ транзакции, что и фиксируемый шаг: для этого
 * `append` принимает опциональный `TxScope`. Без scope запись идёт через
 * `uow.repos()` (присоединяется к активной транзакции ALS, если она есть,
 * иначе — одиночная запись).
 *
 * turnId теперь опционален (nullable) для совместимости с v4 архитектурой
 * без Turn Engine.
 */

export interface JournalAppendInput {
  readonly sessionId: SessionId;
  readonly turnId: TurnId | null;
  readonly kind: JournalKind;
  readonly payload?: Record<string, unknown>;
  readonly traceId: string;
  readonly createdAt?: string;
}

export class JournalService {
  constructor(private readonly uow: UnitOfWork) {}

  /**
   * append(input, scope?) — запись события в журнал сессии.
   * turnId теперь опционален (nullable).
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

  /** Все записи сессии по порядке id (парсинг через JournalEntrySchema). */
  async listBySession(sessionId: SessionId, limit = 100): Promise<JournalEntry[]> {
    const entries = await this.uow.repos().journal.listBySession(sessionId, limit);
    return entries.map((entry) => JournalEntrySchema.parse(entry));
  }

  /** Последние `limit` записей сессии в хронологическом порядке (по возрастанию id). */
  async tail(sessionId: SessionId, limit = 100): Promise<JournalEntry[]> {
    const entries = await this.uow.repos().journal.listBySession(sessionId, limit);
    return entries.map((entry) => JournalEntrySchema.parse(entry));
  }

  /** Последний записанный id сессии — для reconciled_on_boot. */
  async lastId(sessionId: SessionId): Promise<number> {
    return this.uow.repos().journal.lastId(sessionId);
  }
}
