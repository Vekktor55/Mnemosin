import type { DomainEvent, GmAuditEntry, GmActionKind, SessionId } from '@mnemosin/contracts';
import type { UnitOfWork } from '@mnemosin/core';

import {
  DECISION_TO_ACTION,
  ListAuditInputSchema,
  ListAuditOutputSchema,
  type ListAuditInput,
  type ListAuditOutput,
} from './contract.js';

/**
 * GmAuditService (v3 §IV.11; промпт 1.9, п.7).
 *
 * Append-only аудит: подписчик GM_ACTION_PERFORMED и GM_REVIEW_DECIDED пишет
 * строку gm_audit на КАЖДОЕ действие GM. Модуль ничего не мутирует в GameState
 * (тест промта 1.9 п.9) и ничего не обновляет в gm_audit (append-only).
 *
 * Идемпотентность (at-least-once, D113): повторная доставка события с тем же
 * (traceId, action, gmPlayerId) пропускается — дубль строки не пишется (D250).
 */

export interface GmAuditLog {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export interface GmAuditDeps {
  readonly uow: UnitOfWork;
  readonly logger?: GmAuditLog;
}

/** Окно дедупликации: последние N записей сессии (этап 1 — одна сессия, D108). */
const DEDUPE_WINDOW = 500;

export class GmAuditService {
  constructor(private readonly deps: GmAuditDeps) {}

  /** Обработчик шины: GM_ACTION_PERFORMED | GM_REVIEW_DECIDED → строка gm_audit. */
  async onEvent(event: DomainEvent): Promise<void> {
    if (event.type === 'GM_ACTION_PERFORMED') {
      const payload = event.payload;
      await this.append({
        sessionId: payload.sessionId,
        gmPlayerId: payload.gmPlayerId,
        action: payload.action,
        meta: payload.meta,
        traceId: event.traceId,
        idempotencyKey: payload.idempotencyKey,
        at: event.emittedAt,
      });
      return;
    }
    if (event.type === 'GM_REVIEW_DECIDED') {
      const payload = event.payload;
      const action = DECISION_TO_ACTION[payload.decision] as GmActionKind;
      await this.append({
        sessionId: payload.sessionId,
        gmPlayerId: payload.gmPlayerId,
        action,
        meta: { turnId: payload.turnId, decision: payload.decision },
        traceId: event.traceId,
        idempotencyKey: null,
        at: event.emittedAt,
      });
    }
  }

  /** Лента аудита для GET /gm/audit (1.10); свежие сверху (репозиторий: auditId DESC). */
  async listAudit(rawInput: ListAuditInput): Promise<ListAuditOutput> {
    const input = ListAuditInputSchema.parse(rawInput);
    const limit = input.limit;
    const entries = await this.deps.uow.repos().gmAudit.listBySession(input.sessionId, Math.min(1000, limit * 2));
    const since = input.since;
    const filtered = since !== undefined ? entries.filter((entry) => entry.at > since) : entries;
    return ListAuditOutputSchema.parse(filtered.slice(0, limit));
  }

  private async append(entry: Omit<GmAuditEntry, 'auditId'>): Promise<void> {
    try {
      if (await this.isDuplicate(entry)) {
        this.deps.logger?.debug(
          { action: entry.action, traceId: entry.traceId, event: 'gm_audit_duplicate_skipped' },
          'gm_audit_duplicate_skipped',
        );
        return;
      }
      await this.deps.uow.repos().gmAudit.append(entry);
    } catch (cause) {
      // Отказ записи аудита не должен ронять обработчик бесконечным ретраем
      // outbox-публикатора: логируем и считаем обработанным (диагностика, не домен).
      this.deps.logger?.error(
        { err: cause, action: entry.action, event: 'gm_audit_append_failed' },
        'gm_audit_append_failed',
      );
    }
  }

  private async isDuplicate(entry: Omit<GmAuditEntry, 'auditId'>): Promise<boolean> {
    const recent = await this.deps.uow.repos().gmAudit.listBySession(entry.sessionId as SessionId, DEDUPE_WINDOW);
    return recent.some(
      (candidate) =>
        candidate.traceId === entry.traceId &&
        candidate.action === entry.action &&
        candidate.gmPlayerId === entry.gmPlayerId,
    );
  }
}
