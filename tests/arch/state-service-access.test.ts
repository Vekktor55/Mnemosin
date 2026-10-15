import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { importsOf, listSourceFiles, ROOT } from './helpers.js';

/**
 * D219 (инвариант 13, промпт 1.6): StateService — ЕДИНСТВЕННЫЙ путь мутации
 * GameState, и доступ к нему имеют только core-команды (turn commit, moveGroup).
 *
 * Механика ограничения:
 *  1. StateService экспортируется только через barrel `@mnemosin/core`
 *     (подпуть `@mnemosin/core/state` в exports пакета нет);
 *  2. инфраструктура и транспорт ИМПОРТИРУЮТ core только через
 *     `@mnemosin/core/domain/ports` (правило слоя 1.3) — barrel им недоступен,
 *     значит StateService для них недостижим типами;
 *  3. модули могут импортировать barrel, поэтому здесь проверяется whitelist:
 *     ссылки на StateService разрешены только в modules/turn (владелец commitTurn,
 *     промпт 1.8) и modules/story (D120/F-8.4, промпт 1.9: setFlag/grantKnowledge
 *     пишут состояние ТОЛЬКО через StateService.apply). Остальные модули получают
 *     изменения состояния событиями или командами core-сервисов через wiring.
 */

const MODULE_ALLOWLIST = ['modules/turn/', 'modules/story/'];

/**
 * Упоминания в JSDoc/комментариях (например, «заполнится в 1.9 через StateService»
 * в заглушке модуля или пояснение инварианта в contracts) нарушением не являются —
 * проверяем только КОД: комментарии вырезаются до поиска.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function referencesStateService(file: string): boolean {
  const source = codeOnly(readFileSync(resolve(ROOT, file), 'utf8'));
  return /StateService|state-service/.test(source);
}

describe('Доступ к StateService (D219, инвариант 13)', () => {
  it('модули вне allowlist не ссылаются на StateService', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles('modules')) {
      if (MODULE_ALLOWLIST.some((prefix) => file.startsWith(prefix))) continue;
      if (referencesStateService(file)) offenders.push(file);
    }
    expect(offenders, 'StateService доступен только core-командам').toEqual([]);
  });

  it('инфраструктура, транспорт и клиент не ссылаются на StateService', () => {
    // shared/contracts не сканируется: contracts — leaf без импортов (правило 1.3),
    // а упоминание 'state-service' в dsl/triggers.ts — строковая метка ВЛАДЕЛЬЦА
    // триггера (данные каталога), а не зависимость.
    const offenders: string[] = [];
    for (const dir of ['infrastructure', 'gateways', 'client']) {
      for (const file of listSourceFiles(dir)) {
        if (referencesStateService(file)) offenders.push(file);
      }
    }
    expect(offenders, 'слой не должен знать про StateService').toEqual([]);
  });

  it('core/package.json не открывает подпуть к state (только barrel и ports)', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'core/package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './domain/ports']);
  });

  it('barrel core экспортирует StateService (единственная точка доступа)', () => {
    const index = readFileSync(resolve(ROOT, 'core/src/index.ts'), 'utf8');
    expect(index).toContain('./state/index.js');
    const stateBarrel = readFileSync(resolve(ROOT, 'core/src/state/index.ts'), 'utf8');
    expect(stateBarrel).toContain('StateService');
  });

  it('никто не импортирует state-service глубоким путём в обход barrel', () => {
    const offenders: string[] = [];
    for (const dir of ['modules', 'infrastructure', 'gateways', 'apps', 'client']) {
      for (const file of listSourceFiles(dir)) {
        for (const specifier of importsOf(file)) {
          if (specifier.includes('core/src/state') || specifier.includes('@mnemosin/core/state')) {
            offenders.push(`${file} → ${specifier}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
