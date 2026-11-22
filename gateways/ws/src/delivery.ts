import { WsServerEnvelopeSchema, type SceneDeltaPayload, type WsServerEnvelope } from '@mnemosin/contracts';
import type { WebSocket } from '@fastify/websocket';

interface QueueEntry {
  readonly envelope: WsServerEnvelope;
  readonly serialized: string;
}

export type DeltaEnqueueResult = 'queued' | 'coalesced' | 'resync-required';

function isDelta(envelope: WsServerEnvelope): envelope is Extract<WsServerEnvelope, { type: 'scene:delta' }> {
  return envelope.type === 'scene:delta';
}

function mergeUpserts<T, K extends string>(
  older: readonly T[],
  olderRemovals: readonly K[],
  newer: readonly T[],
  newerRemovals: readonly K[],
  key: (entity: T) => K,
): { upserts: T[]; removals: K[] } {
  const upserts = new Map<K, T>();
  const removals = new Set<K>(olderRemovals);
  for (const entity of older) upserts.set(key(entity), entity);
  for (const id of newerRemovals) {
    upserts.delete(id);
    removals.add(id);
  }
  for (const entity of newer) {
    upserts.set(key(entity), entity);
    removals.delete(key(entity));
  }
  return { upserts: [...upserts.values()], removals: [...removals] };
}

/** Сохраняет base старейшей delta и sequence новейшей: пропусков цепочки нет. */
export function coalesceSceneDeltas(older: SceneDeltaPayload, newer: SceneDeltaPayload): SceneDeltaPayload | null {
  if (
    older.sceneSequence !== newer.baseSceneSequence ||
    older.matchId !== newer.matchId ||
    older.worldEpoch !== newer.worldEpoch ||
    older.projectionKind !== newer.projectionKind ||
    older.projectionRevision !== newer.projectionRevision
  ) {
    return null;
  }
  const entities = mergeUpserts(
    older.entityUpserts,
    older.entityRemovals,
    newer.entityUpserts,
    newer.entityRemovals,
    (entity) => entity.participantId,
  );
  const objects = mergeUpserts(
    older.objectUpserts,
    older.objectRemovals,
    newer.objectUpserts,
    newer.objectRemovals,
    (object) => object.objectId,
  );
  return {
    ...newer,
    baseSceneSequence: older.baseSceneSequence,
    entityUpserts: entities.upserts,
    entityRemovals: entities.removals,
    objectUpserts: objects.upserts,
    objectRemovals: objects.removals,
    environment: newer.environment ?? older.environment,
    ownActorState: newer.ownActorState ?? older.ownActorState,
    inputStreamId: newer.inputStreamId ?? older.inputStreamId,
    lastProcessedInputSequence: newer.lastProcessedInputSequence ?? older.lastProcessedInputSequence,
  };
}

/** Reliable entries никогда не вытесняются delta coalescing. */
export class SceneDeliveryQueue {
  private entries: QueueEntry[] = [];

  constructor(
    private readonly socket: WebSocket,
    private readonly maxQueuedMessages: number,
    private readonly maxBufferedBytes: number,
    private readonly isBackpressured: (bufferedAmount: number, limit: number) => boolean,
    private readonly onSent: (envelope: WsServerEnvelope) => void,
  ) {}

  get size(): number {
    return this.entries.length;
  }

  get deltaCount(): number {
    return this.entries.filter((entry) => isDelta(entry.envelope)).length;
  }

  get reliableCount(): number {
    return this.entries.filter((entry) => !isDelta(entry.envelope)).length;
  }

  enqueueReliable(envelope: WsServerEnvelope): boolean {
    if (this.entries.length >= this.maxQueuedMessages) return false;
    this.entries.push(this.serialize(envelope));
    this.flush();
    return true;
  }

  enqueueDelta(envelope: Extract<WsServerEnvelope, { type: 'scene:delta' }>): DeltaEnqueueResult {
    const previous = this.entries.at(-1);
    let result: DeltaEnqueueResult = 'queued';
    if (previous !== undefined && isDelta(previous.envelope)) {
      const merged = coalesceSceneDeltas(previous.envelope.payload, envelope.payload);
      if (merged !== null) {
        this.entries.pop();
        this.entries.push(this.serialize({ ...envelope, payload: merged }));
        result = 'coalesced';
      } else {
        return 'resync-required';
      }
    } else {
      this.entries.push(this.serialize(envelope));
    }
    if (this.entries.length > this.maxQueuedMessages) return 'resync-required';
    this.flush();
    return result;
  }

  /** Устаревшие ephemeral deltas можно заменить keyframe; reliable entries остаются FIFO. */
  discardDeltasForKeyframe(): void {
    this.entries = this.entries.filter((entry) => !isDelta(entry.envelope));
  }

  flush(): void {
    while (this.entries.length > 0 && this.socket.readyState === 1) {
      if (this.isBackpressured(this.socket.bufferedAmount, this.maxBufferedBytes)) return;
      const entry = this.entries[0];
      if (entry === undefined) return;
      this.socket.send(entry.serialized);
      this.entries.shift();
      this.onSent(entry.envelope);
    }
  }

  private serialize(envelope: WsServerEnvelope): QueueEntry {
    const parsed = WsServerEnvelopeSchema.parse(envelope);
    return { envelope: parsed, serialized: JSON.stringify(parsed) };
  }
}
