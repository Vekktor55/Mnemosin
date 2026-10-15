/**
 * @mnemosin/module-gm-audit — append-only аудит действий ведущего (промпт 1.9, п.7).
 *
 * Подписчик GM_ACTION_PERFORMED и GM_REVIEW_DECIDED (boot-подписка —
 * apps/server/modules-registry.ts). Пишет gm_audit, ничего не мутирует
 * в GameState, ничего не обновляет (append-only). Повторная доставка события
 * дедуплицируется по (traceId, action, gmPlayerId) — D250.
 */
export {
  gmAuditContract,
  DECISION_TO_ACTION,
  ListAuditInputSchema,
  ListAuditOutputSchema,
  type ListAuditInput,
  type ListAuditOutput,
} from './contract.js';
export { GmAuditService, type GmAuditDeps, type GmAuditLog } from './service.js';

export const PACKAGE_ID = '@mnemosin/module-gm-audit';
export const IMPLEMENTED_IN_PROMPT = '1.9';
