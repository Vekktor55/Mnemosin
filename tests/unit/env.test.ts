import { describe, expect, it } from 'vitest';

import { EnvSchema, SECRET_ENV_KEYS } from '@mnemosin/config';

describe('infrastructure/config env', () => {
  describe('EnvSchema', () => {
    it('parses valid env with defaults', () => {
      const env = {
        NODE_ENV: 'development',
        PORT: '3000',
        METRICS_PORT: '9464',
        DATABASE_URL: 'file:./data/mnemosin.sqlite',
        JWT_SECRET: 'a'.repeat(32),
        JWT_TTL_SECONDS: '43200',
        JWT_REFRESH_TTL_SECONDS: '2592000',
        LOG_LEVEL: 'info',
        LOG_REDACT_PLAYER_TEXT: '1',
        AI_PROVIDER: 'scripted',
        AI_SCRIPTED_FIXTURE: 'tools/fixtures/resolution.ok.json',
        AI_FAILING_MODE: 'timeout',
        MEDIA_PROVIDER: 'none',
        CONFIG_DIR: './config',
        STATE_DIR: './data/state',
      };

      const result = EnvSchema.parse(env);
      expect(result.NODE_ENV).toBe('development');
      expect(result.PORT).toBe(3000);
      expect(result.DATABASE_URL).toBe('file:./data/mnemosin.sqlite');
    });

    it('parses boolean env values', () => {
      const env = {
        NODE_ENV: 'development',
        DATABASE_URL: 'file:./data/mnemosin.sqlite',
        JWT_SECRET: 'a'.repeat(32),
        DB_SEED: 'true',
        LOG_REDACT_PLAYER_TEXT: '0',
      };

      const result = EnvSchema.parse(env);
      expect(result.DB_SEED).toBe(true);
      // LOG_REDACT_PLAYER_TEXT is parsed as boolean by the schema
      expect(result.LOG_REDACT_PLAYER_TEXT).toBe(false);
    });

    it('uses default values when not provided', () => {
      const env = {
        DATABASE_URL: 'file:./data/mnemosin.sqlite',
        JWT_SECRET: 'a'.repeat(32),
      };

      const result = EnvSchema.parse(env);
      expect(result.NODE_ENV).toBe('development');
      expect(result.PORT).toBe(3000);
      expect(result.LOG_LEVEL).toBe('info');
    });

    it('rejects invalid NODE_ENV', () => {
      const env = {
        NODE_ENV: 'invalid',
        DATABASE_URL: 'file:./data/mnemosin.sqlite',
        JWT_SECRET: 'a'.repeat(32),
      };

      expect(() => EnvSchema.parse(env)).toThrow();
    });

    it('rejects short JWT_SECRET', () => {
      const env = {
        DATABASE_URL: 'file:./data/mnemosin.sqlite',
        JWT_SECRET: 'short',
      };

      expect(() => EnvSchema.parse(env)).toThrow();
    });
  });

  describe('SECRET_ENV_KEYS', () => {
    it('contains expected keys', () => {
      expect(SECRET_ENV_KEYS).toContain('JWT_SECRET');
      expect(SECRET_ENV_KEYS).toContain('HOSTBRIDGE_SECRET');
      expect(SECRET_ENV_KEYS).toContain('OPENROUTER_API_KEY');
    });
  });
});
