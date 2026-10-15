import { z } from 'zod';
import { GmAuditEntrySchema, IsoDateTime, SessionId, defineModule } from '@mnemosin/contracts';

/**
 * Контракт модуля gm-audit (v3 §IV.11; промпт 1.9, п.7).
 *
 * Подписчик GM_ACTION_PERFORMED и GM_REVIEW_DECIDED: пишет gm_audit
 * (append-only, НИКАКИХ обновлений). Команд нет — модуль ничего не мутирует
 * в GameState (проверяется тестом). Один запрос listAudit для GET /gm/audit (1.10).
 */

export const ListAuditInputSchema = z.object({
  sessionId: SessionId,
  since: IsoDateTime.optional(),
  limit: z.number().int().positive().max(1000).default(200),
});
export type ListAuditInput = z.infer<typeof ListAuditInputSchema>;

export const ListAuditOutputSchema = z.array(GmAuditEntrySchema);
export type ListAuditOutput = z.infer<typeof ListAuditOutputSchema>;

export const gmAuditContract = defineModule({
  moduleId: 'gm-audit',
  purpose:
    'Аудит действий ведущего: append-only лента gm_audit по событиям GM_ACTION_PERFORMED / GM_REVIEW_DECIDED (v3 §IV.11)',
  version: '0.1.0',
  commands: {},
  queries: {
    listAudit: { input: ListAuditInputSchema, output: ListAuditOutputSchema },
  },
  idempotentCommands: [],
  emits: [],
  subscribes: ['GM_ACTION_PERFORMED', 'GM_REVIEW_DECIDED'],
  ports: [],
  dependencies: [],
  capabilities: [],
});

/** Маппинг решения ревью → GmActionKind для строки аудита. */
export const DECISION_TO_ACTION = {
  APPROVE: 'approve',
  REJECT: 'reject',
  EDIT_AND_APPROVE: 'editAndApprove',
  RETRY_AI: 'retryTurn',
} as const satisfies Record<string, string>;
