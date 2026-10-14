import { z } from 'zod';

/**
 * Error Taxonomy как код (v3 §VI.9 + §II.17 + поправки аудита F-6.4/F-1.19).
 *
 * Инвариант 18: ошибки пересекают границы модулей только как ErrorCode.
 * Внутренние классы (CoreError, ProviderError) несут тот же код, а транспорт
 * маппит их в HttpErrorBody / WS ERROR по ERROR_TABLE.
 */

/** Внутренние коды Core (v3 §II.17). */
export const CoreErrorCode = z.enum([
  'CORE_NOT_FOUND',
  'CORE_INVALID_STATE_TRANSITION',
  'CORE_RULE_REJECTED',
  'CORE_CONDITION_FAILED',
  'CORE_VERSION_CONFLICT',
  'CORE_DUPLICATE_ACTION',
  'CORE_LOCATION_NOT_FOUND',
  'CORE_EVENT_NOT_REGISTERED',
]);
export type CoreErrorCode = z.infer<typeof CoreErrorCode>;

/** Публичные коды (v3 §VI.9). */
export const PublicErrorCode = z.enum([
  'VALIDATION',
  'NOT_FOUND',
  'CONFLICT',
  'VERSION_CONFLICT',
  'DUPLICATE',
  'RULE_REJECTED',
  'EVENT_NOT_REGISTERED',
  'AUTH_INVALID',
  'AUTH_EXPIRED',
  'AUTH_FORBIDDEN',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_SCHEMA',
  'IDEMPOTENCY_IN_FLIGHT',
  'RATE_LIMIT',
  'TURN_NOT_OPEN',
  'INTERNAL',
]);
export type PublicErrorCode = z.infer<typeof PublicErrorCode>;

/**
 * Коды, которых не хватало в v3 (аудит F-6.4) и которые добавлены по данным мира:
 * event-конфликты, capability/бюджет, HostBridge, world-pack, восстановление.
 */
export const ExtendedErrorCode = z.enum([
  'EVENT_EFFECT_CONFLICT',
  'CAPABILITY_UNAVAILABLE',
  'BUDGET_EXCEEDED',
  'PROVIDER_BAD_GATEWAY',
  'PROVIDER_AUTH',
  'PROVIDER_BUDGET',
  'HB_SIGNATURE_INVALID',
  'HB_REPLAY_REJECTED',
  'HB_HOST_UNKNOWN',
  'HB_HOST_REPLACED',
  'HB_TIMEOUT',
  'WORKPACK_INVALID',
  'WORLDPACK_VERSION_MISMATCH',
  'WORKFLOW_NOT_FOUND',
  'BUNDLE_INCOMPATIBLE',
  'RECONCILE_INTERRUPTED',
  'NOT_IMPLEMENTED',
]);
export type ExtendedErrorCode = z.infer<typeof ExtendedErrorCode>;

export const ErrorCode = z.union([CoreErrorCode, PublicErrorCode, ExtendedErrorCode]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorCategory = z.enum(['validation', 'conflict', 'provider', 'rules', 'auth', 'system', 'content']);
export type ErrorCategory = z.infer<typeof ErrorCategory>;

/**
 * Что делать клиенту (колонка v3 §VI.9). UI обязан показывать именно это,
 * а не сырой код (docs/SPEC_STAGE1.md §4).
 */
export const ClientAction = z.enum([
  'SHOW_INLINE',
  'REFRESH_PROJECTION',
  'RETRY_WITH_IDEMPOTENCY',
  'WAIT_AND_RETRY',
  'SHOW_REASON',
  'NOTIFY_GM',
  'REAUTH',
  'REFRESH_TOKEN',
  'HIDE_ACTION',
  'DEGRADE',
  'BACKOFF',
  'IGNORE',
  'LOG_AND_ALERT',
]);
export type ClientAction = z.infer<typeof ClientAction>;

export interface ErrorDescriptor {
  readonly category: ErrorCategory;
  readonly http: number;
  readonly clientAction: ClientAction;
  /** Короткое пояснение для разработчика (не показывается игроку). */
  readonly note: string;
}

/**
 * Таблица маппинга: код → категория, HTTP, действие клиента.
 * Данные таблицы v3 §VI.9 как код (устраняет расхождение прозы и реализации).
 */
export const ERROR_TABLE: Readonly<Record<ErrorCode, ErrorDescriptor>> = Object.freeze({
  // --- validation
  VALIDATION: { category: 'validation', http: 400, clientAction: 'SHOW_INLINE', note: 'payload не прошёл Zod' },
  // --- conflict
  NOT_FOUND: { category: 'conflict', http: 404, clientAction: 'REFRESH_PROJECTION', note: 'сущность не найдена' },
  CONFLICT: { category: 'conflict', http: 409, clientAction: 'RETRY_WITH_IDEMPOTENCY', note: 'недопустимое состояние' },
  VERSION_CONFLICT: {
    category: 'conflict',
    http: 409,
    clientAction: 'REFRESH_PROJECTION',
    note: 'optimistic lock: версия GameState расходится',
  },
  DUPLICATE: { category: 'conflict', http: 409, clientAction: 'IGNORE', note: 'уже применено' },
  IDEMPOTENCY_IN_FLIGHT: {
    category: 'conflict',
    http: 409,
    clientAction: 'WAIT_AND_RETRY',
    note: 'команда с этим ключом ещё выполняется',
  },
  // --- rules
  RULE_REJECTED: { category: 'rules', http: 422, clientAction: 'SHOW_REASON', note: 'Rules Engine отклонил' },
  EVENT_NOT_REGISTERED: {
    category: 'rules',
    http: 422,
    clientAction: 'NOTIFY_GM',
    note: 'AI сослался на незарегистрированное событие',
  },
  EVENT_EFFECT_CONFLICT: {
    category: 'rules',
    http: 409,
    clientAction: 'NOTIFY_GM',
    note: 'два эффекта пишут в один StatePath; второй отложен (first-writer-wins)',
  },
  // --- auth
  AUTH_INVALID: { category: 'auth', http: 401, clientAction: 'REAUTH', note: 'токен недействителен/отозван' },
  AUTH_EXPIRED: { category: 'auth', http: 401, clientAction: 'REFRESH_TOKEN', note: 'истёк срок действия' },
  AUTH_FORBIDDEN: { category: 'auth', http: 403, clientAction: 'HIDE_ACTION', note: 'недостаточно прав (не GM)' },
  // --- provider
  PROVIDER_UNAVAILABLE: { category: 'provider', http: 503, clientAction: 'DEGRADE', note: 'нет доступного провайдера' },
  PROVIDER_TIMEOUT: { category: 'provider', http: 504, clientAction: 'BACKOFF', note: 'провайдер не ответил вовремя' },
  PROVIDER_RATE_LIMIT: { category: 'provider', http: 429, clientAction: 'BACKOFF', note: 'лимит провайдера' },
  PROVIDER_SCHEMA: { category: 'provider', http: 502, clientAction: 'NOTIFY_GM', note: 'ответ не соответствует схеме' },
  PROVIDER_AUTH: { category: 'provider', http: 502, clientAction: 'LOG_AND_ALERT', note: 'ключ провайдера отклонён' },
  PROVIDER_BAD_GATEWAY: {
    category: 'provider',
    http: 502,
    clientAction: 'BACKOFF',
    note: 'ошибка канала до провайдера',
  },
  PROVIDER_BUDGET: { category: 'provider', http: 503, clientAction: 'DEGRADE', note: 'бюджет провайдера исчерпан' },
  CAPABILITY_UNAVAILABLE: {
    category: 'provider',
    http: 503,
    clientAction: 'DEGRADE',
    note: 'capability недоступна (breaker/budget/manual)',
  },
  BUDGET_EXCEEDED: { category: 'provider', http: 503, clientAction: 'DEGRADE', note: 'превышен бюджет сессии' },
  // --- hostbridge (v3 §V.10, F-6.5)
  HB_SIGNATURE_INVALID: { category: 'auth', http: 403, clientAction: 'LOG_AND_ALERT', note: 'HMAC не сошёлся' },
  HB_REPLAY_REJECTED: {
    category: 'auth',
    http: 403,
    clientAction: 'LOG_AND_ALERT',
    note: 'timestamp вне окна или повтор requestId',
  },
  HB_HOST_UNKNOWN: { category: 'auth', http: 403, clientAction: 'LOG_AND_ALERT', note: 'hostId не зарегистрирован' },
  HB_HOST_REPLACED: {
    category: 'conflict',
    http: 409,
    clientAction: 'IGNORE',
    note: 'то же hostId подключилось повторно',
  },
  HB_TIMEOUT: { category: 'provider', http: 504, clientAction: 'BACKOFF', note: 'хост не ответил в пределах дедлайна' },
  // --- content (world-pack, D164)
  WORKPACK_INVALID: { category: 'content', http: 422, clientAction: 'NOTIFY_GM', note: 'pack не прошёл валидатор' },
  WORLDPACK_VERSION_MISMATCH: {
    category: 'content',
    http: 409,
    clientAction: 'NOTIFY_GM',
    note: 'сессия инстанцирована другой версией pack',
  },
  BUNDLE_INCOMPATIBLE: {
    category: 'content',
    http: 422,
    clientAction: 'NOTIFY_GM',
    note: 'export/import: несовместимая версия',
  },
  WORKFLOW_NOT_FOUND: {
    category: 'content',
    http: 422,
    clientAction: 'NOTIFY_GM',
    note: 'у провайдера нет такого workflow',
  },
  // --- system
  RATE_LIMIT: { category: 'system', http: 429, clientAction: 'BACKOFF', note: 'превышен лимит запросов' },
  TURN_NOT_OPEN: { category: 'system', http: 409, clientAction: 'REFRESH_PROJECTION', note: 'ход не в статусе OPEN' },
  NOT_IMPLEMENTED: {
    category: 'system',
    http: 501,
    clientAction: 'IGNORE',
    note: 'функция появится на следующем этапе',
  },
  RECONCILE_INTERRUPTED: {
    category: 'system',
    http: 409,
    clientAction: 'NOTIFY_GM',
    note: 'ход прерван рестартом; восстановлен reconcileOnBoot',
  },
  INTERNAL: { category: 'system', http: 500, clientAction: 'LOG_AND_ALERT', note: 'необработанная ошибка' },
  // --- core (внутренние; транспорт маппит их в публичные коды по CORE_TO_PUBLIC)
  CORE_NOT_FOUND: { category: 'conflict', http: 404, clientAction: 'REFRESH_PROJECTION', note: 'сущность не найдена' },
  CORE_INVALID_STATE_TRANSITION: {
    category: 'conflict',
    http: 409,
    clientAction: 'REFRESH_PROJECTION',
    note: 'недопустимый переход статуса',
  },
  CORE_RULE_REJECTED: { category: 'rules', http: 422, clientAction: 'SHOW_REASON', note: 'Rules Engine отклонил' },
  CORE_CONDITION_FAILED: { category: 'rules', http: 422, clientAction: 'SHOW_REASON', note: 'условие не выполнено' },
  CORE_VERSION_CONFLICT: {
    category: 'conflict',
    http: 409,
    clientAction: 'REFRESH_PROJECTION',
    note: 'optimistic lock',
  },
  CORE_DUPLICATE_ACTION: { category: 'conflict', http: 409, clientAction: 'IGNORE', note: 'повторный submit действия' },
  CORE_LOCATION_NOT_FOUND: {
    category: 'conflict',
    http: 404,
    clientAction: 'REFRESH_PROJECTION',
    note: 'локация не найдена',
  },
  CORE_EVENT_NOT_REGISTERED: {
    category: 'rules',
    http: 422,
    clientAction: 'NOTIFY_GM',
    note: 'событие не зарегистрировано',
  },
});

/** Маппинг внутренних кодов Core в публичные (v3 §III.14). */
export const CORE_TO_PUBLIC: Readonly<Record<CoreErrorCode, PublicErrorCode>> = Object.freeze({
  CORE_NOT_FOUND: 'NOT_FOUND',
  CORE_INVALID_STATE_TRANSITION: 'CONFLICT',
  CORE_RULE_REJECTED: 'RULE_REJECTED',
  CORE_CONDITION_FAILED: 'RULE_REJECTED',
  CORE_VERSION_CONFLICT: 'VERSION_CONFLICT',
  CORE_DUPLICATE_ACTION: 'DUPLICATE',
  CORE_LOCATION_NOT_FOUND: 'NOT_FOUND',
  CORE_EVENT_NOT_REGISTERED: 'EVENT_NOT_REGISTERED',
});

/** Маппинг кодов провайдера в публичные (аналог §III.14 для AIPort/MediaProvider). */
export const PROVIDER_TO_PUBLIC: Readonly<Record<string, PublicErrorCode>> = Object.freeze({
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  PROVIDER_RATE_LIMIT: 'PROVIDER_RATE_LIMIT',
  PROVIDER_AUTH: 'PROVIDER_SCHEMA',
  PROVIDER_SCHEMA: 'PROVIDER_SCHEMA',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  PROVIDER_BAD_GATEWAY: 'PROVIDER_SCHEMA',
  PROVIDER_BUDGET: 'PROVIDER_UNAVAILABLE',
});

export const HttpErrorBodySchema = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string().max(500),
    meta: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string().max(64).optional(),
  }),
});
export type HttpErrorBody = z.infer<typeof HttpErrorBodySchema>;

/** База всех прикладных ошибок: наружу уходит только ErrorCode (инвариант 18). */
export class AppError extends Error {
  override readonly name: string = 'AppError';
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly meta: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export class CoreError extends AppError {
  override readonly name = 'CoreError';
  constructor(code: CoreErrorCode, message: string, meta: Readonly<Record<string, unknown>> = {}) {
    super(code, message, meta);
  }
}

export class ProviderError extends AppError {
  override readonly name = 'ProviderError';
  constructor(
    code:
      | z.infer<typeof ExtendedErrorCode>
      | 'PROVIDER_TIMEOUT'
      | 'PROVIDER_RATE_LIMIT'
      | 'PROVIDER_SCHEMA'
      | 'PROVIDER_UNAVAILABLE',
    message: string,
    readonly providerId: string,
    meta: Readonly<Record<string, unknown>> = {},
  ) {
    super(code, message, { ...meta, providerId });
  }
}

/** Конфликт состояния/версии (используется идемпотентностью и optimistic lock). */
export class ConflictError extends AppError {
  override readonly name = 'ConflictError';
  constructor(
    code: 'CONFLICT' | 'VERSION_CONFLICT' | 'IDEMPOTENCY_IN_FLIGHT' | 'DUPLICATE',
    message: string,
    meta: Readonly<Record<string, unknown>> = {},
  ) {
    super(code, message, meta);
  }
}

/** Приведение произвольной ошибки к ErrorCode для транспорта. */
export function toErrorCode(cause: unknown): ErrorCode {
  if (cause instanceof AppError) return cause.code;
  if (cause instanceof z.ZodError) return 'VALIDATION';
  return 'INTERNAL';
}
