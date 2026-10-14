import { createHash } from 'node:crypto';

import type { ErrorCode, IdempotencyRecord, IdempotencyStatus } from '@mnemosin/contracts';
import { ERROR_TABLE, nowIso, plusMs } from '@mnemosin/contracts';
import type { CommandContext, CommandOutcome, CommandRunner, TxScope, UnitOfWork } from '@mnemosin/core/domain/ports';

import type { DbLogger } from './client.js';
import { stableStringify } from './mappers/index.js';

/**
 * Сервис идемпотентности команд (промпт 1.4, критерий A1.4).
 *
 * Инвариант: строка idempotency_records и бизнес-изменения команды коммитятся В ОДНОЙ
 * транзакции. Следствия:
 *  - крах до commit → не осталось НИ записи, ни эффектов → повтор выполняет команду заново;
 *  - крах после commit → запись DONE с результатом → повтор отдаёт тот же результат (replay);
 *  - два параллельных одинаковых запроса → ровно один `proceed` (см. tryAcquire).
 *
 * Ошибки делятся на два класса:
 *  - ПЕРЕМАНЕНТНЫЕ (validation/rule_rejected/контент): повтор заведомо даст тот же результат,
 *    поэтому FAILED-запись фиксируется ОТДЕЛЬНОЙ транзакцией, а ошибка пробрасывается
 *    вызывающему. На повторе команда уже не выполняется — возвращается failed_before,
 *    и AI-бюджет не тратится второй раз;
 *  - ВРЕМЕННЫЕ (провайдер недоступен, таймаут, конфликт версий): транзакция откатывается
 *    целиком, запись исчезает, повтор разрешён.
 */

export const IDEMPOTENCY_TTL_MS_DEFAULT = 24 * 60 * 60 * 1000;

/** Хеш пустой строки — заглушка resultHash, пока результат не известен (контракт требует 64 символа). */
export const EMPTY_RESULT_HASH = createHash('sha256').update('').digest('hex');

/**
 * D216 (промпт 1.6): типы контекста/исхода объявлены в порте `CommandRunner`
 * (core/domain/ports) — доменные сервисы core зависят от порта, а этот сервис
 * является его реализацией. Локальные имена сохранены как алиасы: существующий
 * код (пробы, тесты) их уже импортирует.
 */
export type IdempotencyContext = CommandContext;
export type IdempotentOutcome<T> = CommandOutcome<T>;

/** Ошибка с кодом из контрактов — то, что умеет распознавать сервис. */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** Коды, повтор которых бесполезен (категория validation/rules/content в ERROR_TABLE). */
const PERMANENT_CATEGORIES = new Set(['validation', 'rules', 'content']);

export function isPermanentError(err: unknown): err is { code: ErrorCode } {
  const code = (err as { code?: unknown })?.code;
  if (typeof code !== 'string') return false;
  const descriptor = ERROR_TABLE[code as ErrorCode];
  if (!descriptor) return false;
  return PERMANENT_CATEGORIES.has(descriptor.category);
}

export function hashResult(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export interface IdempotencyServiceOptions {
  readonly uow: UnitOfWork;
  readonly ttlMs?: number;
  readonly logger?: DbLogger;
}

export class IdempotencyService implements CommandRunner {
  private readonly uow: UnitOfWork;
  private readonly ttlMs: number;
  private readonly logger: DbLogger | undefined;

  constructor(options: IdempotencyServiceOptions) {
    this.uow = options.uow;
    this.ttlMs = options.ttlMs ?? IDEMPOTENCY_TTL_MS_DEFAULT;
    this.logger = options.logger;
  }

  /** Выполнить команду под защитой ключа идемпотентности. `fn` получает scope транзакции. */
  async run<T>(ctx: CommandContext, fn: (scope: TxScope) => Promise<T>): Promise<CommandOutcome<T>> {
    const createdAt = nowIso();
    const record: IdempotencyRecord = {
      key: ctx.key as IdempotencyRecord['key'],
      turnId: ctx.turnId,
      sessionId: ctx.sessionId,
      command: ctx.command,
      status: 'IN_FLIGHT' satisfies IdempotencyStatus,
      resultJson: null,
      resultHash: EMPTY_RESULT_HASH,
      errorCode: null,
      traceId: ctx.traceId.slice(0, 64),
      createdAt,
      expiresAt: plusMs(createdAt, ctx.ttlMs ?? this.ttlMs),
    };

    try {
      return await this.uow.runInTx(async (scope) => {
        const acquired = await scope.repos.idempotency.tryAcquire(record);
        if (acquired.kind === 'cached') {
          this.logger?.info({ key: ctx.key, command: ctx.command }, 'idempotency replay');
          return { kind: 'replayed', resultJson: acquired.resultJson };
        }
        if (acquired.kind === 'in_flight') {
          return { kind: 'in_flight' };
        }
        if (acquired.kind === 'failed_before') {
          return { kind: 'failed_before', errorCode: acquired.errorCode };
        }

        const value = await fn(scope);
        const resultJson = JSON.stringify(value ?? null);
        await scope.repos.idempotency.finish({ key: record.key, resultJson, resultHash: hashResult(value) });
        return { kind: 'executed', value };
      });
    } catch (err: unknown) {
      if (isPermanentError(err)) {
        const code = (err as { code: ErrorCode }).code;
        // Отдельная транзакция: основная откатилась, а факт «эта команда навсегда rejected»
        // должен остаться, иначе клиент будет повторять её бесконечно.
        await this.uow.runInTx(async (scope) => {
          await scope.repos.idempotency.fail({ key: record.key, errorCode: code, resultHash: hashResult({ code }) });
        });
        this.logger?.warn({ key: ctx.key, command: ctx.command, code }, 'idempotency permanent failure recorded');
        // Первый вызов обязан увидеть настоящую ошибку (её код и сообщение нужны для ответа
        // клиенту); failed_before вернётся уже на ПОВТОРЕ — из записи в БД.
        throw err;
      }
      throw err;
    }
  }

  /** Очистка истёкших ключей — вызывается по расписанию (промпт 1.12) и при старте. */
  async cleanupExpired(): Promise<number> {
    return this.uow.runInTx(async (scope) => scope.repos.idempotency.cleanupExpired(nowIso()));
  }
}
