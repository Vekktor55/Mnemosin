import type { RepositoryRegistry } from '@mnemosin/core/domain/ports';

import type { Executor } from '../client.js';
import { SqlChatRepository, SqlGmAuditRepository, SqlGmNoteRepository } from './chat.js';
import { SqlIdempotencyRepository } from './idempotency.js';
import { SqlJournalRepository, SqlOutboxRepository } from './journal.js';
import { SqlLocationRepository } from './locations.js';
import { SqlCharacterRepository, SqlPlayerRepository, SqlSessionRepository } from './sessions.js';
import { SqlStateRepository } from './state.js';
import { SqlAiDecisionRepository, SqlSnapshotRepository } from './snapshots.js';
import { SqlActionRepository, SqlTurnRepository } from './turns.js';

/**
 * Фабрика репозиториев, привязанных к конкретному исполнителю (db или активная транзакция).
 * Один и тот же код работает в обоих случаях — см. комментарий в sessions.ts.
 */
export function createRepositories(ex: Executor): RepositoryRegistry {
  return {
    sessions: new SqlSessionRepository(ex),
    players: new SqlPlayerRepository(ex),
    characters: new SqlCharacterRepository(ex),
    turns: new SqlTurnRepository(ex),
    actions: new SqlActionRepository(ex),
    state: new SqlStateRepository(ex),
    locations: new SqlLocationRepository(ex),
    chat: new SqlChatRepository(ex),
    gmNotes: new SqlGmNoteRepository(ex),
    gmAudit: new SqlGmAuditRepository(ex),
    journal: new SqlJournalRepository(ex),
    idempotency: new SqlIdempotencyRepository(ex),
    outbox: new SqlOutboxRepository(ex),
    snapshots: new SqlSnapshotRepository(ex),
    aiDecisions: new SqlAiDecisionRepository(ex),
  };
}

export * from './sessions.js';
export * from './turns.js';
export * from './state.js';
export * from './locations.js';
export * from './chat.js';
export * from './journal.js';
export * from './idempotency.js';
export * from './snapshots.js';
