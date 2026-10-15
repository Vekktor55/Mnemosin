import { describe, expect, it } from 'vitest';

import { ConnectionRateLimiter, RequestDedupeCache, findForbiddenKey } from '@mnemosin/gateway-ws';

/**
 * Транспортные примитивы WS-гейтвея (промпт 1.11): LRU-дедупликация requestId
 * (F-6.7), token bucket per connection, глубокий скан запрещённых broadcast-полей.
 */

describe('RequestDedupeCache (F-6.7)', () => {
  it('возвращает сохранённый ответ и учитывает TTL', () => {
    let now = 1_000;
    const cache = new RequestDedupeCache<string>(300_000, 10, () => now);
    cache.set('p1:req-1', 'ACK-1');
    expect(cache.get('p1:req-1')).toBe('ACK-1');
    now += 299_999;
    expect(cache.get('p1:req-1')).toBe('ACK-1');
    now += 2;
    expect(cache.get('p1:req-1')).toBeUndefined();
  });

  it('LRU: переполнение вытесняет самую старую запись', () => {
    const cache = new RequestDedupeCache<number>(300_000, 3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBe(1); // 'a' становится новейшей
    cache.set('d', 4); // вытесняется 'b'
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('sweep() удаляет истёкшие', () => {
    let now = 0;
    const cache = new RequestDedupeCache<string>(100, 10, () => now);
    cache.set('old', 'x');
    now = 500;
    cache.set('fresh', 'y');
    expect(cache.sweep()).toBe(1);
    expect(cache.size()).toBe(1);
    expect(cache.get('fresh')).toBe('y');
  });

  it('key() включает playerId — меж-игроковые коллизии requestId невозможны', () => {
    expect(RequestDedupeCache.key('p1', 'req')).not.toBe(RequestDedupeCache.key('p2', 'req'));
  });
});

describe('ConnectionRateLimiter (wsRatePerConnection)', () => {
  const rates = { ACTION_SUBMIT: 5, CHAT_PUBLIC: 10, DEFAULT: 20 };

  it('bucket на класс: ACTION_SUBMIT 5/с — шестое отклонено, через секунду снова можно', () => {
    let now = 0;
    const limiter = new ConnectionRateLimiter(rates, () => now);
    for (let i = 0; i < 5; i += 1) expect(limiter.tryConsume('ACTION_SUBMIT')).toBe(true);
    expect(limiter.tryConsume('ACTION_SUBMIT')).toBe(false);
    // Другие классы независимы.
    expect(limiter.tryConsume('CHAT_PUBLIC')).toBe(true);
    now += 1000;
    expect(limiter.tryConsume('ACTION_SUBMIT')).toBe(true);
  });

  it('неизвестный тип тарифицируется как DEFAULT', () => {
    let now = 0;
    const limiter = new ConnectionRateLimiter(rates, () => now);
    for (let i = 0; i < 20; i += 1) expect(limiter.tryConsume('PING')).toBe(true);
    expect(limiter.tryConsume('PING')).toBe(false);
    now += 500; // половинное пополнение: 10 токенов
    let accepted = 0;
    for (let i = 0; i < 15; i += 1) if (limiter.tryConsume('PING')) accepted += 1;
    expect(accepted).toBe(10);
  });
});

describe('findForbiddenKey (B-10, FORBIDDEN_IN_BROADCAST)', () => {
  it('находит запрещённые ключи на любой глубине', () => {
    expect(findForbiddenKey({ a: 1 })).toBeNull();
    expect(findForbiddenKey({ privateMessages: [] })).toBe('privateMessages');
    expect(findForbiddenKey({ nested: { deep: [{ knowledge: [] }] } })).toBe('knowledge');
    expect(findForbiddenKey({ diagnostics: { providerId: 'x' } })).toBe('diagnostics');
    expect(findForbiddenKey([{ gmNotesForAI: 'secret' }])).toBe('gmNotesForAI');
  });

  it('публичный TURN_COMMITTED-подобный payload чист', () => {
    const payload = {
      turnId: 'x',
      version: 3,
      publicSegments: [{ segmentId: 's1', text: 'нарратив' }],
    };
    expect(findForbiddenKey(payload)).toBeNull();
  });
});
