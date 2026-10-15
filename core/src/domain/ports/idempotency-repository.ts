import type { IdempotencyRecord, IdempotencyAcquire } from '@mnemosin/contracts';
import type { IdempotencyKey, ErrorCode } from '@mnemosin/contracts';

export interface IdempotencyFinishInput {
  readonly key: IdempotencyKey;
  readonly resultJson: string;
  readonly resultHash: string;
}

export interface IdempotencyFailInput {
  readonly key: IdempotencyKey;
  readonly errorCode: ErrorCode;
  readonly resultHash: string;
}

export interface IdempotencyRepository {
  /**
   * АТОМАРНЫЙ захват ключа (критерий A1.4):
   * `INSERT ... ON CONFLICT(key) DO NOTHING` — из N параллельных вызовов с одним ключом
   * ровно один получит `kind: 'proceed'`; остальные увидят cached / in_flight / failed_before.
   */
  tryAcquire(record: IdempotencyRecord): Promise<IdempotencyAcquire>;
  finish(input: IdempotencyFinishInput): Promise<void>;
  fail(input: IdempotencyFailInput): Promise<void>;
  /**
   * Освобождение (инвалидация) ключа — запись ЛЮБОГО статуса удаляется
   * (промпт 1.8, D234/D235). Два легальных вызывающих:
   *  1. resolveTurn при ВРЕМЕННОМ отказе — запись IN_FLIGHT удаляется, повтор
   *     разрешён (D201: перманентные отказы фиксируются fail(), не release);
   *  2. retryTurn из REVIEW — DONE-запись `resolve:{turnId}` удаляется НАМЕРЕННО:
   *     retry означает «перегенерировать черновик», прежний кэш результата
   *     больше не действителен.
   */
  release(key: IdempotencyKey): Promise<void>;
  findByKey(key: IdempotencyKey): Promise<IdempotencyRecord | null>;
  /** Удаление записей с истёкшим expiresAt; возвращает число удалённых строк. */
  cleanupExpired(nowIso: string): Promise<number>;
}
