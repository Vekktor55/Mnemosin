import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadConfig, STUB_PROVIDERS } from '@mnemosin/config';
import { PROBE_POLICY, PROBE_PROVIDER_ID, probeValidateResponse } from '@mnemosin/ai';

import { importsOf, listSourceFiles, manifestOf, ROOT } from './helpers.js';

/**
 * Доказательство расширяемости (критерий A1.14, сценарий v3 §X.1).
 *
 * Утверждение: «добавить нового AI-провайдера = 1 файл адаптера + 1 строка
 * в capabilities.yaml; Core и контракты не меняются». Проверяется исполняемо,
 * а не декларацией.
 */

const KNOWN_PROVIDER_IDS = ['scripted', 'echo', 'failing', 'openrouter', 'lmstudio', 'comfyui', 'debug'];

function configFor(configDir: string, env: Record<string, string> = {}) {
  return loadConfig({
    cwd: ROOT,
    ignoreDotenv: true,
    version: '0.0.0-test',
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'file:./data/arch-test.sqlite',
      JWT_SECRET: 'arch-test-secret-0123456789abcdef0123456789',
      LOG_LEVEL: 'silent',
      CONFIG_DIR: configDir,
      ...env,
    },
  });
}

describe('A1.14: новый провайдер без изменения Core', () => {
  it('конфиг с неизвестным провайдером валиден — код не менялся', () => {
    const config = configFor('tests/fixtures/config-extensible');
    const chain = config.capabilities.capabilities.TEXT_AI?.chain ?? [];

    expect(chain).toEqual(['xai-probe', 'scripted', 'echo']);
    expect(config.providerPolicies.policies.map((p) => p.providerId)).toContain('xai-probe');
  });

  it('новый провайдер допускается и в production (проверка по deny-list заглушек, D192)', () => {
    const config = configFor('tests/fixtures/config-extensible', { NODE_ENV: 'production', AI_PROVIDER: 'xai-probe' });

    expect(config.env.AI_PROVIDER).toBe('xai-probe');
    expect(STUB_PROVIDERS).not.toContain('xai-probe');
  });

  it('заглушки по-прежнему запрещены в production', () => {
    expect(() =>
      configFor('tests/fixtures/config-extensible', { NODE_ENV: 'production', AI_PROVIDER: 'scripted' }),
    ).toThrowError(/stub provider/);
  });

  it('в контрактах НЕТ закрытого перечня провайдеров (иначе A1.14 недостижим)', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles('shared/contracts')) {
      const source = readFileSync(resolve(ROOT, file), 'utf8');
      // ищем z.enum(...), внутри которого встречается имя известного провайдера
      const enums = source.match(/z\.enum\(\[[\s\S]*?\]\)/g) ?? [];
      for (const block of enums) {
        for (const provider of KNOWN_PROVIDER_IDS) {
          if (block.includes(`'${provider}'`)) offenders.push(`${file}: z.enum содержит '${provider}'`);
        }
      }
    }
    expect(offenders, 'множество провайдеров должно быть открытым: строка в конфиге, а не значение enum').toEqual([]);
  });

  it('в core/ нет имён провайдеров (ядро не знает провайдеров — инвариант 2)', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles('core')) {
      const source = readFileSync(resolve(ROOT, file), 'utf8');
      for (const provider of [...KNOWN_PROVIDER_IDS, PROBE_PROVIDER_ID]) {
        if (source.includes(`'${provider}'`) || source.includes(`"${provider}"`))
          offenders.push(`${file}: '${provider}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('зонд-адаптер импортирует только контракты', () => {
    const specifiers = importsOf('infrastructure/ai/src/provider-probe.ts');

    expect(specifiers).toEqual(['@mnemosin/contracts']);
  });

  it('политика и валидация ответа провайдера работают без core', () => {
    expect(PROBE_POLICY.providerId).toBe(PROBE_PROVIDER_ID);
    expect(PROBE_POLICY.capability).toBe('TEXT_AI');
    expect(PROBE_POLICY.retries.max).toBe(2);

    expect(
      probeValidateResponse({
        narrative: '',
        privateMessages: [],
        proposedEvents: [],
        proposedObjectChanges: [],
        visualSceneDescription: null,
      }).ok,
    ).toBe(false);
  });

  it('добавление зонда не изменило core/ (сверка с манифестом)', () => {
    const manifest = JSON.parse(readFileSync(resolve(ROOT, 'tests/arch/core-manifest.json'), 'utf8')) as Record<
      string,
      string
    >;
    expect(manifestOf('core')).toEqual(manifest);
  });

  it('env-схема принимает произвольный идентификатор провайдера (строка, не enum)', () => {
    const config = configFor('tests/fixtures/config-extensible', {
      AI_PROVIDER: 'brand-new-provider-2027',
      MEDIA_PROVIDER: 'brand-new-media',
    });

    expect(config.env.AI_PROVIDER).toBe('brand-new-provider-2027');
    expect(config.env.MEDIA_PROVIDER).toBe('brand-new-media');
  });
});
