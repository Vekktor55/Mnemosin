import { ZodError } from 'zod';
import { AppError, ERROR_TABLE, type ErrorCode } from '@mnemosin/contracts';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Единый обработчик ошибок HTTP (промпт 1.10, п.3; v3 §VI.9).
 *
 *  - AppError (CoreError/ProviderError/ConflictError) → статус из ERROR_TABLE,
 *    тело HttpErrorBody {error:{code, message, meta?, requestId}};
 *  - ZodError → VALIDATION (400), meta.issues ≤ 10, сообщения ≤ 80 символов
 *    (значения полей не раскрываем — LOG_REDACT_PLAYER_TEXT/D163);
 *  - 429 rate-limit плагина → RATE_LIMIT + Retry-After;
 *  - неизвестная ошибка → INTERNAL (500) + лог error с traceId.
 * requestId (req.id — x-request-id клиента или uuid, genReqId в app.ts)
 * возвращается ВСЕГДА.
 */

export interface HttpErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly meta?: Record<string, unknown>;
    readonly requestId: string;
  };
}

const MESSAGE_MAX = 500;
const ISSUE_MAX = 10;
const ISSUE_MESSAGE_MAX = 80;

export function zodIssuesToMeta(error: ZodError): Record<string, unknown> {
  return {
    issues: error.issues.slice(0, ISSUE_MAX).map((issue) => ({
      path: issue.path.join('.'),
      code: issue.code,
      // Значения полей не выводим; сообщение обрезаем (в zod-сообщения могут
      // попадать фрагменты полученного значения).
      message: issue.message.slice(0, ISSUE_MESSAGE_MAX),
    })),
  };
}

export function createHttpErrorHandler(logger?: FastifyBaseLogger) {
  return function httpErrorHandler(
    error: Error & { statusCode?: number },
    req: FastifyRequest,
    reply: FastifyReply,
  ): void {
    const requestId = req.id;

    if (error instanceof ZodError) {
      void reply.status(400).send({
        error: {
          code: 'VALIDATION',
          message: 'запрос не прошёл валидацию схемы',
          meta: zodIssuesToMeta(error),
          requestId,
        },
      } satisfies HttpErrorBody);
      return;
    }

    if (error instanceof AppError) {
      const descriptor = ERROR_TABLE[error.code];
      const status = descriptor?.http ?? 500;
      const meta: Record<string, unknown> = { ...error.meta };
      const retryAfter = meta['retryAfterSeconds'];
      if (typeof retryAfter === 'number') {
        void reply.header('Retry-After', String(Math.ceil(retryAfter)));
        delete meta['retryAfterSeconds'];
      }
      if (status >= 500) {
        logger?.error({ err: error, traceId: requestId, event: 'http_error_5xx' }, 'http_error_5xx');
      } else {
        logger?.debug({ code: error.code, traceId: requestId, event: 'http_error' }, 'http_error');
      }
      void reply.status(status).send({
        error: {
          code: error.code,
          message: error.message.slice(0, MESSAGE_MAX),
          ...(Object.keys(meta).length > 0 ? { meta } : {}),
          requestId,
        },
      } satisfies HttpErrorBody);
      return;
    }

    // @fastify/rate-limit бросает РЕЗУЛЬТАТ errorResponseBuilder (plain-объект
    // формы HttpErrorBody, не Error) — пропускаем как 429; Retry-After — от
    // плагина либо из meta.ttl запасным путём.
    const thrown = error as unknown as { error?: { code?: unknown; meta?: { ttl?: unknown } } };
    if (thrown.error !== undefined && thrown.error !== null && typeof thrown.error === 'object') {
      if (thrown.error.code === 'RATE_LIMIT') {
        if (!reply.hasHeader('retry-after')) {
          const ttl = thrown.error.meta?.ttl;
          if (typeof ttl === 'number') {
            void reply.header('Retry-After', String(Math.max(1, Math.ceil(ttl / 1000))));
          }
        }
        void reply.status(429).send(error);
        return;
      }
    }

    // 429 от @fastify/rate-limit (если не перехвачен errorResponseBuilder) и прочее.
    if (error.statusCode === 429) {
      void reply.status(429).send({
        error: { code: 'RATE_LIMIT', message: 'слишком много запросов', requestId },
      } satisfies HttpErrorBody);
      return;
    }

    logger?.error({ err: error, traceId: requestId, event: 'http_internal_error' }, 'http_internal_error');
    void reply.status(500).send({
      error: { code: 'INTERNAL', message: 'внутренняя ошибка сервера', requestId },
    } satisfies HttpErrorBody);
  };
}
