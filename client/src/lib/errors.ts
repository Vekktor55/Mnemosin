/**
 * Ошибки для UI (промпт 1.12, п.4; SPEC §4: «при ERROR — код + clientAction
 * из ERROR_TABLE»). UI обязан показывать ЧЕЛОВЕЧЕСКОЕ действие из таблицы,
 * а не сырой код; код выводится рядом для диагностики.
 *
 * Источник истины — ERROR_TABLE из @mnemosin/contracts (инвариант 15:
 * клиент ничего не объявляет заново, здесь только русские подписи действий).
 */
import { ERROR_TABLE, type ClientAction, type ErrorCode } from '@mnemosin/contracts';

/** Русская подсказка по clientAction (текст рядом с кодом ошибки). */
export const CLIENT_ACTION_HINT: Readonly<Record<ClientAction, string>> = Object.freeze({
  SHOW_INLINE: 'Проверьте введённые данные и повторите',
  REFRESH_PROJECTION: 'Состояние изменилось — обновите проекцию и повторите',
  RETRY_WITH_IDEMPOTENCY: 'Повторите операцию — сервер учтёт её ровно один раз',
  WAIT_AND_RETRY: 'Операция ещё выполняется — подождите и повторите',
  SHOW_REASON: 'Действие отклонено правилами — см. причину',
  NOTIFY_GM: 'Сообщите ведущему (GM): требуется его вмешательство',
  REAUTH: 'Войдите заново: токен недействителен',
  REFRESH_TOKEN: 'Сессия истекла — обновите токен и повторите',
  HIDE_ACTION: 'Операция недоступна для вашей роли',
  DEGRADE: 'Функция временно деградирована — попробуйте позже',
  BACKOFF: 'Слишком часто — повторите с паузой',
  IGNORE: 'Уже применено ранее — повторять не нужно',
  LOG_AND_ALERT: 'Внутренняя ошибка зафиксирована в журнале',
});

export interface DescribedError {
  readonly code: ErrorCode | string;
  readonly message: string;
  readonly clientAction: ClientAction | null;
  readonly hint: string;
  readonly meta: Readonly<Record<string, unknown>> | null;
}

/**
 * code+message(+meta) → то, что показывает UI: код, человекочитаемое
 * действие и подсказка. Неизвестный серверу код не роняет клиент:
 * clientAction=null, подсказка общая.
 */
export function describeError(code: string, message: string, meta?: Record<string, unknown> | null): DescribedError {
  const descriptor = ERROR_TABLE[code as ErrorCode] as { clientAction?: ClientAction } | undefined;
  const clientAction = descriptor?.clientAction ?? null;
  return {
    code,
    message,
    clientAction,
    hint: clientAction !== null ? CLIENT_ACTION_HINT[clientAction] : 'Неизвестная ошибка — обратитесь к ведущему',
    meta: meta ?? null,
  };
}

/** RULE_REJECTED: причина из meta человеческим языком (SPEC §4), иначе message. */
export function ruleRejectReason(described: DescribedError): string {
  const reason = described.meta?.['reason'] ?? described.meta?.['message'];
  if (typeof reason === 'string' && reason.length > 0) return reason;
  return described.message;
}
