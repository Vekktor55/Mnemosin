import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig, maskSecrets } from '@mnemosin/config';

/**
 * Промпт 1.1, критерий A1.1:
 *  - конфигурация грузится и валидируется при старте;
 *  - при ошибке процесс получает ConfigError с понятным сообщением;
 *  - значения секретов не попадают в сообщения об ошибках.
 */

const ROOT = process.cwd();
const VALID_SECRET = 'unit-test-secret-0123456789abcdef0123456789abcdef';

function envFor(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'file:./data/unit-test.sqlite',
    JWT_SECRET: VALID_SECRET,
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

function load(overrides: Record<string, string> = {}) {
  return loadConfig({ cwd: ROOT, ignoreDotenv: true, env: envFor(overrides), version: '0.0.0-test' });
}

describe('loadConfig — happy path', () => {
  it('загружает env и все три config/*.yaml', () => {
    const config = load();

    expect(config.env.NODE_ENV).toBe('test');
    expect(config.env.PORT).toBe(3000);
    expect(config.env.JWT_TTL_SECONDS).toBe(43_200);
    expect(config.isProduction).toBe(false);
    expect(config.isTest).toBe(true);
    expect(config.version).toBe('0.0.0-test');
  });

  it('применяет значения limits.yaml и дефолты схемы', () => {
    const config = load();

    expect(config.limits.maxPlayersPerSession).toBe(12);
    expect(config.limits.actionsPerPlayerPerTurn).toBe(5);
    expect(config.limits.wsAuthTimeoutMs).toBe(5000);
    expect(config.limits.heartbeat.idleTimeoutMs).toBe(45_000);
    expect(config.limits.outboxMaxAttempts).toBe(5);
  });

  it('TEXT_AI required, цепочка провайдеров этапа 1 — стенды', () => {
    const config = load();
    const textAi = config.capabilities.capabilities.TEXT_AI;

    expect(textAi?.required).toBe(true);
    expect(textAi?.chain).toEqual(['scripted', 'echo']);
    expect(config.providerPolicies.policies.map((p) => p.providerId)).toEqual(
      expect.arrayContaining(['scripted', 'echo']),
    );
  });

  it('цена неизвестна → costPer1kTokens = null (UNKNOWN#5)', () => {
    const config = load();
    const scripted = config.providerPolicies.policies.find((p) => p.providerId === 'scripted');

    expect(scripted?.costPer1kTokens).toEqual({ input: null, output: null });
  });

  it('redact-пути и поля с текстом игроков определены', () => {
    const config = load();

    expect(config.redactPaths).toContain('req.headers.authorization');
    expect(config.redactPaths).toContain('token');
    expect(config.playerTextFields).toContain('rawText');
  });

  it('LOG_REDACT_PLAYER_TEXT=0 отключает маскирование текста', () => {
    const config = load({ LOG_REDACT_PLAYER_TEXT: '0' });

    expect(config.playerTextFields).toEqual([]);
  });
});

describe('loadConfig — fail-fast (критерий A1.1)', () => {
  it('без JWT_SECRET процесс не стартует', () => {
    const env = envFor();
    delete env['JWT_SECRET'];

    expect(() => loadConfig({ cwd: ROOT, ignoreDotenv: true, env })).toThrowError(ConfigError);
  });

  it('короткий JWT_SECRET отклоняется с указанием переменной, но без значения', () => {
    const shortSecret = 'too-short-secret-value-abcdef';
    let message = '';
    try {
      load({ JWT_SECRET: shortSecret });
    } catch (cause) {
      expect(cause).toBeInstanceOf(ConfigError);
      message = (cause as ConfigError).message;
    }

    expect(message).toContain('CONFIG_INVALID');
    expect(message).toContain('JWT_SECRET');
    expect(message).not.toContain(shortSecret);
  });

  it('без DATABASE_URL процесс не стартует, секрет не утекает', () => {
    const env = envFor();
    delete env['DATABASE_URL'];

    let message = '';
    try {
      loadConfig({ cwd: ROOT, ignoreDotenv: true, env });
    } catch (cause) {
      message = (cause as ConfigError).message;
    }

    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain(VALID_SECRET);
  });

  it('AI_PROVIDER=openrouter без ключа → CONFIG_INVALID', () => {
    expect(() => load({ AI_PROVIDER: 'openrouter' })).toThrowError(/OPENROUTER_API_KEY/);
  });

  it('AI_PROVIDER=lmstudio без base URL → CONFIG_INVALID', () => {
    expect(() => load({ AI_PROVIDER: 'lmstudio' })).toThrowError(/LMSTUDIO_BASE_URL/);
  });

  it('MEDIA_PROVIDER=comfyui без HOSTBRIDGE_SECRET → CONFIG_INVALID', () => {
    expect(() => load({ MEDIA_PROVIDER: 'comfyui' })).toThrowError(/HOSTBRIDGE_SECRET/);
  });

  it('стендовый AI-провайдер запрещён в production', () => {
    expect(() => load({ NODE_ENV: 'production', AI_PROVIDER: 'scripted' })).toThrowError(/not allowed in production/);
  });

  it('провайдер из chain без политики → CONFIG_INVALID', () => {
    expect(() =>
      loadConfig({
        cwd: ROOT,
        ignoreDotenv: true,
        env: envFor({ CONFIG_DIR: 'tests/fixtures/config-broken-chain' }),
      }),
    ).toThrowError(/has no entry in provider-policies\.yaml/);
  });

  it('отсутствующий config-файл → CONFIG_MISSING_FILE', () => {
    let code = '';
    try {
      loadConfig({ cwd: ROOT, ignoreDotenv: true, env: envFor({ CONFIG_DIR: 'tests/fixtures/config-empty' }) });
    } catch (cause) {
      code = (cause as ConfigError).code;
    }

    expect(code).toBe('CONFIG_MISSING_FILE');
  });

  it('битый YAML → CONFIG_PARSE_ERROR', () => {
    let code = '';
    try {
      loadConfig({ cwd: ROOT, ignoreDotenv: true, env: envFor({ CONFIG_DIR: 'tests/fixtures/config-broken-yaml' }) });
    } catch (cause) {
      code = (cause as ConfigError).code;
    }

    expect(code).toBe('CONFIG_PARSE_ERROR');
  });
});

describe('maskSecrets', () => {
  it('заменяет значение секрета в строке', () => {
    const masked = maskSecrets('failed with key SUPERSECRETVALUE123 for player', ['SUPERSECRETVALUE123']);

    expect(masked).not.toContain('SUPERSECRETVALUE123');
    expect(masked).toContain('[REDACTED]');
  });

  it('короткие значения не маскируются (защита от ложных срабатываний)', () => {
    expect(maskSecrets('short key abc', ['abc'])).toBe('short key abc');
  });
});
