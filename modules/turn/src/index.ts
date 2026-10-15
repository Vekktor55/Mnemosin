/**
 * @mnemosin/module-turn — Turn Engine (промпт 1.8, критерии A1.6/A1.8).
 *
 *  - contract.ts — ModuleContract: resolveTurn/commitTurn/rejectTurn/retryTurn,
 *    запросы getTurn/listTurns/getJournal; emits TURN_* + STATE_COMMITTED;
 *    ports AIPort (через ai-director) + RulesPort; dependencies ['ai-director']
 *    декларативно (D161);
 *  - resolve-turn.ts — v3 §III.1: LOCKED→PROCESSING→(AI вне транзакции, D115)
 *    →rules→REVIEW|FAILED, детерминированный ключ `resolve:{turnId}` (B-08/D234);
 *  - commit-turn.ts — REVIEW→COMMITTED одной транзакцией: applyResolution →
 *    StateService.apply(expectedVersion) → TURN_COMMITTED; повтор ключа — тот
 *    же {version} (B-08.4); следующий ход открывает GM (D117);
 *  - apply-resolution.ts — только APPROVED/EDITED item'ы; allowlist ключей
 *    objectStates (F-9.4); hook applyEffects (passthrough этапа 1, DSL — 2.1);
 *    REACH_ENDING → endingState + journal 'ending_reached';
 *  - reject-turn.ts — REVIEW→FAILED; retry: REVIEW→OPEN (очистка черновика)
 *    или FAILED→новый ход без копирования действий (D118);
 *  - rules-stub.ts — rulesStub: PASS для всех subject (D116, интерфейс полный).
 */
export {
  turnContract,
  ResolveTurnInputSchema,
  ResolveTurnOutputSchema,
  CommitTurnInputSchema,
  CommitTurnOutputSchema,
  CommitGmDecisionSchema,
  ReviewerGmDecisionSchema,
  RejectTurnInputSchema,
  RejectTurnOutputSchema,
  RetryTurnInputSchema,
  RetryTurnOutputSchema,
  GetTurnInputSchema,
  ListTurnsInputSchema,
  GetJournalInputSchema,
  type ResolveTurnInput,
  type ResolveTurnOutput,
  type CommitTurnInput,
  type CommitTurnOutput,
  type CommitGmDecision,
  type ReviewerGmDecision,
  type RejectTurnInput,
  type RejectTurnOutput,
  type RetryTurnInput,
  type RetryTurnOutput,
  type GetTurnInput,
  type ListTurnsInput,
  type GetJournalInput,
} from './contract.js';
export { type DraftGeneratorPort, type TurnEngineDeps, type TurnEngineLimits, type TurnEngineLog } from './deps.js';
export { TurnEngine } from './engine.js';
export { resolveTurn } from './resolve-turn.js';
export { commitTurn } from './commit-turn.js';
export { rejectTurn, retryTurn } from './reject-turn.js';
export {
  applyEffects,
  approveAllItems,
  buildCommitPlan,
  isApplicable,
  isKeyAllowed,
  markResolutionApplied,
  type CommitPlan,
  type CommitPlanContext,
  type DeferredNote,
} from './apply-resolution.js';
export { rulesStub, RULES_STUB_CHECK_ID } from './rules-stub.js';

export const PACKAGE_ID = '@mnemosin/module-turn';
export const IMPLEMENTED_IN_PROMPT = '1.8';
