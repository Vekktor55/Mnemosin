import {
  ColdToHotJournalPayloadSchema,
  CoreError,
  HotGameplayJournalPayloadSchema,
  HotSnapshotSchema,
  type ColdToHotCommand,
  type EventId,
  type HotGameplayEventAck,
  type HotGameplayEventEnvelope,
  type HotRecoveryPoint,
  type HotSnapshot,
  type MatchId,
  type SessionId,
  type SnapshotId,
  type WorldEpoch,
} from '@mnemosin/contracts';
import type { SnapshotRepository, UnitOfWork } from '../domain/ports/index.js';
import type { HotColdBridgeState, ColdCommandReceipt } from '../hot/cold-boundary.js';
import type { HotRuntimeRecoverySnapshot } from '../hot/runtime.js';
import type { HotTickResult } from '../hot/types.js';
import type { JournalService } from '../turns/index.js';
import type { ColdGameplayEventProcessor } from './gameplay-event-processor.js';

export interface SnapshotRecoveryInput {
  readonly matchId: MatchId;
  readonly sessionId: SessionId;
  readonly targetSnapshot?: SnapshotId;
  /**
   * Test-only recovery log для событий, созданных HOT, но не достигших COLD commit.
   * В production источник таких событий — HC-06, который остаётся ОТКРЫТ.
   */
  readonly pendingEvents?: readonly HotGameplayEventEnvelope[];
}

export interface RecoveryResult {
  readonly recoveredSnapshot: HotSnapshot;
  readonly recoveredRuntime: HotRuntimeRecoverySnapshot;
  readonly appliedColdRevisions: number;
  /** Сколько событий предъявлено идемпотентному processor при recovery. */
  readonly replayedEvents: number;
  readonly committedEvents: number;
  readonly deduplicatedEvents: number;
  /** После успешного recover неприменённых событий не остаётся. */
  readonly pendingEvents: readonly HotGameplayEventEnvelope[];
  readonly recoveryOrder: readonly string[];
}

export interface RecoveryDiagnostics {
  readonly recoveryPoint: HotRecoveryPoint;
  readonly snapshotAgeMs: number;
  readonly transientStateRollback: boolean;
}

/** Структурный порт HOT; никаких Fastify/WebSocket/SQLite зависимостей. */
export interface HotRecoveryRuntime {
  restoreFromSnapshot(
    runtime: HotRuntimeRecoverySnapshot['runtime'],
    recoveryPoint: HotRuntimeRecoverySnapshot['recoveryPoint'],
  ): void;
  captureSnapshot(lastAppliedEventId: EventId | null): HotRuntimeRecoverySnapshot;
  receiveColdCommand(raw: unknown): ColdCommandReceipt;
  getColdBoundaryState(): HotColdBridgeState;
  tick(): HotTickResult;
}

export interface SnapshotRecoveryOrchestratorDeps {
  readonly uow?: UnitOfWork;
  readonly snapshotRepo: SnapshotRepository;
  readonly journal: JournalService;
  readonly eventProcessor: ColdGameplayEventProcessor;
  readonly runtime: HotRecoveryRuntime;
}

/**
 * Snapshot + durable journal recovery (не narrative reset).
 *
 * HOT откатывается только до snapshot. COLD GameState НЕ перезаписывается
 * старой копией: уже committed mutations остаются, а journal/replay идемпотентен.
 * При revision gap, битом watermark или ошибке commit восстановление падает —
 * scheduler нельзя запускать по частично восстановленному runtime.
 */
export class SnapshotRecoveryOrchestrator {
  private readonly snapshotRepo: SnapshotRepository;
  private readonly journal: JournalService;
  private readonly eventProcessor: ColdGameplayEventProcessor;
  private readonly runtime: HotRecoveryRuntime;

  constructor(deps: SnapshotRecoveryOrchestratorDeps) {
    this.snapshotRepo = deps.snapshotRepo;
    this.journal = deps.journal;
    this.eventProcessor = deps.eventProcessor;
    this.runtime = deps.runtime;
  }

  async recover(input: SnapshotRecoveryInput): Promise<RecoveryResult> {
    const snapshot = input.targetSnapshot
      ? await this.snapshotRepo.findById(input.targetSnapshot)
      : await this.snapshotRepo.findLatestBySession(input.sessionId);
    if (!snapshot) throw new Error(`No snapshot found for session ${input.sessionId}`);
    if (snapshot.snapshotVersion !== 1) throw new Error('Only HOT v1 snapshots supported for recovery');

    const hotSnapshot = HotSnapshotSchema.parse(snapshot);
    const recoveryPoint = hotSnapshot.recoveryPoint;
    if (recoveryPoint.matchId !== input.matchId) {
      throw new CoreError('CORE_INVALID_STATE_TRANSITION', 'Snapshot matchId differs from recovery target', {
        snapshotMatchId: recoveryPoint.matchId,
        targetMatchId: input.matchId,
      });
    }
    // B2: явный targetSnapshot может принадлежать другой сессии — восстановление
    // не имеет права применить чужой snapshot и записать reconciled_on_boot
    // в журнал целевой сессии.
    if (snapshot.sessionId !== input.sessionId) {
      throw new CoreError('CORE_INVALID_STATE_TRANSITION', 'Snapshot belongs to a different session', {
        snapshotSessionId: snapshot.sessionId,
        targetSessionId: input.sessionId,
        snapshotId: snapshot.id,
      });
    }

    // +1 запись: позволяет отличить «окно не переполнено» от «в сессии есть
    // ещё записи вне окна». Переполнение — fail-closed, а не применение
    // неполной цепочки ревизий (HC-07).
    const entries = await this.journal.listBySession(input.sessionId, PROTOTYPE_RECOVERY_JOURNAL_SCAN_LIMIT + 1);
    if (entries.length > PROTOTYPE_RECOVERY_JOURNAL_SCAN_LIMIT) {
      throw new CoreError(
        'CORE_INVALID_STATE_TRANSITION',
        'Recovery journal scan window exceeded; the durable history cannot be verified completely',
        {
          sessionId: input.sessionId,
          scanLimit: PROTOTYPE_RECOVERY_JOURNAL_SCAN_LIMIT,
          fetchedEntries: entries.length,
        },
      );
    }
    const coldCommands = readColdCommandsAfter(entries, recoveryPoint);
    const eventCandidates = readEventsAfter(entries, recoveryPoint, input.pendingEvents ?? []);

    this.runtime.restoreFromSnapshot(hotSnapshot.runtime, recoveryPoint);
    const recoveryOrder: string[] = ['snapshot:load', 'hot-runtime:restore'];
    // Ранняя сверка match recovery point с match процессора: рассогласование
    // должно остановить recovery ДО любых мутаций, а не всплывать позже
    // guard'ом внутри отдельного processor-вызова.
    if (this.eventProcessor.matchId !== recoveryPoint.matchId) {
      throw new CoreError(
        'CORE_INVALID_STATE_TRANSITION',
        'Recovery point match differs from the match served by the COLD event processor',
        {
          recoveryPointMatchId: recoveryPoint.matchId,
          processorMatchId: this.eventProcessor.matchId,
        },
      );
    }
    const appliedColdRevisions = this.applyColdCommands(coldCommands);
    if (appliedColdRevisions > 0) recoveryOrder.push('cold-revisions:apply-at-tick-boundary');

    let replayedEvents = 0;
    let committedEvents = 0;
    let deduplicatedEvents = 0;
    let lastAppliedEventId = recoveryPoint.lastAppliedEventId;
    for (const event of eventCandidates) {
      const result = await this.eventProcessor.process({ event, sessionId: input.sessionId });
      replayedEvents += 1;
      if (isCommitted(result.ack)) committedEvents += 1;
      else deduplicatedEvents += 1;
      lastAppliedEventId = event.eventId;
    }
    if (replayedEvents > 0) recoveryOrder.push('durable-events:idempotent-replay');

    const recoveredRuntime = this.runtime.captureSnapshot(lastAppliedEventId);
    await this.journal.append({
      sessionId: input.sessionId,
      turnId: null,
      kind: 'reconciled_on_boot',
      payload: {
        recoveredSnapshotId: hotSnapshot.id,
        recoveryPoint,
        appliedColdRevisions,
        replayedEvents,
        committedEvents,
        deduplicatedEvents,
        recoveredSimulationTick: recoveredRuntime.runtime.simulationTick,
        recoveredColdRevision: recoveredRuntime.recoveryPoint.coldRevision,
      },
      traceId: `recovery-${input.matchId}`,
    });
    recoveryOrder.push('journal:reconciled-on-boot');

    return {
      recoveredSnapshot: hotSnapshot,
      recoveredRuntime,
      appliedColdRevisions,
      replayedEvents,
      committedEvents,
      deduplicatedEvents,
      pendingEvents: [],
      recoveryOrder,
    };
  }

  private applyColdCommands(commands: readonly ColdToHotCommand[]): number {
    for (const command of commands) {
      const receipt = this.runtime.receiveColdCommand(command);
      if (!receipt.accepted) {
        throw new CoreError('CORE_INVALID_STATE_TRANSITION', 'Recovered COLD command was rejected by HOT boundary', {
          commandId: command.commandId,
          revision: command.revision,
          reason: receipt.reason,
        });
      }
    }
    if (commands.length === 0) return 0;

    const tick = this.runtime.tick();
    const last = commands[commands.length - 1]!;
    if (
      tick.diagnostics.coldRevisionsApplied !== last.revision ||
      tick.diagnostics.awaitingColdRevision !== null ||
      this.runtime.getColdBoundaryState().coldRevision !== last.revision
    ) {
      throw new CoreError(
        'CORE_INVALID_STATE_TRANSITION',
        'HOT tick did not apply the complete recovered revision chain',
        {
          expectedRevision: last.revision,
          actualRevision: tick.diagnostics.coldRevisionsApplied,
          awaitingRevision: tick.diagnostics.awaitingColdRevision,
        },
      );
    }
    return commands.length;
  }

  getDiagnostics(hotSnapshot: HotSnapshot): RecoveryDiagnostics {
    return {
      recoveryPoint: hotSnapshot.recoveryPoint,
      snapshotAgeMs: Date.now() - new Date(hotSnapshot.createdAt).getTime(),
      transientStateRollback: hotSnapshot.snapshotVersion === 1,
    };
  }
}

type JournalEntries = Awaited<ReturnType<JournalService['listBySession']>>;

/**
 * PROTOTYPE-ONLY (HC-06/HC-07): верхняя граница журнала, читаемого при recovery.
 * Ограничение намеренно консервативно: при его достижении recovery fail-closed,
 * а не применяет неполную цепочку ревизий.
 */
export const PROTOTYPE_RECOVERY_JOURNAL_SCAN_LIMIT = 5_000;

/**
 * B1 (fail-closed): запись чужого match/worldEpoch в durable journal не может
 * быть молча исключена фильтром — иначе COLD сохранил бы mutation, который
 * recovery никогда не применит к HOT, и состояния разошлись бы навсегда.
 */
function assertSameRecoveryContext(
  kind: 'cold_to_hot_committed' | 'hot_gameplay_committed',
  entryMatchId: MatchId,
  entryWorldEpoch: WorldEpoch,
  point: HotRecoveryPoint,
  identity: { readonly commandId?: string; readonly eventId?: string; readonly revision?: number },
): void {
  if (entryMatchId === point.matchId && entryWorldEpoch === point.worldEpoch) return;
  throw new CoreError(
    'CORE_INVALID_STATE_TRANSITION',
    `Durable ${kind} entry belongs to a different match/world epoch than the recovery point`,
    {
      kind,
      entryMatchId,
      entryWorldEpoch,
      expectedMatchId: point.matchId,
      expectedWorldEpoch: point.worldEpoch,
      ...identity,
    },
  );
}

function readColdCommandsAfter(entries: JournalEntries, point: HotRecoveryPoint): ColdToHotCommand[] {
  const commands = entries
    .filter((entry) => entry.kind === 'cold_to_hot_committed')
    .map((entry) => ColdToHotJournalPayloadSchema.parse(entry.payload).command);

  for (const command of commands) {
    assertSameRecoveryContext('cold_to_hot_committed', command.matchId, command.worldEpoch, point, {
      commandId: command.commandId,
      revision: command.revision,
    });
  }

  const applicable = commands
    .filter((command) => command.revision > point.coldRevision)
    .sort((a, b) => a.revision - b.revision);

  let expected = point.coldRevision + 1;
  for (const command of applicable) {
    if (command.revision !== expected) {
      throw new CoreError('CORE_INVALID_STATE_TRANSITION', 'COLD recovery revision chain is not contiguous', {
        expectedRevision: expected,
        actualRevision: command.revision,
        commandId: command.commandId,
      });
    }
    expected += 1;
  }
  return applicable;
}

function readEventsAfter(
  entries: JournalEntries,
  point: HotRecoveryPoint,
  transientPending: readonly HotGameplayEventEnvelope[],
): HotGameplayEventEnvelope[] {
  const committed = entries
    .filter((entry) => entry.kind === 'hot_gameplay_committed')
    .map((entry) => HotGameplayJournalPayloadSchema.parse(entry.payload).event);

  for (const event of committed) {
    assertSameRecoveryContext('hot_gameplay_committed', event.matchId, event.worldEpoch, point, {
      eventId: event.eventId,
    });
  }

  const ordered = committed.sort((a, b) => a.eventSequence - b.eventSequence);
  let after = ordered;
  if (point.lastAppliedEventId !== null) {
    const watermark = ordered.findIndex((event) => event.eventId === point.lastAppliedEventId);
    if (watermark < 0) {
      throw new CoreError('CORE_INVALID_STATE_TRANSITION', 'Snapshot event watermark is absent from durable journal', {
        lastAppliedEventId: point.lastAppliedEventId,
      });
    }
    after = ordered.slice(watermark + 1);
  }

  const known = new Set(ordered.map((event) => event.eventId));
  const result = [...after];
  for (const event of transientPending) {
    if (event.matchId !== point.matchId || event.worldEpoch !== point.worldEpoch) {
      throw new CoreError(
        'CORE_INVALID_STATE_TRANSITION',
        'Pending event context differs from snapshot recovery point',
        {
          eventId: event.eventId,
          eventMatchId: event.matchId,
          eventWorldEpoch: event.worldEpoch,
        },
      );
    }
    if (!known.has(event.eventId)) result.push(event);
  }
  return result.sort((a, b) => a.eventSequence - b.eventSequence || a.eventId.localeCompare(b.eventId));
}

function isCommitted(ack: HotGameplayEventAck): boolean {
  return ack.outcome === 'committed';
}
