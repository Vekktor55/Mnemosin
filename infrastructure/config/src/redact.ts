import { SECRET_ENV_KEYS } from './env.js';

/**
 * Маскирование секретов (v3 §VIII.3, §VIII.4; критерий A1.1).
 *
 * Два уровня:
 *  1. REDACT_PATHS — пути для pino redact (структурное маскирование в логах);
 *  2. maskSecrets() — для сообщений об ошибках и любых строк, которые могут
 *     содержать значения env-секретов.
 */

/** Пути pino-redact. Дополняются по мере появления полей (промпты 1.10, 1.11, 3.2). */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'token',
  'refreshToken',
  'accessToken',
  'password',
  'authorization',
  '*.token',
  '*.secret',
  '*.key',
  '*.apiKey',
];

const REDACTED = '[REDACTED]';

/** Заменяет значения известных секретов в произвольной строке. */
export function maskSecrets(text: string, secretValues: Iterable<string>): string {
  let out = text;
  for (const value of secretValues) {
    if (value.length >= 8) out = out.split(value).join(REDACTED);
  }
  return out;
}

/** Собирает значения секретов из env (только непустые). */
export function collectSecretValues(env: Record<string, string | undefined>): string[] {
  const values: string[] = [];
  for (const key of SECRET_ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value.length > 0) values.push(value);
  }
  return values;
}

/**
 * Поля, маскируемые при LOG_REDACT_PLAYER_TEXT=1 (v3 §VIII.3:
 * «логи не содержат rawText с приватными ключами»). Список фиксируется в
 * docs/ARCHITECTURE.md (D163) и используется логгером и Sentry beforeSend (3.10).
 */
export const PLAYER_TEXT_FIELDS: readonly string[] = [
  'rawText',
  'text',
  'privateMessages',
  'narrative',
  'gmNotesForAI',
  'comment',
] as const;
