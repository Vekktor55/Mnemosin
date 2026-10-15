import type { GameState, PlayerAction, RuleResult, RuleSubject, SessionId, TurnId } from '@mnemosin/contracts';

/**
 * RulesPort — порт Rules Engine (v3 §III.7–III.8; промпт 1.8, п.6).
 *
 * Этап 1: реализация — `rulesStub` (modules/turn/src/rules-stub.ts), возвращает
 * PASS для всех subject (решение D116 из SPEC_STAGE1 §13). ИНТЕРФЕЙС ПОЛНЫЙ:
 * боевой движок с RulesBundle/RuleCheck (contracts dsl/rules.ts) приходит в
 * этапе 2 (промпт 2.1) БЕЗ изменения порта и его потребителей — turn engine
 * уже передаёт subject'ы всех четырёх видов и разбирает все outcome.
 */

/** Контекст оценки: данные партии на момент resolveTurn (read-only срез). */
export interface RulesEvaluationContext {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  /** Текущее состояние партии (до применения черновика). */
  readonly state: GameState;
  /** Действия оцениваемого хода в порядке sequenceId. */
  readonly actions: readonly PlayerAction[];
}

export interface RulesPort {
  /**
   * Оценка одного subject (ACTION / OBJECT_CHANGE / EVENT_TRIGGER / STATE_CHANGE).
   * Возвращает результаты всех сработавших проверок (пустой массив — проверок нет).
   * Семантика outcome (v3 §III.8):
   *  - REJECT      → ход FAILED (CORE_RULE_REJECTED);
   *  - SOFT_REJECT → ход уходит в REVIEW с requiresGM=true;
   *  - WARN        → диагностика в resolution.diagnostics.warnings;
   *  - PASS/SKIPPED → без эффектов.
   */
  evaluate(subject: RuleSubject, ctx: RulesEvaluationContext): Promise<RuleResult[]>;
}
