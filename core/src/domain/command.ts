import { randomUUID } from 'node:crypto';

import { AppError, IdempotencyKey } from '@mnemosin/contracts';
import type { CommandContext, CommandOutcome, CommandRunner, TxScope } from './ports/index.js';

/**
 * Обвязка мутирующей команды (промпт 1.6).
 *
 * `runCommand` — «withIdempotency» для доменных сервисов core: вызывает порт
 * `CommandRunner` (реализация — `IdempotencyService` из 1.4, D216) и разворачивает
 * `CommandOutcome` в результат команды:
 *  - executed  → значение + `replayed: false`;
 *  - replayed  → прежний результат из `resultJson` (B-08.4: повтор обязан вернуть ТО ЖЕ)
 *                + `replayed: true`;
 *  - in_flight → `AppError('IDEMPOTENCY_IN_FLIGHT')` (409, WAIT_AND_RETRY);
 *  - failed_before → `AppError(<прежний errorCode>)` (D201: перманентный отказ
 *                не выполняется повторно).
 *
 * Все ошибки — только ErrorCode (инвариант 18).
 */

export interface CommandResult<T> {
  readonly value: T;
  /** true, если результат взят из кэша идемпотентности (команда не выполнялась). */
  readonly replayed: boolean;
}

export async function runCommand<T>(
  guard: CommandRunner,
  ctx: CommandContext,
  fn: (scope: TxScope) => Promise<T>,
): Promise<CommandResult<T>> {
  const outcome: CommandOutcome<T> = await guard.run(ctx, fn);
  switch (outcome.kind) {
    case 'executed':
      return { value: outcome.value, replayed: false };
    case 'replayed':
      return { value: JSON.parse(outcome.resultJson) as T, replayed: true };
    case 'in_flight':
      throw new AppError('IDEMPOTENCY_IN_FLIGHT', `команда ${ctx.command} с этим idempotencyKey ещё выполняется`, {
        command: ctx.command,
      });
    case 'failed_before':
      throw new AppError(
        outcome.errorCode,
        `команда ${ctx.command} уже была отклонена (${outcome.errorCode}); повтор не выполняется (D201)`,
        { command: ctx.command },
      );
  }
}

/**
 * Проверка ключа идемпотентности по контракту (16–128 символов, `IdempotencyKey`).
 * Сервисы core принимают ключ от транспорта СТРОКОЙ и валидируют его здесь:
 * короткий/длинный ключ — ошибка VALIDATION, а не молчаливый обход схемы.
 */
export function parseIdempotencyKey(raw: string): IdempotencyKey {
  const parsed = IdempotencyKey.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('VALIDATION', 'idempotencyKey: ожидается строка 16–128 символов', {
      length: raw.length,
    });
  }
  return parsed.data;
}

/**
 * traceId по умолчанию (v3 §VIII.4: каждая запись несёт traceId).
 * Транспорт передаёт свой (pino + x-request-id); для внутренних вызовов и проб
 * генерируем uuid — core не импортирует @mnemosin/logging (инвариант 2).
 */
export function newTraceId(): string {
  return randomUUID();
}
