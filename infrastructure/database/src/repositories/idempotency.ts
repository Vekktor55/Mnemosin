import { eq, sql } from 'drizzle-orm';
import { nowIso, plusMs } from '@mnemosin/contracts';

import {
  IdempotencyRecordSchema,
  type ErrorCode,
  type IdempotencyAcquire,
  type IdempotencyKey,
  type IdempotencyRecord,
} from '@mnemosin/contracts';
import type { IdempotencyFailInput, IdempotencyFinishInput, IdempotencyRepository } from '@mnemosin/core/domain/ports';

import type { Db, Executor } from '../client.js';
import { parseBody, rowsAffectedOf } from '../mappers/index.js';
import { idempotencyRecords } from '../schema.js';

/** TTL для записи об отказе: столько же, сколько у обычной записи ключа. */
export const FAILED_TTL_MS = 24 * 60 * 60 * 1000;

export class SqlIdempotencyRepository implements IdempotencyRepository {
  private readonly q: Db;

  constructor(ex: Executor) {
    this.q = ex as Db;
  }

  /**
   * Атомарный захват (критерий A1.4).
   *
   * Ровно ОДИН запрос `INSERT ... ON CONFLICT(key) DO NOTHING`:
   *   rowsAffected = 1 → мы вставили строку первыми → 'proceed';
   *   rowsAffected = 0 → ключ уже был → читаем существующую запись и сообщаем, что с ней.
   *
   * Вариант «SELECT, потом INSERT» здесь запрещён принципиально: между ними вклинивается
   * второй процесс/запрос, и команда выполняется дважды (дубли действия, двойной расход AI).
   */
  async tryAcquire(record: IdempotencyRecord): Promise<IdempotencyAcquire> {
    const res = await this.q.run(sql`
      INSERT INTO idempotency_records
        (key, turn_id, session_id, command, status, result_json, result_hash, error_code, trace_id, created_at, expires_at)
      VALUES
        (${record.key}, ${record.turnId}, ${record.sessionId}, ${record.command}, ${record.status},
         ${record.resultJson}, ${record.resultHash}, ${record.errorCode}, ${record.traceId}, ${record.createdAt}, ${record.expiresAt})
      ON CONFLICT(key) DO NOTHING
    `);

    if (rowsAffectedOf(res) === 1) return { kind: 'proceed' };

    const existing = await this.findByKey(record.key);
    if (!existing) {
      // Запись исчезла между INSERT и SELECT (её удалил cleanupExpired) — безопаснее
      // сообщить «занято», чем выполнить команду второй раз.
      return { kind: 'in_flight' };
    }
    if (existing.status === 'DONE') return { kind: 'cached', resultJson: existing.resultJson ?? '' };
    if (existing.status === 'FAILED') return { kind: 'failed_before', errorCode: existing.errorCode ?? 'INTERNAL' };
    return { kind: 'in_flight' };
  }

  async finish(input: IdempotencyFinishInput): Promise<void> {
    await this.q
      .update(idempotencyRecords)
      .set({ status: 'DONE', resultJson: input.resultJson, resultHash: input.resultHash, errorCode: null })
      .where(eq(idempotencyRecords.key, input.key))
      .run();
  }

  /**
   * Фиксация перманентного отказа. UPSERT, а не UPDATE: вызывается ПОСЛЕ отката основной
   * транзакции (см. IdempotencyService), когда строки ключа в БД уже нет — обычный UPDATE
   * не задел бы ни одной строки и отказ потерялся бы.
   */
  async fail(input: IdempotencyFailInput): Promise<void> {
    const now = nowIso();
    await this.q.run(sql`
      INSERT INTO idempotency_records
        (key, turn_id, session_id, command, status, result_json, result_hash, error_code, trace_id, created_at, expires_at)
      VALUES
        (${input.key}, NULL, NULL, 'submitAction', 'FAILED', NULL, ${input.resultHash}, ${input.errorCode}, 'n/a', ${now}, ${plusMs(now, FAILED_TTL_MS)})
      ON CONFLICT(key) DO UPDATE SET
        status = 'FAILED',
        error_code = excluded.error_code,
        result_hash = excluded.result_hash,
        result_json = NULL
    `);
  }

  async findByKey(key: IdempotencyKey): Promise<IdempotencyRecord | null> {
    const rows = await this.q.select().from(idempotencyRecords).where(eq(idempotencyRecords.key, key)).limit(1);
    const row = rows[0];
    if (!row) return null;
    return parseBody(IdempotencyRecordSchema, row, 'idempotency_records');
  }

  /**
   * Освобождение (инвалидация) ключа — DELETE записи ЛЮБОГО статуса (D234/D235):
   * временный отказ resolveTurn (IN_FLIGHT) и намеренная инвалидация кэша
   * resolve при retryTurn из REVIEW (DONE). Перманентные отказы фиксируются
   * fail() и через release не удаляются вызывающим кодом.
   */
  async release(key: IdempotencyKey): Promise<void> {
    await this.q.delete(idempotencyRecords).where(eq(idempotencyRecords.key, key)).run();
  }

  async cleanupExpired(nowIso: string): Promise<number> {
    const res = await this.q.run(sql`DELETE FROM idempotency_records WHERE expires_at <= ${nowIso}`);
    return rowsAffectedOf(res);
  }

  async countAll(): Promise<number> {
    const rows = await this.q.all<{ c: number }>(sql`SELECT count(*) AS c FROM idempotency_records`);
    return Number(rows[0]?.c ?? 0);
  }
}

export type { ErrorCode };
