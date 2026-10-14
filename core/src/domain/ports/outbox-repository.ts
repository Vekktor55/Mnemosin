import type { OutboxRecord, OutboxStatus } from '@mnemosin/contracts';

export interface OutboxDraft {
  readonly eventName: string;
  readonly payloadJson: string;
  readonly traceId: string;
  readonly emittedAt: string;
}

export interface OutboxRepository {
  /** Запись в outbox ОБЯЗАНА происходить в той же транзакции, что и изменение состояния. */
  append(draft: OutboxDraft): Promise<OutboxRecord>;
  appendMany(drafts: OutboxDraft[]): Promise<OutboxRecord[]>;
  listPending(limit?: number): Promise<OutboxRecord[]>;
  markPublished(id: number, atIso: string): Promise<void>;
  /**
   * Ошибка доставки/обработчика: attempts+1, lastError.
   * `dead=true` (лимит попыток исчерпан, D113/D210) → status='DEAD',
   * publishedAt остаётся NULL — запись больше не публикуется.
   */
  registerFailure(id: number, error: string, dead: boolean): Promise<void>;
  setStatus(id: number, status: OutboxStatus): Promise<void>;
  countByStatus(status: OutboxStatus): Promise<number>;
}
