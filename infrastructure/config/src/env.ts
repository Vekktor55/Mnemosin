import { z } from 'zod';

/**
 * Схема переменных окружения (v3 §VIII.8, docs/SPEC_STAGE1.md §11).
 *
 * Правило: все секреты — только env. Значения секретов никогда не попадают
 * в сообщения об ошибках и в логи (см. redact.ts, критерий A1.1).
 */

const boolFromEnv = z
  .enum(['0', '1', 'true', 'false', 'yes', 'no', 'on', 'off'])
  .transform((v) => ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()));

const intFromEnv = (def: number) => z.coerce.number().int().positive().default(def);

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'stage', 'production']).default('development'),
  PORT: intFromEnv(3000),
  METRICS_PORT: intFromEnv(9464),

  /** Обязательно. file:./data/mnemosin.sqlite */
  DATABASE_URL: z.string().min(1),

  /**
   * Посев dev-сессии при старте (промпт 1.10): по умолчанию — вне production.
   * Явный DB_SEED=false нужен приёмке/E2E: HTTP-поток создаёт сессию сам
   * (POST /auth/session), а посевная сессия блокировала бы его (D108).
   */
  DB_SEED: z.preprocess((v) => (v === '' ? undefined : v), boolFromEnv.optional()),

  /** Обязательно, >= 32 символов. В сообщениях об ошибках не выводится. */
  JWT_SECRET: z.string().min(32),
  JWT_TTL_SECONDS: intFromEnv(43_200),
  JWT_REFRESH_TTL_SECONDS: intFromEnv(2_592_000),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_REDACT_PLAYER_TEXT: boolFromEnv.default('1'),

  /**
   * Идентификатор провайдера — **строка, а не enum** (D192, критерий A1.14):
   * добавление провайдера = 1 файл адаптера + 1 строка в capabilities.yaml,
   * без изменения контрактов и env-схемы.
   * Известные значения: scripted | echo | failing (этап 1), openrouter | lmstudio (этап 2).
   */
  AI_PROVIDER: z.string().min(1).max(64).default('scripted'),
  AI_SCRIPTED_FIXTURE: z.string().default('tools/fixtures/resolution.ok.json'),
  AI_FAILING_MODE: z.enum(['timeout', 'schema', 'rate_limit', 'unavailable']).default('timeout'),
  /** Заглушки, запрещённые в production (список закрытый, а не список разрешённых). */

  /** Этап 2. В этапе 1 media-модуль не регистрируется. */
  OPENROUTER_API_KEY: z.string().optional(),
  LMSTUDIO_BASE_URL: z.string().optional(),

  /** То же правило (D192): none | debug (этап 2.11) | comfyui (этап 2.12) | любой будущий. */
  MEDIA_PROVIDER: z.string().min(1).max(64).default('none'),
  HOSTBRIDGE_SECRET: z.string().optional(),

  /** Список доменов фронта через запятую. В production без него CORS запрещён. */
  CORS_ORIGIN: z.string().optional(),

  CONFIG_DIR: z.string().default('./config'),
  STATE_DIR: z.string().default('./data/state'),
});

export type Env = z.infer<typeof EnvSchema>;

/** Переменные, значение которых запрещено выводить в ошибках и логах. */
export const SECRET_ENV_KEYS = ['JWT_SECRET', 'HOSTBRIDGE_SECRET', 'OPENROUTER_API_KEY'] as const;

export type SecretEnvKey = (typeof SECRET_ENV_KEYS)[number];
