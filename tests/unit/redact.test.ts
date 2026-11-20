import { describe, expect, it } from 'vitest';

import { maskSecrets, collectSecretValues, REDACT_PATHS, PLAYER_TEXT_FIELDS } from '@mnemosin/config';

describe('infrastructure/config redact', () => {
  describe('maskSecrets', () => {
    it('masks known secret values in text', () => {
      const secret = 'my-secret-key-12345';
      const text = `Using token: ${secret} for auth`;
      const result = maskSecrets(text, [secret]);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain(secret);
    });

    it('does not mask short values', () => {
      const secret = 'short';
      const text = `Using token: ${secret} for auth`;
      const result = maskSecrets(text, [secret]);
      expect(result).toContain(secret);
    });

    it('handles multiple secrets', () => {
      const secrets = ['secret1-12345', 'secret2-67890'];
      const text = `Token1: ${secrets[0]}, Token2: ${secrets[1]}`;
      const result = maskSecrets(text, secrets);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain(secrets[0]);
      expect(result).not.toContain(secrets[1]);
    });

    it('handles empty secrets list', () => {
      const text = 'No secrets here';
      const result = maskSecrets(text, []);
      expect(result).toBe(text);
    });

    it('handles secret not in text', () => {
      const secret = 'not-in-text';
      const text = 'Some other text';
      const result = maskSecrets(text, [secret]);
      expect(result).toBe(text);
    });
  });

  describe('collectSecretValues', () => {
    it('collects non-empty secret values from env', () => {
      const env = {
        JWT_SECRET: 'my-jwt-secret',
        HOSTBRIDGE_SECRET: '',
        OPENROUTER_API_KEY: 'openrouter-key',
        OTHER_KEY: 'not-secret',
      };

      const result = collectSecretValues(env);
      expect(result).toContain('my-jwt-secret');
      expect(result).toContain('openrouter-key');
      expect(result).not.toContain(''); // empty HOSTBRIDGE_SECRET should be skipped
      expect(result).not.toContain('not-secret'); // OTHER_KEY not in SECRET_ENV_KEYS
    });

    it('handles empty env', () => {
      const result = collectSecretValues({});
      expect(result).toEqual([]);
    });

    it('skips undefined values', () => {
      const env = {
        JWT_SECRET: undefined,
        OPENROUTER_API_KEY: 'key',
      };
      const result = collectSecretValues(env);
      expect(result).toEqual(['key']);
    });
  });

  describe('REDACT_PATHS', () => {
    it('contains expected paths', () => {
      expect(REDACT_PATHS).toContain('req.headers.authorization');
      expect(REDACT_PATHS).toContain('req.headers.cookie');
      expect(REDACT_PATHS).toContain('*.token');
      expect(REDACT_PATHS).toContain('*.secret');
      expect(REDACT_PATHS).toContain('*.key');
    });
  });

  describe('PLAYER_TEXT_FIELDS', () => {
    it('contains expected fields', () => {
      expect(PLAYER_TEXT_FIELDS).toContain('rawText');
      expect(PLAYER_TEXT_FIELDS).toContain('text');
      expect(PLAYER_TEXT_FIELDS).toContain('privateMessages');
      expect(PLAYER_TEXT_FIELDS).toContain('narrative');
    });
  });
});
