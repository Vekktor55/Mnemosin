/**
 * UnitOfWork — порт (v3 §II.18: «Core определяет порты, инфраструктура их реализует»).
 *
 * Семантика (промпт 1.4, критерий A1.4):
 *  - `runInTx` открывает транзакцию БД и передаёт `TxScope` со всеми репозиториями,
 *    привязанными к ЭТОЙ транзакции;
 *  - вложенный `runInTx` ПРИСОЕДИНЯЕТСЯ к активной транзакции (join), а не открывает новую —
 *    иначе commit внутреннего вызова зафиксировал бы частичное состояние;
 *  - если `work` бросает — транзакция откатывается целиком, ошибка пробрасывается.
 *
 * `TxToken` — бренд: репозиторий, получивший токен чужой транзакции, не скомпилируется
 * с токеном своей (защита от записи «мимо» активной транзакции).
 */
export type TxToken = string & { readonly __txToken: unique symbol };

/** Результат попытки присоединиться/открыть транзакцию — для диагностики вложенности. */
export type TxOutcome<T> = { readonly value: T; readonly nested: boolean };

export interface TxScope {
  readonly token: TxToken;
  readonly repos: RepositoryRegistry;
  /** true, если этот scope присоединился к уже активной транзакции (не владелец commit). */
  readonly joined: boolean;
}

export interface UnitOfWork {
  /** Выполнить `work` в транзакции. Вложенный вызов присоединяется к активной. */
  runInTx<T>(work: (scope: TxScope) => Promise<T>): Promise<T>;
  /** Активный scope текущего async-контекста или null, если транзакции нет. */
  current(): TxScope | null;
  /**
   * Репозитории текущего контекста: внутри транзакции — транзакционные (ALS),
   * снаружи — корневые (промпт 1.5: нужны JournalService и outbox-публикатору,
   * чтобы читать/писать без явной передачи scope).
   */
  repos(): RepositoryRegistry;
}

/**
 * Реестр репозиториев, доступных внутри транзакции.
 * Объявлен здесь (а не в каждом порте), чтобы `TxScope` не зависел от порядка импортов.
 */
import type { SessionRepository } from './session-repository.js';
import type { PlayerRepository } from './player-repository.js';
import type { CharacterRepository } from './character-repository.js';
import type { TurnRepository } from './turn-repository.js';
import type { ActionRepository } from './action-repository.js';
import type { StateRepository } from './state-repository.js';
import type { LocationRepository } from './location-repository.js';
import type { ChatRepository } from './chat-repository.js';
import type { GmNoteRepository } from './gm-note-repository.js';
import type { GmAuditRepository } from './gm-audit-repository.js';
import type { JournalRepository } from './journal-repository.js';
import type { IdempotencyRepository } from './idempotency-repository.js';
import type { OutboxRepository } from './outbox-repository.js';
import type { SnapshotRepository } from './snapshot-repository.js';
import type { AiDecisionRepository } from './ai-decision-repository.js';

export interface RepositoryRegistry {
  readonly sessions: SessionRepository;
  readonly players: PlayerRepository;
  readonly characters: CharacterRepository;
  readonly turns: TurnRepository;
  readonly actions: ActionRepository;
  readonly state: StateRepository;
  readonly locations: LocationRepository;
  readonly chat: ChatRepository;
  readonly gmNotes: GmNoteRepository;
  readonly gmAudit: GmAuditRepository;
  readonly journal: JournalRepository;
  readonly idempotency: IdempotencyRepository;
  readonly outbox: OutboxRepository;
  readonly snapshots: SnapshotRepository;
  readonly aiDecisions: AiDecisionRepository;
}
