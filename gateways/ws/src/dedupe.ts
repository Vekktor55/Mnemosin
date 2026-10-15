/**
 * Дедупликация по requestId (промпт 1.11, п.4; F-6.7).
 *
 * LRU-кэш requestId → сохранённый ответ с TTL dedupeTtlMs (300 000). Повторный
 * requestId (в том числе после реконнекта — offline-queue клиента, A1.9)
 * возвращает ПРЕЖНИЙ ack без повторного выполнения команды.
 *
 * D272: кэш in-memory, per-server. После рестарта процесса защита от повторов
 * обеспечивается durable-идемпотентностью модулей (idempotencyKey, D113/B-08):
 * команда с тем же ключом возвращает replayed-результат. Кэш — быстрый путь
 * и защита от гонок внутри живого процесса.
 *
 * Ключ — `${playerId}:${requestId}`: requestId клиента уникален только в
 * пределах клиента, меж-игроковые коллизии не должны давать чужие ack'и.
 */

export interface DedupeEntry<T> {
  readonly response: T;
  readonly at: number;
}

export class RequestDedupeCache<T> {
  private readonly entries = new Map<string, DedupeEntry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  static key(playerId: string, requestId: string): string {
    return `${playerId}:${requestId}`;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (this.now() - entry.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    // LRU: повторное обращение переносит запись в конец Map (порядок вставки).
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.response;
  }

  set(key: string, response: T): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { response, at: this.now() });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === false) this.entries.delete(oldest.value);
    }
  }

  /** Чистка истёкших (вызывается из presenceSweep-джоба, чтобы кэш не рос). */
  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (now - entry.at > this.ttlMs) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.entries.size;
  }
}
