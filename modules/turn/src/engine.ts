import type { JournalEntry, Turn } from '@mnemosin/contracts';

import type {
  CommitTurnInput,
  CommitTurnOutput,
  GetJournalInput,
  GetTurnInput,
  ListTurnsInput,
  RejectTurnInput,
  RejectTurnOutput,
  ResolveTurnInput,
  ResolveTurnOutput,
  RetryTurnInput,
  RetryTurnOutput,
} from './contract.js';
import type { TurnEngineDeps } from './deps.js';
import { resolveTurn } from './resolve-turn.js';
import { commitTurn } from './commit-turn.js';
import { rejectTurn, retryTurn } from './reject-turn.js';

/**
 * TurnEngine — фасад модуля turn (промпт 1.8).
 *
 * Команды делегируются реализациям по файлам (resolve-turn/commit-turn/
 * reject-turn), запросы — доменным сервисам core (TurnService/JournalService
 * из промпта 1.6). Экземпляр создаёт wiring (apps/server) и инжектирует
 * потребителям: gm-review получает его через СВОЙ структурный порт
 * TurnEnginePort (модули не импортируют друг друга — D161/D227).
 */
export class TurnEngine {
  constructor(private readonly deps: TurnEngineDeps) {}

  /** LOCKED → PROCESSING → (AI, rules) → REVIEW | FAILED. Не коммитит (v3 §III.1). */
  resolveTurn(input: ResolveTurnInput): Promise<ResolveTurnOutput> {
    return resolveTurn(this.deps, input);
  }

  /** REVIEW → COMMITTED: применение черновика одной транзакцией (v3 §III.2). */
  commitTurn(input: CommitTurnInput): Promise<CommitTurnOutput> {
    return commitTurn(this.deps, input);
  }

  /** REVIEW → FAILED по решению GM (владелец вызова — gm-review, D119). */
  rejectTurn(input: RejectTurnInput): Promise<RejectTurnOutput> {
    return rejectTurn(this.deps, input);
  }

  /** REVIEW → OPEN (очистка черновика) | FAILED → новый ход (D118). */
  retryTurn(input: RetryTurnInput): Promise<RetryTurnOutput> {
    return retryTurn(this.deps, input);
  }

  // ---------------------------------------------------------------- запросы

  async getTurn(input: GetTurnInput): Promise<Turn> {
    return this.deps.services.turns.getTurn(input.turnId);
  }

  async listTurns(input: ListTurnsInput): Promise<Turn[]> {
    return this.deps.services.turns.listTurns(input.sessionId, input.limit ?? 100);
  }

  async getJournal(input: GetJournalInput): Promise<JournalEntry[]> {
    return this.deps.services.journal.list(input.turnId);
  }
}
