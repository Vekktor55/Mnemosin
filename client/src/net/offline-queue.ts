/**
 * Offline-очередь исходящих WS-сообщений (промпт 1.12, п.2; SPEC §6.4, A1.9).
 *
 * Хранилище: localStorage, ключ `mnemosin:pending:<playerId>` (D126:
 * localStorage разрешён ТОЛЬКО для очереди сообщений — не для токенов).
 * В очереди — сообщения с idempotencyKey и/или requestId; при реконнекте они
 * переотправляются КАК ЕСТЬ (те же ключи) — сервер дедуплицирует по requestId
 * (доставка) и по idempotencyKey (эффект), поэтому повтор безопасен.
 * Удаление — по ack (ACTION_ACK / CHAT_ACK / GM_ACTION_ACK / GM_NOTE_ACK) или
 * по доменному ERROR (кроме «повторяемых» RATE_LIMIT / IDEMPOTENCY_IN_FLIGHT —
 * они остаются в очереди до успешной доставки).
 */

/** Минимальный интерфейс Storage (браузерный localStorage или тестовый fake). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Сохранённое сообщение: envelope как отправлен + метка времени. */
export interface QueuedEnvelope {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly requestId?: string;
  readonly queuedAt: string;
}

export function pendingKey(playerId: string): string {
  return `mnemosin:pending:${playerId}`;
}

/** Ошибки, после которых сообщение остаётся в очереди (транспортные/временные). */
const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set(['RATE_LIMIT', 'IDEMPOTENCY_IN_FLIGHT']);

export function isRetryableErrorCode(code: string): boolean {
  return RETRYABLE_ERROR_CODES.has(code);
}

/** В очередь кладутся только сообщения с requestId или idempotencyKey (SPEC §6.4). */
export function shouldPersist(type: string, payload: Record<string, unknown>): boolean {
  const hasIdempotencyKey = typeof payload['idempotencyKey'] === 'string';
  const hasRequestId = typeof payload['requestId'] === 'string';
  // PING/LEAVE/AUTH/HISTORY — служебные, эффект не меняют: не персистируем.
  const transient =
    type === 'PING' || type === 'LEAVE' || type === 'AUTH' || type === 'HISTORY' || type === 'SUBSCRIBE';
  return !transient && (hasIdempotencyKey || hasRequestId);
}

export class OfflineQueue {
  private readonly storage: StorageLike | null;

  constructor(storage?: StorageLike | null) {
    if (storage !== undefined) {
      this.storage = storage;
      return;
    }
    try {
      this.storage = typeof localStorage !== 'undefined' ? localStorage : null;
    } catch {
      this.storage = null;
    }
  }

  list(playerId: string): QueuedEnvelope[] {
    if (this.storage === null) return [];
    try {
      const raw = this.storage.getItem(pendingKey(playerId));
      if (raw === null) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is QueuedEnvelope => typeof item === 'object' && item !== null);
    } catch {
      return [];
    }
  }

  push(playerId: string, envelope: QueuedEnvelope): void {
    if (this.storage === null) return;
    const next = [...this.list(playerId).filter((item) => item.requestId !== envelope.requestId), envelope];
    this.write(playerId, next);
  }

  removeByRequestId(playerId: string, requestId: string): void {
    if (this.storage === null) return;
    const next = this.list(playerId).filter((item) => item.requestId !== requestId);
    this.write(playerId, next);
  }

  clear(playerId: string): void {
    if (this.storage === null) return;
    try {
      this.storage.removeItem(pendingKey(playerId));
    } catch {
      /* игнор: приватный режим */
    }
  }

  private write(playerId: string, items: QueuedEnvelope[]): void {
    if (this.storage === null) return;
    try {
      if (items.length === 0) {
        this.storage.removeItem(pendingKey(playerId));
        return;
      }
      this.storage.setItem(pendingKey(playerId), JSON.stringify(items));
    } catch {
      /* переполнение/приватный режим: очередь best-effort, отправка не блокируется */
    }
  }
}
