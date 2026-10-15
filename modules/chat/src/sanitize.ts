import { AppError } from '@mnemosin/contracts';

/**
 * Sanitize текста чата (промпт 1.9, п.2):
 *  - trim + нормализация переводов строк (\r\n и \r → \n);
 *  - лимит длины maxMessageLen (limits.yaml, default 1000) — нарушение → VALIDATION;
 *  - отклонение управляющих символов (C0 кроме \n и \t, а также DEL) → VALIDATION;
 *  - пустое сообщение после trim → VALIDATION.
 *
 * Значения текста в ошибках НЕ выводятся (LOG_REDACT_PLAYER_TEXT: pino-конфиг
 * маскирует поля text/rawText на уровне логгера, D163).
 */

/** C0-управляющие, кроме \t (0x09) и \n (0x0A), плюс DEL (0x7F). */
// eslint-disable-next-line no-control-regex -- поиск управляющих символов и есть назначение проверки (промпт 1.9: «отклонение управляющих символов»)
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export function sanitizeChatText(raw: string, maxMessageLen: number): string {
  if (typeof raw !== 'string') {
    throw new AppError('VALIDATION', 'text: ожидается строка', { reason: 'not_a_string' });
  }
  const normalized = raw.replace(/\r\n?/g, '\n').trim();
  if (normalized.length === 0) {
    throw new AppError('VALIDATION', 'сообщение пустое', { reason: 'empty' });
  }
  if (CONTROL_CHARS.test(normalized)) {
    throw new AppError('VALIDATION', 'сообщение содержит управляющие символы', { reason: 'control_chars' });
  }
  if (normalized.length > maxMessageLen) {
    throw new AppError('VALIDATION', `сообщение длиннее ${maxMessageLen} символов`, {
      reason: 'too_long',
      maxMessageLen,
      length: normalized.length,
    });
  }
  return normalized;
}
