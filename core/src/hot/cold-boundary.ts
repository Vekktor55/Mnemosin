import {
  ColdToHotCommandSchema,
  type MatchId,
  type ParticipantId,
  type WorldEpoch,
  type ColdToHotCommand,
  type CommandId,
  type Scalar,
} from '@mnemosin/contracts';

export interface HotColdBridgeOptions {
  readonly matchId: MatchId;
  readonly worldEpoch: WorldEpoch;
  readonly coldRevision?: number;
  readonly prototypeFacts?: HotColdBridgeState['prototypeFacts'];
}

export interface HotColdBridgeState {
  readonly matchId: MatchId;
  readonly worldEpoch: WorldEpoch;
  readonly coldRevision: number;
  readonly prototypeFacts: Partial<Record<ParticipantId, Record<string, Scalar>>>;
}

export interface HotColdTickBoundaryResult {
  readonly appliedRevision: number;
  readonly appliedCommandIds: readonly CommandId[];
  readonly awaitingRevision: number | null;
}

export type ColdCommandReceipt =
  | { readonly accepted: true; readonly revision: number }
  | {
      readonly accepted: false;
      readonly reason: 'invalid_command' | 'context_mismatch' | 'duplicate' | 'stale' | 'revision_conflict';
    };

/**
 * Только ingress/очередь. drainForTick вызывается HotRuntime строго до movement
 * в следующем fixed step; DB и wall-clock здесь отсутствуют.
 */
export class HotColdRevisionBoundary {
  private readonly pending = new Map<number, ColdToHotCommand>();
  private state: HotColdBridgeState;

  constructor(options: HotColdBridgeOptions) {
    this.state = {
      matchId: options.matchId,
      worldEpoch: options.worldEpoch,
      coldRevision: options.coldRevision ?? 0,
      prototypeFacts: copyFacts(options.prototypeFacts ?? {}),
    };
  }

  receive(raw: unknown): ColdCommandReceipt {
    const parsed = ColdToHotCommandSchema.safeParse(raw);
    if (!parsed.success) return { accepted: false, reason: 'invalid_command' };
    const command = parsed.data;
    if (command.matchId !== this.state.matchId || command.worldEpoch !== this.state.worldEpoch) {
      return { accepted: false, reason: 'context_mismatch' };
    }
    if (command.revision < this.state.coldRevision) return { accepted: false, reason: 'stale' };
    if (command.revision === this.state.coldRevision) return { accepted: false, reason: 'duplicate' };
    const queued = this.pending.get(command.revision);
    if (queued !== undefined) {
      return JSON.stringify(queued) === JSON.stringify(command)
        ? { accepted: false, reason: 'duplicate' }
        : { accepted: false, reason: 'revision_conflict' };
    }
    this.pending.set(command.revision, command);
    return { accepted: true, revision: command.revision };
  }

  /** Применяет только непрерывный revision chain; gap остаётся ожидать missing revision. */
  drainForTick(): HotColdTickBoundaryResult {
    const appliedCommandIds: CommandId[] = [];
    const facts = copyFacts(this.state.prototypeFacts);
    let revision = this.state.coldRevision;
    for (;;) {
      const next = this.pending.get(revision + 1);
      if (next === undefined) break;
      this.pending.delete(revision + 1);
      revision = next.revision;
      const participantFacts = { ...(facts[next.target.participantId] ?? {}) };
      participantFacts[next.payload.key] = next.payload.value;
      facts[next.target.participantId] = participantFacts;
      appliedCommandIds.push(next.commandId);
    }
    this.state = { ...this.state, coldRevision: revision, prototypeFacts: facts };
    return {
      appliedRevision: revision,
      appliedCommandIds,
      awaitingRevision: this.pending.has(revision + 1) ? null : (this.pending.keys().next().value ?? null),
    };
  }

  getState(): HotColdBridgeState {
    return { ...this.state, prototypeFacts: copyFacts(this.state.prototypeFacts) };
  }
}

function copyFacts(source: HotColdBridgeState['prototypeFacts']): HotColdBridgeState['prototypeFacts'] {
  const copy: Record<string, Record<string, Scalar>> = {};
  for (const [participantId, facts] of Object.entries(source ?? {})) {
    copy[participantId] = { ...facts };
  }
  return copy as HotColdBridgeState['prototypeFacts'];
}
