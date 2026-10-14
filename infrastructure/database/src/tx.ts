import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import type { RepositoryRegistry, TxScope, TxToken, UnitOfWork } from '@mnemosin/core/domain/ports';

import type { Db } from './client.js';
import { Mutex } from './serial.js';
import { createRepositories } from './repositories/index.js';

/**
 * UnitOfWork поверх drizzle/libsql (промпт 1.4, критерий A1.4).
 *
 * Вложенность: если транзакция уже активна в текущем async-контексте, `runInTx`
 * ПРИСОЕДИНЯЕТСЯ к ней (joined=true) и не делает ни commit, ни rollback — владелец
 * только один, внешний вызов. Иначе внутренний commit зафиксировал бы половину работы.
 *
 * Про BEGIN IMMEDIATE: у libsql-драйвера транзакция открывается самим драйвером.
 * Для корректности Stage 1 этого достаточно, потому что конфликтующие записи защищены
 * не изоляцией транзакции, а явными CAS-операциями (game_state.version, turns.status,
 * idempotency INSERT ... ON CONFLICT). При переезде на Postgres в Stage 3 уровень
 * изоляции поднимается до SERIALIZABLE — точка изменения одна (этот файл).
 */
export class SqlUnitOfWork implements UnitOfWork {
  private readonly als = new AsyncLocalStorage<TxScope>();
  private readonly rootRepos: RepositoryRegistry;
  private readonly writeLock = new Mutex();

  /**
   * @param db      соединение для записи (транзакции)
   * @param reader  соединение для чтения вне транзакции; если не передано — используется db
   */
  constructor(
    private readonly db: Db,
    reader?: Db,
  ) {
    this.rootRepos = createRepositories(reader ?? db);
  }

  /** Сколько задач ждёт пишущую блокировку — для диагностики и метрик. */
  get pendingWrites(): number {
    return this.writeLock.pending;
  }

  current(): TxScope | null {
    return this.als.getStore() ?? null;
  }

  /** Репозитории: внутри транзакции — транзакционные, снаружи — обычные. */
  repos(): RepositoryRegistry {
    return this.current()?.repos ?? this.rootRepos;
  }

  async runInTx<T>(work: (scope: TxScope) => Promise<T>): Promise<T> {
    const existing = this.als.getStore();
    if (existing) {
      // Присоединяемся: тот же token, тот же набор репозиториев, флаг joined для диагностики.
      return work({ token: existing.token, repos: existing.repos, joined: true });
    }
    // Транзакции сериализуются: SQLite допускает одного писателя (см. serial.ts).
    return this.writeLock.runExclusive(() =>
      this.db.transaction(async (tx) => {
        const scope: TxScope = {
          token: randomUUID() as TxToken,
          repos: createRepositories(tx),
          joined: false,
        };
        return this.als.run(scope, () => work(scope));
      }),
    );
  }
}

export type { RepositoryRegistry, TxScope, TxToken, UnitOfWork };
