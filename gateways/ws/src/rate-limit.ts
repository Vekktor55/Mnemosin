import type { WSClientType } from '@mnemosin/contracts';

/**
 * Rate limit per connection (промпт 1.11, п.4): token bucket на класс
 * сообщения из limits.wsRatePerConnection — ACTION_SUBMIT 5/с, CHAT_PUBLIC
 * 10/с, остальные (DEFAULT) 20/с. Превышение → ERROR{code:'RATE_LIMIT'}
 * (SENDER_ONLY), соединение остаётся живым.
 *
 * CHAT_PRIVATE тарифицируется как DEFAULT (20/с): частный канал защищён
 * ещё и token bucket'ом модуля chat на публичные (chat.publicPerSecond);
 * приватные в этапе 1 не лимитируются отдельным bucket'ом (D260-контекст).
 *
 * Bucket непрерывного пополнения: capacity = rate (burst 1 секунда),
 * пополнение rate токенов/с; tryConsume считает по elapsed с прошлого вызова.
 */

export interface WsRateConfig {
  readonly ACTION_SUBMIT: number;
  readonly CHAT_PUBLIC: number;
  readonly DEFAULT: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class ConnectionRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly rates: WsRateConfig,
    private readonly now: () => number = Date.now,
  ) {}

  private rateOf(type: WSClientType | string): number {
    if (type === 'ACTION_SUBMIT') return this.rates.ACTION_SUBMIT;
    if (type === 'CHAT_PUBLIC') return this.rates.CHAT_PUBLIC;
    return this.rates.DEFAULT;
  }

  tryConsume(type: WSClientType | string): boolean {
    const rate = this.rateOf(type);
    const at = this.now();
    let bucket = this.buckets.get(type);
    if (bucket === undefined) {
      bucket = { tokens: rate, lastRefill: at };
      this.buckets.set(type, bucket);
    }
    const elapsedSeconds = Math.max(0, (at - bucket.lastRefill) / 1000);
    bucket.tokens = Math.min(rate, bucket.tokens + elapsedSeconds * rate);
    bucket.lastRefill = at;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}
