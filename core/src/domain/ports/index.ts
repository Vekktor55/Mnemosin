/**
 * Порты ядра (v3 §II.18). Реализации живут в infrastructure/* и НИКОГДА не импортируются
 * из core — связь только через эти интерфейсы (правила dependency-cruiser, промпт 1.3).
 */
export type { TxToken, TxOutcome, TxScope, UnitOfWork, RepositoryRegistry } from './unit-of-work.js';
export type { SessionRepository, SessionPhasePatch } from './session-repository.js';
export type { PlayerRepository } from './player-repository.js';
export type { CharacterRepository } from './character-repository.js';
export type { TurnRepository } from './turn-repository.js';
export type { ActionRepository } from './action-repository.js';
export type { StateRepository, StateWriteResult, StateMutationRecord } from './state-repository.js';
export type { LocationRepository } from './location-repository.js';
export type { ChatRepository } from './chat-repository.js';
export type { GmNoteRepository } from './gm-note-repository.js';
export type { GmAuditRepository } from './gm-audit-repository.js';
export type { JournalRepository, JournalDraft } from './journal-repository.js';
export type { IdempotencyRepository, IdempotencyFinishInput, IdempotencyFailInput } from './idempotency-repository.js';
export type { CommandRunner, CommandContext, CommandOutcome } from './command-runner.js';
export type { OutboxRepository, OutboxDraft } from './outbox-repository.js';
export type { SnapshotRepository } from './snapshot-repository.js';
export type { EventBus, EventHandler, Unsubscribe, PublishReport } from './event-bus.js';
export type { MetricsSink, MetricLabels } from './metrics.js';
export type {
  AiDecisionRepository,
  AiDecisionDraft,
  AiDecisionRecord,
  AiDecisionStatus,
} from './ai-decision-repository.js';
