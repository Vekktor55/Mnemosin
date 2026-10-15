/**
 * Token bucket (промпт 1.9, п.2): rate limit публичных сообщений чата.
 *
 * Ёмкость = publicPerSecond * burstSeconds (default 1с запаса); пополнение —
 * непрерывно по elapsed. Ключ ведра — `${sessionId}:${playerId}` (лимит на игрока
 * в партии). Время инжектируется (now) — детерминированные тесты.
 *
 * Этап 1: ведра в памяти процесса (одна активная сессия, D108). Транспортный
 * rate limit WS-соединения (wsRatePerConnection.CHAT_PUBLIC) — отдельный контур
 * промпта 1.11; сервисный bucket защищает БД и шину даже от корректного,
 * но слишком частого клиента.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; refilledAt: number }>();

  constructor(
    private readonly ratePerSecond: number,
    private readonly capacity: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Пытается списать cost токенов; false — лимит исчерпан (RATE_LIMIT). */
  tryConsume(key: string, cost = 1): boolean {
    const at = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, refilledAt: at };
    const elapsedSeconds = Math.max(0, (at - bucket.refilledAt) / 1000);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.ratePerSecond);
    bucket.refilledAt = at;
    if (bucket.tokens < cost) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= cost;
    this.buckets.set(key, bucket);
    return true;
  }

  /** Сброс ведра (тесты/миграция сессии). */
  reset(key?: string): void {
    if (key === undefined) this.buckets.clear();
    else this.buckets.delete(key);
  }
}
