import { describe, expect, it } from 'vitest';

import { nowIso, plusMs, type ErrorCode, type IdempotencyRecord } from '@mnemosin/contracts';
import { DomainError } from '@mnemosin/database';

import { makeChat, makeIdempotencyRecord, openTempDb, seedWorld, type TempDb } from './helpers.js';

/**
 * Промпт 1.4 · критерий A1.4: идемпотентность commit.
 *
 * Проверяется то, ради чего всё затевалось: из N параллельных одинаковых команд
 * выполняется РОВНО ОДНА, а повтор получает тот же результат из кэша — без второго
 * расхода AI-бюджета и без дублей в состоянии.
 */

describe('идемпотентность · атомарный захват ключа', () => {
  let db: TempDb;

  it('50 параллельных tryAcquire с одним ключом → ровно один proceed', async () => {
    db = await openTempDb('idem-race', { seed: false });
    const record = makeIdempotencyRecord('race-key-aaaaaaaaaaaa');

    const results = await Promise.all(
      Array.from({ length: 50 }, () => db.boot.uow.repos().idempotency.tryAcquire(record)),
    );

    const tally = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.kind] = (acc[r.kind] ?? 0) + 1;
      return acc;
    }, {});

    expect(tally['proceed']).toBe(1);
    expect(tally['in_flight']).toBe(49);
    expect(Object.keys(tally)).toHaveLength(2);
    await db.close();
  });

  it('разные ключи не мешают друг другу: каждый получает свой proceed', async () => {
    db = await openTempDb('idem-keys', { seed: false });
    const keys = Array.from({ length: 20 }, (_, i) => `key-${String(i).padStart(12, '0')}`);
    const results = await Promise.all(
      keys.map((k) => db.boot.uow.repos().idempotency.tryAcquire(makeIdempotencyRecord(k))),
    );
    expect(results.filter((r) => r.kind === 'proceed')).toHaveLength(20);
    await db.close();
  });

  it('cleanupExpired удаляет истёкшие ключи и не трогает свежие', async () => {
    db = await openTempDb('idem-ttl', { seed: false });
    const repos = db.boot.uow.repos();
    const at = nowIso();

    const expired: IdempotencyRecord = {
      ...makeIdempotencyRecord('expired-key-000001', at),
      expiresAt: plusMs(at, -1000),
    };
    const fresh = makeIdempotencyRecord('fresh-key-0000001', at);
    await repos.idempotency.tryAcquire(expired);
    await repos.idempotency.tryAcquire(fresh);

    const removed = await repos.idempotency.cleanupExpired(at);
    expect(removed).toBe(1);
    expect(await repos.idempotency.findByKey(expired.key)).toBeNull();
    expect(await repos.idempotency.findByKey(fresh.key)).not.toBeNull();

    // после очистки ключ снова свободен — команда может быть выполнена заново
    const reacquire = await repos.idempotency.tryAcquire(expired);
    expect(reacquire.kind).toBe('proceed');
    await db.close();
  });
});

describe('идемпотентность · сервис команд', () => {
  let db: TempDb;

  it('50 параллельных service.run → 1 executed, 49 replayed, ноль ошибок SQLITE_BUSY', async () => {
    db = await openTempDb('idem-service', { seed: false });
    const key = 'submit-action-0001' as IdempotencyRecord['key'];
    let executions = 0;

    const outcomes = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        db.boot.idempotency.run(
          { key, command: 'submitAction', sessionId: null, turnId: null, traceId: `trace-${i}` },
          async () => {
            executions += 1;
            await new Promise((r) => setTimeout(r, 2));
            return { executedBy: i };
          },
        ),
      ),
    );

    const tally = outcomes.reduce<Record<string, number>>((acc, o) => {
      acc[o.kind] = (acc[o.kind] ?? 0) + 1;
      return acc;
    }, {});

    expect(executions).toBe(1);
    expect(tally['executed']).toBe(1);
    expect(tally['replayed']).toBe(49);
    expect(db.boot.uow.pendingWrites).toBe(0);
    await db.close();
  });

  it('повтор после завершения отдаёт ТОТ ЖЕ результат, а не выполняет команду заново', async () => {
    db = await openTempDb('idem-replay', { seed: false });
    const world = await seedWorld(db);
    const key = 'chat-message-000001' as IdempotencyRecord['key'];
    const ctx = {
      key,
      command: 'submitAction' as const,
      sessionId: world.session.sessionId,
      turnId: null,
      traceId: 'trace-replay',
    };

    const first = await db.boot.idempotency.run(ctx, async (scope) => {
      const message = makeChat(world.session.sessionId, world.players[1]!.playerId);
      await scope.repos.chat.insert(message);
      return { messageId: message.messageId };
    });
    expect(first.kind).toBe('executed');

    const second = await db.boot.idempotency.run(ctx, async () => {
      throw new Error('этот код не должен выполниться — ключ уже DONE');
    });
    expect(second.kind).toBe('replayed');
    if (second.kind === 'replayed') {
      expect(JSON.parse(second.resultJson)).toEqual(
        first.kind === 'executed' ? (first.value as { messageId: string }) : null,
      );
    }

    // и в БД ровно одно сообщение, а не два
    const messages = await db.boot.uow.repos().chat.listBySession(world.session.sessionId);
    expect(messages).toHaveLength(1);
    await db.close();
  });

  it('временная ошибка → откат целиком: ни эффектов, ни записи ключа, повтор разрешён', async () => {
    db = await openTempDb('idem-temp', { seed: false });
    const world = await seedWorld(db);
    const key = 'temp-failure-000001' as IdempotencyRecord['key'];
    const ctx = {
      key,
      command: 'submitAction' as const,
      sessionId: world.session.sessionId,
      turnId: null,
      traceId: 'trace-temp',
    };

    await expect(
      db.boot.idempotency.run(ctx, async (scope) => {
        await scope.repos.chat.insert(makeChat(world.session.sessionId, world.players[1]!.playerId));
        throw new Error('PROVIDER_TIMEOUT имитация');
      }),
    ).rejects.toThrow('имитация');

    // эффект откатился вместе с записью ключа
    expect(await db.boot.uow.repos().chat.listBySession(world.session.sessionId)).toHaveLength(0);
    expect(await db.boot.uow.repos().idempotency.findByKey(key)).toBeNull();

    const retry = await db.boot.idempotency.run(ctx, async (scope) => {
      await scope.repos.chat.insert(makeChat(world.session.sessionId, world.players[1]!.playerId));
      return { ok: true };
    });
    expect(retry.kind).toBe('executed');
    expect(await db.boot.uow.repos().chat.listBySession(world.session.sessionId)).toHaveLength(1);
    await db.close();
  });

  it('перманентная ошибка (VALIDATION) → failed_before на повторе, эффекты откатились', async () => {
    db = await openTempDb('idem-perm', { seed: false });
    const world = await seedWorld(db);
    const key = 'perm-failure-000001' as IdempotencyRecord['key'];
    const ctx = {
      key,
      command: 'submitAction' as const,
      sessionId: world.session.sessionId,
      turnId: null,
      traceId: 'trace-perm',
    };

    await expect(
      db.boot.idempotency.run(ctx, async (scope) => {
        await scope.repos.chat.insert(makeChat(world.session.sessionId, world.players[1]!.playerId));
        throw new DomainError('VALIDATION' as ErrorCode, 'пустой текст действия');
      }),
    ).rejects.toThrow('пустой текст действия');

    expect(await db.boot.uow.repos().chat.listBySession(world.session.sessionId)).toHaveLength(0);

    // повтор не жжёт бюджет: сразу failed_before, функция не вызывается
    const second = await db.boot.idempotency.run(ctx, async () => {
      throw new Error('не должно выполниться');
    });
    expect(second.kind).toBe('failed_before');
    if (second.kind === 'failed_before') expect(second.errorCode).toBe('VALIDATION');

    const record = await db.boot.uow.repos().idempotency.findByKey(key);
    expect(record?.status).toBe('FAILED');
    expect(record?.errorCode).toBe('VALIDATION');
    await db.close();
  });

  it('бизнес-запись и отметка DONE коммитятся атомарно (нет «сделано, но не отмечено»)', async () => {
    db = await openTempDb('idem-atomic', { seed: false });
    const world = await seedWorld(db);
    const key = 'atomic-commit-000001' as IdempotencyRecord['key'];

    const outcome = await db.boot.idempotency.run(
      { key, command: 'commitTurn', sessionId: world.session.sessionId, turnId: null, traceId: 'trace-atomic' },
      async (scope) => {
        await scope.repos.gmNotes.insert({
          noteId: (await import('node:crypto')).randomUUID() as never,
          sessionId: world.session.sessionId,
          turnId: null,
          visibility: 'GM_ONLY',
          text: 'заметка внутри идемпотентной команды',
          createdAt: nowIso(),
        });
        return { committed: true };
      },
    );
    expect(outcome.kind).toBe('executed');

    const record = await db.boot.uow.repos().idempotency.findByKey(key);
    expect(record?.status).toBe('DONE');
    expect(record?.command).toBe('commitTurn');
    expect(record?.resultJson).not.toBeNull();
    expect(record?.resultHash).toHaveLength(64);
    expect(await db.boot.uow.repos().gmNotes.listBySession(world.session.sessionId)).toHaveLength(1);
    await db.close();
  });
});
