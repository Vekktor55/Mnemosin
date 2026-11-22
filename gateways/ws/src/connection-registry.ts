import {
  ConnectionEpoch,
  SceneSequence,
  type InputStreamId,
  type ParticipantId,
  type SceneProjection,
} from '@mnemosin/contracts';
import type { WebSocket } from '@fastify/websocket';

import { SceneDeliveryQueue } from './delivery.js';
import type { ConnectionActorContext, RealtimeNetworkConfig, WsConnectionState } from './deps.js';

export class WsConnectionRecord {
  state: WsConnectionState = 'awaiting_client_ready';
  lastProjection: SceneProjection | null = null;
  lastGeneratedSceneSequence = SceneSequence.parse(0);
  lastHeartbeatAt = Date.now();
  rateWindowStartedAt = Date.now();
  inputCount = 0;
  readonly delivery: SceneDeliveryQueue;

  constructor(
    readonly socket: WebSocket,
    readonly context: ConnectionActorContext,
    readonly inputStreamId: InputStreamId,
    limits: RealtimeNetworkConfig,
    isBackpressured: (bufferedAmount: number, limit: number) => boolean,
  ) {
    this.delivery = new SceneDeliveryQueue(
      socket,
      limits.maxQueuedMessages,
      limits.maxBufferedBytes,
      isBackpressured,
      () => undefined,
    );
  }
}

export class ConnectionRegistry {
  private readonly connections = new Map<string, WsConnectionRecord>();
  private readonly epochs = new Map<ParticipantId, number>();

  nextEpoch(participantId: ParticipantId): ConnectionEpoch {
    const next = (this.epochs.get(participantId) ?? 0) + 1;
    this.epochs.set(participantId, next);
    return ConnectionEpoch.parse(next);
  }

  add(record: WsConnectionRecord): void {
    this.connections.set(record.context.connectionId, record);
  }

  get(connectionId: string): WsConnectionRecord | undefined {
    return this.connections.get(connectionId);
  }

  byInputStream(inputStreamId: InputStreamId): WsConnectionRecord | undefined {
    return [...this.connections.values()].find(
      (record) => record.inputStreamId === inputStreamId && record.state === 'ready',
    );
  }

  controlling(actorId: ParticipantId, exceptConnectionId?: string): WsConnectionRecord | undefined {
    return [...this.connections.values()].find(
      (record) =>
        record.context.actorId === actorId &&
        record.context.connectionId !== exceptConnectionId &&
        record.state !== 'closing' &&
        record.state !== 'closed',
    );
  }

  remove(connectionId: string): void {
    const record = this.connections.get(connectionId);
    if (record !== undefined) record.state = 'closed';
    this.connections.delete(connectionId);
  }

  all(): readonly WsConnectionRecord[] {
    return [...this.connections.values()];
  }

  closeAll(): void {
    for (const record of this.connections.values()) {
      record.state = 'closing';
      record.socket.close(1001, 'server shutdown');
    }
    this.connections.clear();
  }
}
