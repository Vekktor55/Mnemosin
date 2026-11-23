import { type MatchId, type SessionId, type HotGameplayEventEnvelope, type HotSnapshot } from '@mnemosin/contracts';
import { type SnapshotRecoveryOrchestrator } from './snapshot-recovery.js';

export interface CrashWindow {
  readonly afterEventCreated: boolean;
  readonly afterColdCommit: boolean;
  readonly afterAckSent: boolean;
  readonly afterSnapshotWritten: boolean;
}

export interface CrashSimulationResult {
  readonly window: CrashWindow;
  readonly recoveredSnapshot: HotSnapshot | null;
  readonly replayedEvents: number;
  readonly pendingEventsBeforeCrash: number;
  readonly pendingEventsAfterRecovery: number;
  readonly transientStateRollback: boolean;
}

export class CrashRestartHarness {
  private readonly recovery: SnapshotRecoveryOrchestrator;

  private eventsBeforeCrash: HotGameplayEventEnvelope[] = [];
  private snapshotsBeforeCrash: HotSnapshot[] = [];
  private coldCommitsBeforeCrash = 0;

  constructor(deps: { readonly recovery: SnapshotRecoveryOrchestrator }) {
    this.recovery = deps.recovery;
  }

  recordEventCreated(event: HotGameplayEventEnvelope): void {
    this.eventsBeforeCrash.push(event);
  }

  recordColdCommit(): void {
    this.coldCommitsBeforeCrash += 1;
  }

  recordSnapshotWritten(snapshot: HotSnapshot): void {
    this.snapshotsBeforeCrash.push(snapshot);
  }

  async simulateCrashAndRestart(
    sessionId: SessionId,
    matchId: MatchId,
    crashWindow: CrashWindow,
  ): Promise<CrashSimulationResult> {
    const pendingEventsBeforeCrash = this.eventsBeforeCrash.length;
    const lastSnapshot = this.snapshotsBeforeCrash[this.snapshotsBeforeCrash.length - 1] ?? null;

    // Simulate crash: clear in-memory state
    this.eventsBeforeCrash = [];
    this.snapshotsBeforeCrash = [];

    // Recovery
    let recoveredSnapshot: HotSnapshot | null = null;
    let replayedEvents = 0;
    let transientStateRollback = false;

    if (lastSnapshot) {
      const recoveryResult = await this.recovery.recover({
        matchId,
        sessionId,
        targetSnapshot: lastSnapshot.id,
      });
      recoveredSnapshot = recoveryResult.recoveredSnapshot;
      replayedEvents = recoveryResult.replayedEvents;
      transientStateRollback = recoveryResult.recoveredSnapshot.snapshotVersion === 1;
    }

    const pendingEventsAfterRecovery = this.eventsBeforeCrash.length;

    return {
      window: crashWindow,
      recoveredSnapshot,
      replayedEvents,
      pendingEventsBeforeCrash,
      pendingEventsAfterRecovery,
      transientStateRollback,
    };
  }

  getDiagnostics(): {
    readonly eventsCreated: number;
    readonly coldCommits: number;
    readonly snapshotsWritten: number;
  } {
    return {
      eventsCreated: this.eventsBeforeCrash.length,
      coldCommits: this.coldCommitsBeforeCrash,
      snapshotsWritten: this.snapshotsBeforeCrash.length,
    };
  }
}
