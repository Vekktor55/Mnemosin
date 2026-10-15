import { describe, expect, it } from 'vitest';
import { EVENT_EMITTERS, EVENT_NAMES, ModuleIdSchema } from '@mnemosin/contracts';
import type { ModuleContract } from '@mnemosin/contracts';
import { aiDirectorContract } from '@mnemosin/module-ai-director';
import { gmReviewContract } from '@mnemosin/module-gm-review';
import { turnContract } from '@mnemosin/module-turn';

/**
 * Контракты модулей этапа 1 (промпт 1.8; полная валидация реестра — в 1.9).
 *
 * Проверяются инварианты defineModule-контрактов:
 *  - moduleId/emits/subscribes/dependencies — из каталогов contracts;
 *  - владелец события (EVENT_EMITTERS) совпадает с модулём, который его декларирует;
 *  - idempotentCommands ⊆ commands (F-8.2);
 *  - границы владения из промптов: turn без editAndApprove (D119), gm-review
 *    без зависимостей (F-8.6), ai-director без TURN_LOCKED (D115/B-09).
 */

const contracts: ReadonlyArray<ModuleContract> = [turnContract, gmReviewContract, aiDirectorContract];

describe('ModuleContract — структурная валидность (этап 1: turn, gm-review, ai-director)', () => {
  for (const contract of contracts) {
    describe(`модуль «${contract.moduleId}»`, () => {
      it('moduleId и dependencies — из каталога ModuleIdSchema; само-зависимостей нет', () => {
        expect(ModuleIdSchema.safeParse(contract.moduleId).success).toBe(true);
        for (const dependency of contract.dependencies) {
          expect(ModuleIdSchema.safeParse(dependency).success).toBe(true);
          expect(dependency).not.toBe(contract.moduleId);
        }
      });

      it('emits/subscribes ⊆ каталога EVENT_NAMES; владелец события — этот модуль', () => {
        for (const eventName of contract.emits) {
          expect(EVENT_NAMES, `${eventName} отсутствует в каталоге событий`).toContain(eventName);
          expect(EVENT_EMITTERS[eventName as keyof typeof EVENT_EMITTERS], `EVENT_EMITTERS[${eventName}]`).toBe(
            contract.moduleId,
          );
        }
        for (const eventName of contract.subscribes) {
          expect(EVENT_NAMES, `${eventName} отсутствует в каталоге событий`).toContain(eventName);
        }
      });

      it('idempotentCommands ⊆ commands (F-8.2); схемы команд парсят валидные и бракуют невалидные входы', () => {
        for (const command of contract.idempotentCommands) {
          expect(
            Object.keys(contract.commands),
            `idempotentCommands ссылается на неизвестную команду ${command}`,
          ).toContain(command);
        }
        for (const [name, entry] of Object.entries(contract.commands)) {
          expect(entry.input.safeParse({}).success, `${name}.input обязан браковать пустой вход`).toBe(false);
          expect(typeof entry.output.safeParse).toBe('function');
        }
        for (const [name, entry] of Object.entries(contract.queries)) {
          expect(entry.input.safeParse({}).success, `${name}.input обязан браковать пустой вход`).toBe(false);
        }
      });
    });
  }
});

describe('Границы владения из промпта 1.8', () => {
  it('turn: editAndApprove НЕ в контракте (им владеет gm-review, D119)', () => {
    expect(Object.keys(turnContract.commands).sort()).toEqual(['commitTurn', 'rejectTurn', 'resolveTurn', 'retryTurn']);
    expect(Object.keys(turnContract.queries).sort()).toEqual(['getJournal', 'getTurn', 'listTurns']);
    expect(turnContract.ports).toEqual(['AIPort', 'RulesPort']);
    expect(turnContract.dependencies).toEqual(['ai-director']);
    expect(turnContract.idempotentCommands).not.toContain('resolveTurn'); // серверный ключ resolve:{turnId} (B-08)
  });

  it('turn: emits — полный набор TURN_* + STATE_COMMITTED из промта', () => {
    expect([...turnContract.emits].sort()).toEqual(
      [
        'TURN_OPENED',
        'TURN_LOCKED',
        'TURN_UNLOCKED',
        'TURN_PROCESSING_STARTED',
        'TURN_DRAFT_READY',
        'TURN_COMMITTED',
        'TURN_FAILED',
        'STATE_COMMITTED',
      ].sort(),
    );
  });

  it('gm-review: dependencies ПУСТЫ (F-8.6 — НЕ [gm]); все команды идемпотентны; emits GM_REVIEW_DECIDED', () => {
    expect(gmReviewContract.dependencies).toEqual([]);
    expect(Object.keys(gmReviewContract.commands).sort()).toEqual(['approve', 'editAndApprove', 'reject', 'retry']);
    expect([...gmReviewContract.idempotentCommands].sort()).toEqual(['approve', 'editAndApprove', 'reject', 'retry']);
    expect(gmReviewContract.emits).toEqual(['GM_REVIEW_DECIDED']);
    expect(gmReviewContract.subscribes).toEqual(['TURN_DRAFT_READY']);
  });

  it('ai-director: вызов только командой — без подписки на TURN_LOCKED (D115/B-09)', () => {
    expect(aiDirectorContract.subscribes).not.toContain('TURN_LOCKED');
    expect(aiDirectorContract.ports).toEqual(['AIPort']);
  });
});
