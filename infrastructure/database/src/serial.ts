/**
 * Последовательная очередь (мьютекс) для записывающих транзакций.
 *
 * ЗАЧЕМ (найдено в промпте 1.4 измерением, а не предположено):
 *   50 параллельных `runInTx` на libsql дают 49 ошибок `SQLITE_BUSY: database is locked` —
 *   SQLite допускает ОДНОГО писателя, а драйвер не ставит транзакции в очередь сам.
 *   `busy_timeout` не спасает: конфликт происходит на уровне одного соединения, а не ожидания файла.
 *
 * Stage 1 = один процесс на сессию (D108), поэтому честная сериализация записи в пределах
 * процесса эквивалентна поведению SQLite и убирает класс ошибок целиком. При переезде на
 * Postgres (Stage 3) мьютекс удаляется, а вместо него работает SERIALIZABLE + retry —
 * точка изменения одна (SqlUnitOfWork.runInTx).
 *
 * Мьютекс НЕ подменяет атомарность SQL: захват ключа идемпотентности по-прежнему делается
 * одним `INSERT ... ON CONFLICT DO NOTHING`, а оптимистичная блокировка — CAS по version.
 * Очередь лишь гарантирует, что две транзакции не пересекаются во времени.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;

  /** Число задач в очереди (для метрик и диагностики в тестах). */
  get pending(): number {
    return this.waiting;
  }

  async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    this.waiting += 1;
    let release!: () => void;
    this.tail = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    try {
      await previous.catch(() => undefined); // ошибка предыдущей задачи не должна ломать очередь
      return await task();
    } finally {
      this.waiting -= 1;
      release();
    }
  }
}
