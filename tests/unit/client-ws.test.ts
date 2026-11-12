import { describe, expect, it } from 'vitest';

import {
  backoffDelayMs,
  backoffDelayWith,
  DEFAULT_HEARTBEAT_LIMITS,
  DEFAULT_RECONNECT_LIMITS,
  OfflineQueue,
  pendingKey,
  shouldPersist,
  isRetryableErrorCode,
  type StorageLike,
} from '@mnemosin/client';

/**
 * Клиентские инварианты промта 1.12 (п.2): backoff-параметры зеркалируют
 * config/limits.yaml, offline-очередь хранит/удаляет сообщения по requestId.
 */

/** In-memory Storage (эмуляция localStorage для node-окружения vitest). */
class FakeStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
}

describe('reconnect backoff (промпт 1.12, п.2; SPEC §6.4)', () => {
  it('дефолты зеркалируют config/limits.yaml', () => {
    expect(DEFAULT_RECONNECT_LIMITS).toEqual({ baseMs: 500, factor: 2, capMs: 15_000, jitter: 0.2, maxAttempts: 8 });
    expect(DEFAULT_HEARTBEAT_LIMITS).toEqual({ intervalMs: 20_000, idleTimeoutMs: 45_000 });
  });

  it('экспоненциальный рост с cap 15000 и jitter ±20%', () => {
    // Без джиттера (random=0.5 → множитель 0): base * factor^(n-1), cap 15000.
    expect(backoffDelayWith(1, 0.5)).toBe(500);
    expect(backoffDelayWith(2, 0.5)).toBe(1000);
    expect(backoffDelayWith(3, 0.5)).toBe(2000);
    expect(backoffDelayWith(4, 0.5)).toBe(4000);
    expect(backoffDelayWith(5, 0.5)).toBe(8000);
    expect(backoffDelayWith(6, 0.5)).toBe(15_000); // 16000 → cap
    expect(backoffDelayWith(7, 0.5)).toBe(15_000);
    expect(backoffDelayWith(8, 0.5)).toBe(15_000);
  });

  it('jitter не выходит за ±20% от базовой задержки', () => {
    for (const attempt of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const raw = Math.min(15_000, 500 * Math.pow(2, attempt - 1));
      const low = backoffDelayWith(attempt, 0);
      const high = backoffDelayWith(attempt, 1);
      expect(low).toBe(Math.max(0, Math.round(raw * 0.8)));
      expect(high).toBe(Math.round(raw * 1.2));
      // Случайный джиттер — в тех же границах.
      for (let i = 0; i < 50; i += 1) {
        const value = backoffDelayMs(attempt);
        expect(value).toBeGreaterThanOrEqual(low);
        expect(value).toBeLessThanOrEqual(high);
      }
    }
  });

  it('суммарное окно 8 попыток ≥ ~60 с до FAILED (F-6.10)', () => {
    const total = [1, 2, 3, 4, 5, 6, 7, 8].reduce((sum, attempt) => sum + backoffDelayWith(attempt, 0.5), 0);
    expect(total).toBeGreaterThanOrEqual(50_000);
  });
});

describe('offline-очередь (промпт 1.12, п.2; A1.9, D126)', () => {
  it('ключ localStorage — mnemosin:pending:<playerId>', () => {
    expect(pendingKey('player-1')).toBe('mnemosin:pending:player-1');
  });

  it('push/list/removeByRequestId — roundtrip', () => {
    const storage = new FakeStorage();
    const queue = new OfflineQueue(storage);
    queue.push('p1', { type: 'ACTION_SUBMIT', payload: { requestId: 'req-1' }, requestId: 'req-1', queuedAt: 'x' });
    queue.push('p1', { type: 'CHAT_PUBLIC', payload: { requestId: 'req-2' }, requestId: 'req-2', queuedAt: 'y' });
    expect(queue.list('p1').map((item) => item.requestId)).toEqual(['req-1', 'req-2']);

    queue.removeByRequestId('p1', 'req-1');
    expect(queue.list('p1').map((item) => item.requestId)).toEqual(['req-2']);
    expect(storage.keys()).toEqual([pendingKey('p1')]);

    queue.removeByRequestId('p1', 'req-2');
    expect(queue.list('p1')).toEqual([]);
    expect(storage.keys()).toEqual([]); // пустая очередь удаляет ключ
  });

  it('push с тем же requestId заменяет запись (нет дублей при повторной отправке)', () => {
    const queue = new OfflineQueue(new FakeStorage());
    queue.push('p1', { type: 'ACTION_SUBMIT', payload: { requestId: 'req-1' }, requestId: 'req-1', queuedAt: 'a' });
    queue.push('p1', { type: 'ACTION_SUBMIT', payload: { requestId: 'req-1' }, requestId: 'req-1', queuedAt: 'b' });
    expect(queue.list('p1')).toHaveLength(1);
    expect(queue.list('p1')[0]?.queuedAt).toBe('b');
  });

  it('shouldPersist: только сообщения с idempotencyKey/requestId, служебные — нет', () => {
    expect(shouldPersist('ACTION_SUBMIT', { idempotencyKey: 'k', requestId: 'r' })).toBe(true);
    expect(shouldPersist('GM_COMMIT_TURN', { idempotencyKey: 'k' })).toBe(true);
    expect(shouldPersist('CHAT_PUBLIC', { requestId: 'r' })).toBe(true);
    expect(shouldPersist('CHAT_PRIVATE', { requestId: 'r' })).toBe(true);
    expect(shouldPersist('PING', {})).toBe(false);
    expect(shouldPersist('HISTORY', { requestId: 'r' })).toBe(false);
    expect(shouldPersist('SUBSCRIBE', { sessionId: 's' })).toBe(false);
    expect(shouldPersist('LEAVE', {})).toBe(false);
    expect(shouldPersist('ACTION_SUBMIT', {})).toBe(false);
  });

  it('retryable-коды ERROR остаются в очереди (RATE_LIMIT, IDEMPOTENCY_IN_FLIGHT)', () => {
    expect(isRetryableErrorCode('RATE_LIMIT')).toBe(true);
    expect(isRetryableErrorCode('IDEMPOTENCY_IN_FLIGHT')).toBe(true);
    expect(isRetryableErrorCode('RULE_REJECTED')).toBe(false);
    expect(isRetryableErrorCode('TURN_NOT_OPEN')).toBe(false);
    expect(isRetryableErrorCode('DUPLICATE')).toBe(false);
  });

  it('битый JSON в хранилище не роняет очередь', () => {
    const storage = new FakeStorage();
    storage.setItem(pendingKey('p1'), '{oops');
    const queue = new OfflineQueue(storage);
    expect(queue.list('p1')).toEqual([]);
  });
});
