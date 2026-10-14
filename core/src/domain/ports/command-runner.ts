import type { CommandName, ErrorCode, SessionId, TurnId } from '@mnemosin/contracts';
import type { TxScope } from './unit-of-work.js';

/**
 * CommandRunner — порт «withIdempotency» (промпт 1.6, D216).
 *
 * Все мутирующие команды доменных сервисов обязаны быть идемпотентными
 * (ОБЩИЕ ПРАВИЛА; B-08). Механизм реализован в 1.4 (`IdempotencyService`,
 * infrastructure/database), но core не импортирует инфраструктуру (инварианты 1–3),
 * поэтому здесь объявлен СТРУКТУРНЫЙ интерфейс того же механизма:
 * `IdempotencyService` удовлетворяет ему без единой строчки импорта из core —
 * wiring (apps/server) просто передаёт сервис из `bootstrapDatabase()`.
 *
 * Семантика (D201):
 *  - `fn` выполняется ВНУТРИ транзакции (scope) и только если ключ захвачен впервые;
 *  - строка idempotency_records и эффекты команды коммитятся атомарно;
 *  - перманентные ошибки (validation/rules/content) фиксируются FAILED-записью,
 *    временные — откатываются целиком (повтор разрешён).
 */

export interface CommandContext {
  /** Ключ идемпотентности (проверенный сервисом по `IdempotencyKey`: 16–128 символов). */
  readonly key: string;
  readonly command: CommandName;
  readonly sessionId: SessionId | null;
  readonly turnId: TurnId | null;
  readonly traceId: string;
  readonly ttlMs?: number;
}

export type CommandOutcome<T> =
  | { readonly kind: 'executed'; readonly value: T }
  /** Команда уже выполнялась с этим ключом — `resultJson` содержит её прежний результат. */
  | { readonly kind: 'replayed'; readonly resultJson: string }
  /** Параллельный вызов с тем же ключом ещё не завершён. */
  | { readonly kind: 'in_flight' }
  /** Команда с этим ключом уже была отклонена перманентной ошибкой (D201). */
  | { readonly kind: 'failed_before'; readonly errorCode: ErrorCode };

export interface CommandRunner {
  run<T>(ctx: CommandContext, fn: (scope: TxScope) => Promise<T>): Promise<CommandOutcome<T>>;
}
