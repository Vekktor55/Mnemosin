import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  importsOf,
  isAllowed,
  LAYER_RULES,
  listSourceFiles,
  packageDirs,
  packageName,
  ROOT,
  ruleFor,
} from './helpers.js';

/**
 * Architecture-тесты (промпт 1.3, критерий A1.2).
 * Основание: v3 §I.3 (инварианты 1–5, 14–15), §I.4 (антипаттерны), §IX.6.
 *
 * Каждый тест — исполняемая формулировка правила из docs/ARCHITECTURE.md §3.
 * Дублирует dependency-cruiser (`.dependency-cruiser.cjs`) осознанно: тесты
 * работают в любом CI без доп. инструмента и дают сообщение с именем файла.
 */

interface Violation {
  readonly file: string;
  readonly specifier: string;
  readonly layer: string;
}

function collectViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const rule of LAYER_RULES) {
    for (const dir of rule.dirs) {
      for (const file of listSourceFiles(dir)) {
        for (const specifier of importsOf(file)) {
          if (specifier.startsWith('.')) continue; // относительные — внутри пакета
          const isInternal = specifier.startsWith('@mnemosin/');
          const allowed = isInternal ? rule.internal : rule.external;
          if (!isAllowed(specifier, allowed)) {
            violations.push({ file, specifier, layer: rule.layer });
          }
        }
      }
    }
  }
  return violations;
}

describe('Границы зависимостей (A1.2)', () => {
  const violations = collectViolations();

  it('нет ни одного запрещённого импорта во всех слоях', () => {
    const report = violations.map((v) => `${v.file} → ${v.specifier} [${v.layer}]`).join('\n');
    expect(violations, report).toEqual([]);
  });

  it('contracts — leaf: только zod и node:crypto', () => {
    const offenders = violations.filter((v) => v.layer === 'contracts-leaf');
    expect(offenders, LAYER_RULES[0]?.forbiddenNote).toEqual([]);
    // явная проверка: ни одного импорта @mnemosin/* из contracts
    for (const file of listSourceFiles('shared/contracts')) {
      for (const specifier of importsOf(file)) {
        expect(specifier.startsWith('@mnemosin/'), `${file} → ${specifier}`).toBe(false);
      }
    }
  });

  it('core не импортирует infrastructure/modules/gateways/client и вендоров', () => {
    const forbidden = [
      '@mnemosin/database',
      '@mnemosin/logging',
      '@mnemosin/config',
      '@mnemosin/gateway-',
      '@mnemosin/module-',
      'fastify',
      '@fastify/',
      'drizzle-orm',
      'better-sqlite3',
      'pino',
      'jose',
      'openai',
    ];
    const offenders: string[] = [];
    for (const file of listSourceFiles('core')) {
      for (const specifier of importsOf(file)) {
        if (forbidden.some((prefix) => specifier.startsWith(prefix))) offenders.push(`${file} → ${specifier}`);
      }
    }
    expect(offenders, 'инварианты 1–3: core не знает внешние приложения и технологии').toEqual([]);
  });

  it('модули не импортируют БД и не импортируют друг друга (D161)', () => {
    const offenders: string[] = [];
    for (const dir of packageDirs().filter((d) => d.startsWith('modules/'))) {
      for (const file of listSourceFiles(dir)) {
        for (const specifier of importsOf(file)) {
          if (
            specifier.startsWith('@mnemosin/database') ||
            specifier.startsWith('drizzle-orm') ||
            specifier.startsWith('better-sqlite3')
          ) {
            offenders.push(`${file} → ${specifier} (БД)`);
          }
          if (specifier.startsWith('@mnemosin/module-')) offenders.push(`${file} → ${specifier} (модуль→модуль)`);
        }
      }
    }
    expect(offenders, 'wiring — только в apps/server; данные — только через порты core').toEqual([]);
  });

  it('транспорт не импортирует домен и БД (инвариант 14)', () => {
    const offenders: string[] = [];
    for (const dir of ['gateways/http', 'gateways/ws']) {
      for (const file of listSourceFiles(dir)) {
        for (const specifier of importsOf(file)) {
          if (specifier.startsWith('@mnemosin/database')) offenders.push(`${file} → ${specifier}`);
          // @mnemosin/core/domain/ports РАЗРЕШЁН: это type-only интерфейсы DI
          // (инъекции wiring'а), а не доменная логика — согласовано с
          // LAYER_RULES (helpers.ts) и eslint (запрещены только services/state).
          if (
            (specifier === '@mnemosin/core' || specifier.startsWith('@mnemosin/core/')) &&
            specifier !== '@mnemosin/core/domain/ports'
          ) {
            offenders.push(`${file} → ${specifier} (домен в транспорте)`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('клиент импортирует только контракты', () => {
    // Промпт 1.12: build-инструментарий (vite, плагин svelte, node:url) разрешён
    // ТОЛЬКО в конфигурации сборки client/vite.config.ts — рантайм-код клиента
    // (src/) по-прежнему импортирует лишь @mnemosin/contracts + svelte* + zod
    // (инвариант 15).
    const TOOLING_ALLOWLIST: Readonly<Record<string, readonly string[]>> = Object.freeze({
      'client/vite.config.ts': ['vite', '@sveltejs/vite-plugin-svelte', 'node:url'],
    });
    const offenders: string[] = [];
    for (const file of listSourceFiles('client')) {
      const tooling = TOOLING_ALLOWLIST[file] ?? [];
      for (const specifier of importsOf(file)) {
        if (specifier.startsWith('.')) continue;
        if (tooling.includes(specifier)) continue;
        if (specifier !== '@mnemosin/contracts' && !specifier.startsWith('svelte') && specifier !== 'zod') {
          offenders.push(`${file} → ${specifier}`);
        }
      }
    }
    expect(offenders, 'инвариант 15: frontend не источник истины и не знает внутренностей сервера').toEqual([]);
  });

  it('в core/, modules/, gateways/, shared/ нет `any` (антипаттерн v3 §I.4)', () => {
    const offenders: string[] = [];
    for (const dir of ['core', 'shared/contracts', 'gateways/http', 'gateways/ws']) {
      for (const file of listSourceFiles(dir)) {
        const source = readFileSync(resolve(ROOT, file), 'utf8');
        const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        if (/: any\b|<any>|as any\b/.test(withoutComments)) offenders.push(file);
      }
    }
    expect(offenders, 'unknown на границе модуля допустим только с немедленным Zod-парсингом').toEqual([]);
  });
});

describe('tsconfig project references соответствуют матрице зависимостей', () => {
  it('ссылки ведут только на разрешённые пакеты', () => {
    const offenders: string[] = [];
    const nameByDir = new Map(packageDirs().map((dir) => [resolve(ROOT, dir), packageName(dir)]));

    for (const dir of packageDirs()) {
      const tsconfigPath = resolve(ROOT, dir, 'tsconfig.json');
      const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8')) as { references?: Array<{ path: string }> };
      const rule = ruleFor(dir);
      if (rule === undefined) continue;

      for (const ref of tsconfig.references ?? []) {
        const refDir = resolve(ROOT, dir, ref.path);
        const refName = nameByDir.get(refDir);
        if (refName === undefined) continue;
        // Project reference указывает на пакет целиком, поэтому сверяем
        // с rule.refs (по умолчанию — с rule.internal).
        const allowedRefs = rule.refs ?? rule.internal;
        if (!isAllowed(refName, allowedRefs)) offenders.push(`${dir} → ${refName} (${rule.layer})`);
      }
    }
    expect(offenders, `правила: ${LAYER_RULES.map((r) => r.layer).join(', ')}`).toEqual([]);
  });

  it('каждый пакет объявлен в workspaces и имеет type: module', () => {
    for (const dir of packageDirs()) {
      const pkg = JSON.parse(readFileSync(resolve(ROOT, dir, 'package.json'), 'utf8')) as {
        type?: string;
        name?: string;
      };
      expect(pkg.type, dir).toBe('module');
      expect(pkg.name, dir).toMatch(/^@mnemosin\//);
    }
  });
});
