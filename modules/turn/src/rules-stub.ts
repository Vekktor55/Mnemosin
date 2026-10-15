import type { RuleResult, RuleSubject } from '@mnemosin/contracts';
import type { RulesEvaluationContext, RulesPort } from '@mnemosin/core';

/**
 * rulesStub — заглушка Rules Engine этапа 1 (промпт 1.8, п.6; решение D116
 * из SPEC_STAGE1 §13): возвращает PASS для всех subject.
 *
 * Интерфейс (RulesPort, core/domain/ports/rules-port.ts) — ПОЛНЫЙ: боевой
 * движок с RulesBundle/RuleCheck/Condition DSL приходит в этапе 2 (промпт 2.1)
 * заменой ОДНОЙ этой реализации в wiring; turn engine и его тесты не меняются.
 * Тесты этапа 1 проверяют все ветви outcome (REJECT/SOFT_REJECT/WARN) на
 * тестовых реализациях порта.
 */

export const RULES_STUB_CHECK_ID = 'stage1-rules-stub';

export const rulesStub: RulesPort = {
  async evaluate(_subject: RuleSubject, _ctx: RulesEvaluationContext): Promise<RuleResult[]> {
    return [
      {
        checkId: RULES_STUB_CHECK_ID,
        passed: true,
        outcome: 'PASS',
        message: null,
        requiresGM: false,
      },
    ];
  },
};
