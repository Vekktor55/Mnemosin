import {
  AppError,
  ColdToHotCommandSchema,
  ColdToHotJournalPayloadSchema,
  SessionId,
  type ColdToHotCommand,
  type FlagKey,
  type MatchId,
  type SessionId as SessionIdType,
  type StateMutation,
} from '@mnemosin/contracts';
import type { CommandRunner, TxScope } from '../domain/ports/index.js';
import { runCommand } from '../domain/command.js';
import type { JournalService } from '../turns/index.js';
import type { StateService } from '../state/index.js';
import type { ProcessColdCommandInput } from './types.js';

export interface ColdCommandResult {
  readonly applied: boolean;
  readonly revision: number;
  readonly journalEntryId: number;
}

export interface ColdCommandProcessorDeps {
  readonly commandRunner: CommandRunner;
  readonly journal: JournalService;
  readonly state: StateService;
  /**
   * Match, которому принадлежит обслуживаемая COLD-сессия.
   *
   * PROTOTYPE-ONLY (одна сессия = один match): команда чужого match
   * отклоняется до commit, поэтому в журнал и GameState чужой match не попадает.
   */
  readonly matchId: MatchId;
}

/**
 * PROTOTYPE-ONLY (HC-07): верхняя граница журнального окна для проверки
 * занятости/staleness ревизии. Переполнение окна — fail-closed, а не решение
 * по неполной истории.
 */
export const PROTOTYPE_COLD_COMMAND_JOURNAL_SCAN_LIMIT = 5_000;

/**
 * COLD command writer с той же SQLite idempotency, что и HOT event consumer.
 * Журнал содержит саму команду и revision, поэтому recovery не выдумывает
 * ревизии из GameState.version/state_applied.
 */
export class ColdCommandProcessor {
  private readonly commandRunner: CommandRunner;
  private readonly journal: JournalService;
  private readonly state: StateService;
  private readonly matchId: MatchId;

  constructor(deps: ColdCommandProcessorDeps) {
    this.commandRunner = deps.commandRunner;
    this.journal = deps.journal;
    this.state = deps.state;
    this.matchId = deps.matchId;
  }

  async process(input: ProcessColdCommandInput): Promise<ColdCommandResult> {
    const sessionId = SessionId.parse(input.sessionId);
    const command = validateCommand(input.command, this.matchId);
    const result = await runCommand(
      this.commandRunner,
      {
        key: coldCommandIdempotencyKey(command),
        command: 'processColdToHotCommand',
        sessionId,
        turnId: null,
        traceId: `cold-command-${command.commandId}`,
      },
      (scope) => this.commit(command, sessionId, scope),
    );
    return {
      applied: !result.replayed,
      revision: result.value.revision,
      journalEntryId: result.replayed ? -1 : result.value.journalEntryId,
    };
  }

  private async commit(
    command: ColdToHotCommand,
    sessionId: SessionIdType,
    scope: TxScope,
  ): Promise<{ readonly revision: number; readonly journalEntryId: number }> {
    await this.assertRevisionIsNotCommitted(command, sessionId);
    const currentState = await scope.repos.state.findBySession(sessionId);
    await this.state.apply({
      sessionId,
      mutations: this.toStateMutations(command),
      expectedVersion: currentState?.version ?? 0,
      turnId: null,
      traceId: `cold-command-${command.commandId}`,
      scope,
    });
    const journalEntry = await this.journal.append(
      {
        sessionId,
        turnId: null,
        kind: 'cold_to_hot_committed',
        payload: ColdToHotJournalPayloadSchema.parse({ command }),
        traceId: `cold-command-${command.commandId}`,
      },
      scope,
    );
    return { revision: command.revision, journalEntryId: journalEntry.id };
  }

  private async assertRevisionIsNotCommitted(command: ColdToHotCommand, sessionId: SessionIdType): Promise<void> {
    // +1 запись: переполнение окна означает, что часть durable-истории вне
    // окна, и решение «revision уже занята / stale» было бы неполным.
    // JournalService внутри ALS-транзакции использует те же transactional repos,
    // что и scope.repos, поэтому чтение остаётся согласованным с коммитом.
    const entries = await this.journal.listBySession(sessionId, PROTOTYPE_COLD_COMMAND_JOURNAL_SCAN_LIMIT + 1);
    if (entries.length > PROTOTYPE_COLD_COMMAND_JOURNAL_SCAN_LIMIT) {
      throw new AppError('CONFLICT', 'COLD command journal scan window exceeded', {
        scanLimit: PROTOTYPE_COLD_COMMAND_JOURNAL_SCAN_LIMIT,
        fetchedEntries: entries.length,
      });
    }
    const revisions = entries
      .filter((entry) => entry.kind === 'cold_to_hot_committed')
      .map((entry) => ColdToHotJournalPayloadSchema.parse(entry.payload).command);
    const conflict = revisions.find(
      (committed) => committed.revision === command.revision && committed.commandId !== command.commandId,
    );
    if (conflict !== undefined) {
      throw new AppError('CONFLICT', 'COLD revision is already committed by another commandId', {
        revision: command.revision,
        commandId: command.commandId,
        committedCommandId: conflict.commandId,
      });
    }
    const latest = revisions.reduce((maximum, committed) => Math.max(maximum, committed.revision), 0);
    if (command.revision <= latest) {
      throw new AppError('CONFLICT', 'COLD command revision is stale', {
        revision: command.revision,
        latestRevision: latest,
      });
    }
  }

  private toStateMutations(command: ColdToHotCommand): StateMutation[] {
    return [
      {
        kind: 'SET_FLAG',
        key: `prototype.runtime.${command.payload.key}` as FlagKey,
        value: command.payload.value,
        setBy: 'ENGINE',
      },
    ];
  }
}

export function coldCommandIdempotencyKey(command: ColdToHotCommand): string {
  return `cold-command:${command.matchId}:${command.worldEpoch}:${command.commandId}`;
}

function validateCommand(command: ColdToHotCommand, expectedMatchId: MatchId): ColdToHotCommand {
  const parsed = ColdToHotCommandSchema.safeParse(command);
  if (!parsed.success) {
    throw new AppError('VALIDATION', 'COLD command failed ColdToHotCommandSchema', {
      issues: parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  // Fail-closed: команда чужого match не должна попасть в GameState/журнал этой сессии.
  if (parsed.data.matchId !== expectedMatchId) {
    throw new AppError('CONFLICT', 'COLD command belongs to a different match', {
      commandId: parsed.data.commandId,
      commandMatchId: parsed.data.matchId,
      expectedMatchId,
    });
  }
  return parsed.data;
}
