import type {
  EventId,
  MatchId,
  SnapshotId,
  SessionId,
  HotGameplayEventEnvelope,
  HotRecoveryPoint,
  HotSnapshot,
} from '@mnemosin/contracts';
import type { UnitOfWork, SnapshotRepository } from '../domain/ports/index.js';
import type { JournalService } from '../turns/index.js';
import type { ColdGameplayEventProcessor } from './gameplay-event-processor.js';

export interface SnapshotRecoveryInput {
  readonly matchId: MatchId;
  readonly sessionId: SessionId;
  readonly targetSnapshot?: SnapshotId;
}

export interface RecoveryResult {
  readonly recoveredSnapshot: HotSnapshot;
  readonly appliedColdRevisions: number;
  readonly replayedEvents: number;
  readonly pendingEvents: readonly HotGameplayEventEnvelope[];
}

export interface RecoveryDiagnostics {
  readonly recoveryPoint: HotRecoveryPoint;
  readonly snapshotAgeMs: number;
  readonly transientStateRollback: boolean;
}

export class SnapshotRecoveryOrchestrator {
  private readonly snapshotRepo: SnapshotRepository;
  private readonly journal: JournalService;
  private readonly eventProcessor: ColdGameplayEventProcessor;

  constructor(deps: {
    readonly uow: UnitOfWork;
    readonly snapshotRepo: SnapshotRepository;
    readonly journal: JournalService;
    readonly eventProcessor: ColdGameplayEventProcessor;
  }) {
    this.snapshotRepo = deps.snapshotRepo;
    this.journal = deps.journal;
    this.eventProcessor = deps.eventProcessor;
  }

  async recover(input: SnapshotRecoveryInput): Promise<RecoveryResult> {
    const snapshot = input.targetSnapshot
      ? await this.snapshotRepo.findById(input.targetSnapshot)
      : await this.snapshotRepo.findLatestBySession(input.sessionId);

    if (!snapshot) {
      throw new Error(`No snapshot found for session ${input.sessionId}`);
    }

    const hotSnapshot = snapshot.snapshotVersion === 1 ? (snapshot as HotSnapshot) : null;
    if (!hotSnapshot) {
      throw new Error('Only HOT v1 snapshots supported for recovery');
    }

    const recoveryPoint = hotSnapshot.recoveryPoint;
    const coldRevisionsToApply = await this.getColdRevisionsAfter(input.sessionId, recoveryPoint.coldRevision);
    let appliedColdRevisions = 0;

    for (const _revision of coldRevisionsToApply) {
      appliedColdRevisions += 1;
    }

    const pendingEvents = await this.getPendingEventsAfter(input.sessionId, recoveryPoint.lastAppliedEventId);
    let replayedEvents = 0;

    for (const event of pendingEvents) {
      await this.eventProcessor.process({ event, sessionId: input.sessionId });
      replayedEvents += 1;
    }

    await this.journal.append({
      sessionId: input.sessionId,
      turnId: null,
      kind: 'reconciled_on_boot',
      payload: {
        recoveredSnapshotId: hotSnapshot.id,
        recoveryPoint,
        appliedColdRevisions,
        replayedEvents,
      },
      traceId: `recovery-${input.matchId}`,
    });

    return {
      recoveredSnapshot: hotSnapshot,
      appliedColdRevisions,
      replayedEvents,
      pendingEvents,
    };
  }

  private async getColdRevisionsAfter(sessionId: SessionId, afterRevision: number): Promise<number[]> {
    const entries = await this.journal.listBySession(sessionId, 500);
    return entries
      .filter((e) => e.kind === 'state_applied' && ((e.payload?.toVersion as number | undefined) ?? 0) > afterRevision)
      .map((e) => (e.payload?.toVersion as number) ?? 0);
  }

  private async getPendingEventsAfter(
    sessionId: SessionId,
    afterEventId: EventId | null,
  ): Promise<HotGameplayEventEnvelope[]> {
    const entries = await this.journal.listBySession(sessionId, 500);
    const filtered = entries.filter((e) => e.kind === 'hot_gameplay_committed');
    if (afterEventId === null) return filtered.map((e) => e.payload?.event as HotGameplayEventEnvelope).filter(Boolean);
    const afterIndex = filtered.findIndex(
      (e) => (e.payload as { event?: { eventId: string } })?.event?.eventId === afterEventId,
    );
    return filtered
      .slice(afterIndex + 1)
      .map((e) => e.payload?.event as HotGameplayEventEnvelope)
      .filter(Boolean);
  }

  getDiagnostics(hotSnapshot: HotSnapshot): RecoveryDiagnostics {
    return {
      recoveryPoint: hotSnapshot.recoveryPoint,
      snapshotAgeMs: Date.now() - new Date(hotSnapshot.createdAt).getTime(),
      transientStateRollback: hotSnapshot.snapshotVersion === 1,
    };
  }
}
