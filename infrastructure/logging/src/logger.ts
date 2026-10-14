import { randomUUID } from 'node:crypto';
import pino, { type Logger, type LoggerOptions as PinoLoggerOptions } from 'pino';
import type { AppConfig } from '@mnemosin/config';

/**
 * Структурированное логирование (v3 §VIII.4; критерий A1.1).
 *
 * Требования:
 *  - JSON в production, человекочитаемо в development (pino-pretty);
 *  - каждая запись несёт traceId (child-логгер);
 *  - секреты не логируются (redact по REDACT_PATHS);
 *  - при LOG_REDACT_PLAYER_TEXT=1 текст игроков маскируется (D163).
 */

export interface LoggerOptions {
  readonly config: AppConfig;
  /** Имя компонента: 'http', 'ws', 'turn-engine', 'ai-director', … */
  readonly name?: string;
}

export function createLogger({ config, name }: LoggerOptions): Logger {
  // pino-pretty — только в development: в test/stage/production нужен чистый JSON
  // (структурные логи, v3 §VIII.4) и отсутствие transport-worker'ов.
  const pretty =
    config.env.NODE_ENV !== 'development'
      ? undefined
      : {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname',
              singleLine: false,
            },
          },
        };

  const options: PinoLoggerOptions = {
    level: config.env.LOG_LEVEL,
    redact: { paths: [...config.redactPaths], censor: '[REDACTED]' },
    base: { env: config.env.NODE_ENV, version: config.version },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  };
  // exactOptionalPropertyTypes: не передаём ключи со значением undefined.
  if (name !== undefined) options.name = name;
  if (pretty !== undefined) Object.assign(options, pretty);

  return pino(options);
}

/** Новый traceId для входящего HTTP-запроса или WS-сообщения. */
export function newTraceId(): string {
  return randomUUID();
}

/**
 * Child-логгер с обязательным traceId. Все слои получают логгер через эту
 * функцию, поэтому traceId проходит сквозь HTTP → модуль → адаптер → journal
 * (критерий A3.2 проверяет это сквозно).
 */
export function withTrace(logger: Logger, traceId: string, bindings?: Record<string, unknown>): Logger {
  return logger.child({ traceId, ...bindings });
}

/**
 * Маскирование полей с текстом игроков для записей, которые логируют payload
 * (например, журнал AI-контекста). Список полей — из config.playerTextFields.
 */
export function redactPlayerText(value: unknown, fields: readonly string[]): unknown {
  if (fields.length === 0) return value;
  if (Array.isArray(value)) return value.map((item) => redactPlayerText(item, fields));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = fields.includes(key) ? '[REDACTED_PLAYER_TEXT]' : redactPlayerText(item, fields);
  }
  return out;
}

export type { Logger };
