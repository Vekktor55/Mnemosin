/**
 * HTTP-клиент (промпт 1.12; SPEC §7).
 *
 * Тонкая обёртка fetch: единый формат ошибки HttpErrorBody (контракты),
 * Bearer-токен из sessionStorage (D126), clientAction из ERROR_TABLE для UI.
 * Маршруты — из каталога HTTP_ROUTES (источник истины — контракты).
 */
import { type ClientAction, type ErrorCode, ERROR_TABLE } from '@mnemosin/contracts';

import { describeError, type DescribedError } from '../lib/errors.js';
import { apiBase } from './url.js';

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly code: ErrorCode | string;
  readonly status: number;
  readonly clientAction: ClientAction | null;
  readonly described: DescribedError;

  constructor(status: number, described: DescribedError) {
    super(described.message);
    this.status = status;
    this.code = described.code;
    this.clientAction = described.clientAction;
    this.described = described;
  }
}

export interface ApiRequestOptions {
  readonly token?: string | null;
  readonly body?: unknown;
  readonly query?: Record<string, string | number | undefined>;
  readonly signal?: AbortSignal;
}

function buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
  const base = apiBase();
  const qs =
    query === undefined
      ? ''
      : Object.entries(query)
          .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
          .join('&');
  return `${base}${path}${qs.length > 0 ? `?${qs}` : ''}`;
}

/**
 * Запрос к API. Успех — JSON ответа (схемы маршрутов проверяет сервер);
 * ошибка — ApiError с кодом и clientAction из ERROR_TABLE.
 */
export async function api<T>(
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (typeof options.token === 'string' && options.token.length > 0)
    headers['authorization'] = `Bearer ${options.token}`;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (cause) {
    // Сеть недоступна: код как у серверного INTERNAL, действие — WAIT_AND_RETRY.
    throw new ApiError(0, describeError('NETWORK', cause instanceof Error ? cause.message : 'сеть недоступна'));
  }

  const text = await response.text();
  const json: unknown = text.length === 0 ? null : safeJsonParse(text);

  if (!response.ok) {
    const body = json as { error?: { code?: string; message?: string; meta?: Record<string, unknown> } } | null;
    const code = body?.error?.code ?? 'INTERNAL';
    const message = body?.error?.message ?? `HTTP ${response.status}`;
    throw new ApiError(response.status, describeError(code, message, body?.error?.meta));
  }
  return json as T;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** clientAction по коду без HTTP-вызова (для ошибок, пришедших по WS). */
export function clientActionOf(code: string): ClientAction | null {
  const descriptor = ERROR_TABLE[code as ErrorCode] as { clientAction?: ClientAction } | undefined;
  return descriptor?.clientAction ?? null;
}
