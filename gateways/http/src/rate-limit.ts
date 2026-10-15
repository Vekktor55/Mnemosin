import { createHash } from 'node:crypto';

import { AppError } from '@mnemosin/contracts';

/**
 * Per-token rate limit (промпт 1.10, п.4): фиксированное минутное окно на
 * ключ (hash токена). Глобальный per-IP лимит и лимит /auth/* — на стороне
 * @fastify/rate-limit (конфиг маршрутов в routes.ts); здесь — два контура,
 * которые плагин не покрывает:
 *  - 300 req/min на токен (httpRateTokenPerMin);
 *  - 30 req/min на токен для мутирующих turn-маршрутов (httpRateMutatingPerTokenPerMin).
 *
 * Превышение → AppError('RATE_LIMIT') c meta.retryAfterSeconds — error-handler
 * превращает его в 429 + Retry-After. Хранилище — в памяти (один процесс, D108).
 */

interface WindowBucket {
  minute: number;
  count: number;
}

export class TokenRateLimiter {
  private readonly buckets = new Map<string, WindowBucket>();

  constructor(
    private readonly tokenPerMinute: number,
    private readonly mutatingTurnPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Ключ ведра — hash токена (сам токен в память не сохраняем). */
  static keyOf(authorizationHeader: string): string {
    return createHash('sha1').update(authorizationHeader).digest('hex');
  }

  checkToken(key: string): void {
    this.check(key, this.tokenPerMinute, 'token');
  }

  checkMutatingTurn(key: string): void {
    this.check(`${key}:turn`, this.mutatingTurnPerMinute, 'turn_mutating');
  }

  private check(bucketKey: string, limit: number, scope: string): void {
    const at = this.now();
    const minute = Math.floor(at / 60_000);
    const bucket = this.buckets.get(bucketKey);
    if (bucket === undefined || bucket.minute !== minute) {
      this.buckets.set(bucketKey, { minute, count: 1 });
      return;
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((minute * 60_000 + 60_000 - at) / 1000));
      throw new AppError('RATE_LIMIT', `превышен лимит запросов (${scope}: ${limit}/мин)`, {
        scope,
        limit,
        retryAfterSeconds,
      });
    }
  }

  /** Очистка окон старше двух минут (вызывается периодически/в тестах). */
  sweep(): void {
    const minute = Math.floor(this.now() / 60_000);
    for (const [key, bucket] of this.buckets) {
      if (bucket.minute < minute - 1) this.buckets.delete(key);
    }
  }
}
