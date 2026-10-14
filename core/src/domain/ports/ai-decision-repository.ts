/**
 * ai_decisions — журнал вызовов AI-Директора (промпт 1.7 заполнит его содержимым).
 * Таблица и порт объявлены в 1.4, чтобы миграция схемы была полной с первого дня.
 */
export type AiDecisionStatus = 'OK' | 'FAILED' | 'VIOLATIONS' | 'TIMEOUT';

export interface AiDecisionDraft {
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly providerId: string;
  readonly model: string;
  readonly status: AiDecisionStatus;
  readonly promptHash: string | null;
  readonly responseJson: string | null;
  readonly violationsCount: number;
  readonly latencyMs: number;
  readonly errorCode: string | null;
  readonly traceId: string;
  readonly createdAt: string;
}

export interface AiDecisionRecord extends AiDecisionDraft {
  readonly id: number;
}

export interface AiDecisionRepository {
  append(draft: AiDecisionDraft): Promise<AiDecisionRecord>;
  listByTurn(turnId: string): Promise<AiDecisionRecord[]>;
  listBySession(sessionId: string, limit?: number): Promise<AiDecisionRecord[]>;
}
