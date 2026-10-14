import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';

import { EnvSchema, type Env } from './env.js';
import {
  CapabilitiesConfigSchema,
  ProviderPoliciesConfigSchema,
  LimitsConfigSchema,
  type CapabilitiesConfig,
  type ProviderPoliciesConfig,
  type LimitsConfig,
} from './files.js';
import { REDACT_PATHS, PLAYER_TEXT_FIELDS, collectSecretValues, maskSecrets } from './redact.js';

/**
 * Загрузка и валидация конфигурации (v3 §VIII.8): env + config/*.yaml.
 * Валидация — при старте; при ошибке процесс завершается с понятным
 * сообщением БЕЗ значений секретов (критерий A1.1).
 */

/** Провайдеры-заглушки: допустимы в development/test, запрещены в production. */
export const STUB_PROVIDERS: readonly string[] = Object.freeze(['scripted', 'echo', 'failing', 'debug']);

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  constructor(
    readonly code: 'CONFIG_INVALID' | 'CONFIG_MISSING_FILE' | 'CONFIG_PARSE_ERROR',
    message: string,
    readonly details: readonly ConfigIssue[] = [],
  ) {
    super(`${code}: ${message}`);
  }
}

export interface ConfigIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface AppConfig {
  readonly env: Env;
  readonly capabilities: CapabilitiesConfig;
  readonly providerPolicies: ProviderPoliciesConfig;
  readonly limits: LimitsConfig;
  readonly configDir: string;
  readonly stateDir: string;
  readonly isProduction: boolean;
  readonly isTest: boolean;
  /** Версия приложения (из package.json корня, см. app.ts). */
  readonly version: string;
  readonly redactPaths: readonly string[];
  readonly playerTextFields: readonly string[];
}

/** Преобразует ZodError в список проблем без значений полей (защита от утечки секретов). */
function toIssues(error: z.ZodError): ConfigIssue[] {
  return error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.join('.') || '(root)',
    code: issue.code,
    message: issue.message,
  }));
}

function readYaml(filePath: string): unknown {
  if (!existsSync(filePath)) {
    throw new ConfigError('CONFIG_MISSING_FILE', `config file not found: ${filePath}`);
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    throw new ConfigError('CONFIG_MISSING_FILE', `config file is not readable: ${filePath}`);
  }
  try {
    return parseYaml(raw) ?? {};
  } catch (cause) {
    throw new ConfigError(
      'CONFIG_PARSE_ERROR',
      `config file is not valid YAML: ${filePath} (${(cause as Error).message})`,
    );
  }
}

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, data: unknown, source: string): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = toIssues(result.error);
    // В сообщении — только путь и код проблемы: zod для invalid_enum_value
    // включает в текст полученное значение, поэтому message из issues не берём.
    const summary = issues
      .slice(0, 5)
      .map((issue) => `${issue.path} (${issue.code})`)
      .join(', ');
    throw new ConfigError('CONFIG_INVALID', `invalid configuration in ${source}: ${summary}`, issues);
  }
  return result.data;
}

export interface LoadConfigOptions {
  /** Каталог проекта. По умолчанию — process.cwd(). */
  readonly cwd?: string;
  /** Не читать .env (для тестов). */
  readonly ignoreDotenv?: boolean;
  /** Переменные окружения (по умолчанию process.env). */
  readonly env?: NodeJS.ProcessEnv;
  /** Версия приложения. */
  readonly version?: string;
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const cwd = options.cwd ?? process.cwd();

  if (!options.ignoreDotenv) {
    loadDotenv({ path: resolve(cwd, '.env'), quiet: true });
  }
  const rawEnv: NodeJS.ProcessEnv = options.env ?? process.env;

  const env = parseOrThrow(EnvSchema, { ...stripUndefined(rawEnv) }, '.env / process.env');
  const configDir = resolve(cwd, env.CONFIG_DIR);
  const stateDir = resolve(cwd, env.STATE_DIR);

  const capabilities = parseOrThrow(
    CapabilitiesConfigSchema,
    readYaml(resolve(configDir, 'capabilities.yaml')),
    'config/capabilities.yaml',
  );
  const providerPolicies = parseOrThrow(
    ProviderPoliciesConfigSchema,
    readYaml(resolve(configDir, 'provider-policies.yaml')),
    'config/provider-policies.yaml',
  );
  const limits = parseOrThrow(LimitsConfigSchema, readYaml(resolve(configDir, 'limits.yaml')), 'config/limits.yaml');

  assertCrossFieldRules(env, capabilities, providerPolicies);

  return Object.freeze({
    env,
    capabilities,
    providerPolicies,
    limits,
    configDir,
    stateDir,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    version: options.version ?? '0.0.0-dev',
    redactPaths: REDACT_PATHS,
    playerTextFields: env.LOG_REDACT_PLAYER_TEXT ? PLAYER_TEXT_FIELDS : [],
  });
}

/**
 * Кросс-проверки, которые Zod-схемой не выражаются.
 * Сообщение об ошибке называет переменную, но никогда не выводит её значение.
 */
function assertCrossFieldRules(
  env: Env,
  capabilities: CapabilitiesConfig,
  providerPolicies: ProviderPoliciesConfig,
): void {
  const fail = (message: string): never => {
    throw new ConfigError('CONFIG_INVALID', message);
  };

  if (env.AI_PROVIDER === 'openrouter' && !env.OPENROUTER_API_KEY) {
    fail('OPENROUTER_API_KEY is required when AI_PROVIDER=openrouter');
  }
  if (env.AI_PROVIDER === 'lmstudio' && !env.LMSTUDIO_BASE_URL) {
    fail('LMSTUDIO_BASE_URL is required when AI_PROVIDER=lmstudio');
  }
  if (env.MEDIA_PROVIDER === 'comfyui' && (!env.HOSTBRIDGE_SECRET || env.HOSTBRIDGE_SECRET.length < 32)) {
    fail('HOSTBRIDGE_SECRET (>= 32 chars) is required when MEDIA_PROVIDER=comfyui');
  }
  // D192: проверяем deny-list заглушек, а не allow-list «боевых» провайдеров —
  // иначе добавление нового провайдера требовало бы правки этого файла (A1.14).
  if (env.NODE_ENV === 'production' && STUB_PROVIDERS.includes(env.AI_PROVIDER)) {
    fail(`AI_PROVIDER=${env.AI_PROVIDER} is a stub provider and is not allowed in production`);
  }
  if (env.NODE_ENV === 'production' && STUB_PROVIDERS.includes(env.MEDIA_PROVIDER)) {
    fail(`MEDIA_PROVIDER=${env.MEDIA_PROVIDER} is a stub provider and is not allowed in production`);
  }

  const textAi = capabilities.capabilities.TEXT_AI;
  if (textAi?.required === true && textAi.chain.length === 0) {
    fail('capabilities.yaml: TEXT_AI is required but its fallback chain is empty');
  }

  const knownProviders = new Set(providerPolicies.policies.map((p) => p.providerId));
  for (const [capability, cfg] of Object.entries(capabilities.capabilities)) {
    for (const providerId of cfg.chain) {
      if (!knownProviders.has(providerId)) {
        fail(
          `capabilities.yaml: provider "${providerId}" (capability ${capability}) has no entry in provider-policies.yaml`,
        );
      }
    }
  }
}

function stripUndefined(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * Загрузка конфигурации с завершением процесса при ошибке.
 * Используется в apps/server/src/main.ts (v3 §VIII.8: «при ошибке процесс
 * завершается с понятным сообщением»).
 */
export function loadConfigOrExit(options: LoadConfigOptions = {}): AppConfig {
  try {
    return loadConfig(options);
  } catch (cause) {
    if (cause instanceof ConfigError) {
      const secretValues = collectSecretValues(options.env ?? process.env);
      process.stderr.write(`${maskSecrets(cause.message, secretValues)}\n`);
      for (const issue of cause.details) {
        process.stderr.write(`  - ${issue.path}: ${maskSecrets(issue.message, secretValues)} (${issue.code})\n`);
      }
      if (cause.code === 'CONFIG_INVALID' && cause.message.includes('JWT_SECRET')) {
        process.stderr.write(
          "  hint: generate one with  node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\"\n",
        );
      }
    } else {
      process.stderr.write(`CONFIG_UNEXPECTED_ERROR: ${(cause as Error).message}\n`);
    }
    process.exit(1);
  }
}

export { EnvSchema, type Env } from './env.js';
export { SECRET_ENV_KEYS } from './env.js';
export {
  CapabilitySchema,
  type Capability,
  type CapabilitiesConfig,
  type LimitsConfig,
  type ProviderPoliciesConfig,
  type ProviderPolicy,
} from './files.js';
export { ProviderPolicySchema, LimitsConfigSchema, CapabilitiesConfigSchema } from './files.js';
export { REDACT_PATHS, PLAYER_TEXT_FIELDS, collectSecretValues, maskSecrets } from './redact.js';
export { readPackageVersion } from './version.js';
