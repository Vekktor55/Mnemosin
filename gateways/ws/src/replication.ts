import {
  type EventId,
  type EventSequence,
  InputSequence,
  type MatchId,
  MessageId,
  SceneSequence,
  SnapshotId,
  type SimulationTick,
  type SceneDeltaPayload,
  type SceneKeyframePayload,
  type SceneProjection,
  type WsServerEnvelope,
  type WorldEpoch,
} from '@mnemosin/contracts';

import type { ConnectionRegistry, WsConnectionRecord } from './connection-registry.js';
import type { WsGatewayDeps, WsHotTickResult } from './deps.js';
import { buildProjection, ownActorState } from './projections.js';

type EnvelopeType = WsServerEnvelope['type'];
type PayloadOf<T extends EnvelopeType> = Extract<WsServerEnvelope, { type: T }>['payload'];

export class SceneReplicationService {
  constructor(
    private readonly deps: WsGatewayDeps,
    private readonly registry: ConnectionRegistry,
  ) {}

  readonly envelope = <T extends EnvelopeType>(
    type: T,
    payload: PayloadOf<T>,
  ): Extract<WsServerEnvelope, { type: T }> =>
    ({
      protocolVersion: 'v1',
      schemaVersion: 1,
      messageId: MessageId.parse(this.deps.newId?.() ?? crypto.randomUUID()),
      type,
      payload,
    }) as Extract<WsServerEnvelope, { type: T }>;

  publish(result: WsHotTickResult): void {
    for (const acknowledgement of result.acknowledgements) {
      const recipient = this.registry.byInputStream(acknowledgement.inputStreamId);
      if (recipient !== undefined) {
        this.sendReliable(recipient, this.envelope('scene:input-ack', acknowledgement));
      }
    }
    for (const connection of this.registry.all()) {
      if (connection.state === 'ready') this.publishDelta(connection);
    }
    for (const connection of this.registry.all()) connection.delivery.flush();
  }

  /** Reliable durable gameplay event; bypasses delta coalescing entirely. */
  publishDurableEvent(
    connection: WsConnectionRecord,
    event: {
      readonly eventId: EventId;
      readonly eventSequence: EventSequence;
      readonly matchId: MatchId;
      readonly worldEpoch: WorldEpoch;
      readonly simulationTick: SimulationTick;
      readonly payload: unknown;
    },
  ): boolean {
    const envelope = this.envelope('scene:durable-event', {
      eventId: event.eventId,
      eventSequence: event.eventSequence,
      matchId: event.matchId,
      worldEpoch: event.worldEpoch,
      simulationTick: event.simulationTick,
      payload: event.payload,
    });
    return this.sendReliable(connection, envelope);
  }

  sendKeyframe(connection: WsConnectionRecord): boolean {
    const projection = this.currentProjection(connection);
    connection.delivery.discardDeltasForKeyframe();
    const player = this.deps.hot.runtime
      .getState()
      .players.find((candidate) => candidate.participantId === connection.context.actorId);
    const sequence = this.allocateSequence(connection);
    const payload: SceneKeyframePayload = {
      matchId: connection.context.matchId,
      worldEpoch: this.deps.scene.worldEpoch,
      snapshotId: SnapshotId.parse(this.deps.newId?.() ?? crypto.randomUUID()),
      sceneSequence: sequence,
      simulationTick: this.deps.hot.runtime.getState().simulationTick,
      serverTimeMs: this.serverTimeMs(),
      projectionRevision: this.deps.scene.projectionRevision,
      worldPackVersion: this.deps.scene.worldPackVersion,
      projection,
      ...(connection.context.actorType === 'player'
        ? { ownActorState: ownActorState(this.deps.hot.runtime.getState(), connection.context.actorId) }
        : {}),
      ...(player?.lastProcessedInputSequence !== null && player?.lastProcessedInputSequence !== undefined
        ? { lastProcessedInputSequence: InputSequence.parse(player.lastProcessedInputSequence) }
        : {}),
      ...(connection.context.actorType === 'player' ? { inputStreamId: connection.inputStreamId } : {}),
    };
    if (!this.sendReliable(connection, this.envelope('scene:keyframe', payload))) return false;
    connection.lastProjection = projection;
    connection.lastGeneratedSceneSequence = sequence;
    return true;
  }

  requestResync(connection: WsConnectionRecord): void {
    this.sendReliable(
      connection,
      this.envelope('scene:resync-required', {
        reason: 'client_recovery',
        ...(connection.lastGeneratedSceneSequence > 0
          ? { lastValidSceneSequence: connection.lastGeneratedSceneSequence }
          : {}),
      }),
    );
    this.sendKeyframe(connection);
  }

  private publishDelta(connection: WsConnectionRecord): void {
    const projection = this.currentProjection(connection);
    const previous = connection.lastProjection;
    if (previous === null || previous.projectionKind !== projection.projectionKind) {
      this.requestResync(connection);
      return;
    }
    const sequence = this.allocateSequence(connection);
    const baseSceneSequence = connection.lastGeneratedSceneSequence;
    const changes = projectionChanges(previous, projection);
    const player = this.deps.hot.runtime
      .getState()
      .players.find((candidate) => candidate.participantId === connection.context.actorId);
    const payload: SceneDeltaPayload = {
      matchId: connection.context.matchId,
      worldEpoch: this.deps.scene.worldEpoch,
      sceneSequence: sequence,
      baseSceneSequence,
      simulationTick: this.deps.hot.runtime.getState().simulationTick,
      serverTimeMs: this.serverTimeMs(),
      projectionRevision: this.deps.scene.projectionRevision,
      projectionKind: projection.projectionKind,
      ...changes,
      ...(connection.context.actorType === 'player'
        ? { ownActorState: ownActorState(this.deps.hot.runtime.getState(), connection.context.actorId) }
        : {}),
      ...(player?.lastProcessedInputSequence !== null && player?.lastProcessedInputSequence !== undefined
        ? { lastProcessedInputSequence: InputSequence.parse(player.lastProcessedInputSequence) }
        : {}),
      ...(connection.context.actorType === 'player' ? { inputStreamId: connection.inputStreamId } : {}),
    };
    const result = connection.delivery.enqueueDelta(this.envelope('scene:delta', payload));
    if (result === 'resync-required') {
      this.sendReliable(
        connection,
        this.envelope('scene:resync-required', {
          reason: 'projection_reset',
          lastValidSceneSequence: baseSceneSequence,
        }),
      );
      this.sendKeyframe(connection);
      return;
    }
    connection.lastProjection = projection;
    connection.lastGeneratedSceneSequence = sequence;
  }

  private currentProjection(connection: WsConnectionRecord): SceneProjection {
    return buildProjection(
      connection.context.projectionKind,
      this.deps.hot.runtime.getState(),
      this.deps.scene,
      this.deps.hiddenFacts,
    );
  }

  sendReliable(connection: WsConnectionRecord, envelope: WsServerEnvelope): boolean {
    const sent = connection.delivery.enqueueReliable(envelope);
    if (!sent) {
      connection.state = 'closing';
      connection.socket.close(4429, '{"code":"SERVER_BUSY"}');
    }
    return sent;
  }

  private serverTimeMs(): number {
    return Math.max(0, Math.trunc((this.deps.now ?? Date.now)()));
  }

  private allocateSequence(connection: WsConnectionRecord): SceneSequence {
    return SceneSequence.parse(connection.lastGeneratedSceneSequence + 1);
  }
}

function projectionChanges(previous: SceneProjection, current: SceneProjection) {
  const previousEntities = new Map(previous.entities.map((entity) => [entity.participantId, entity]));
  const currentEntities = new Map(current.entities.map((entity) => [entity.participantId, entity]));
  const entityUpserts = current.entities.filter((entity) => {
    const before = previousEntities.get(entity.participantId);
    return before === undefined || JSON.stringify(before) !== JSON.stringify(entity);
  });
  const entityRemovals = [...previousEntities.keys()].filter((id) => !currentEntities.has(id));
  const previousObjects = new Map(previous.objects.map((object) => [object.objectId, object]));
  const currentObjects = new Map(current.objects.map((object) => [object.objectId, object]));
  const objectUpserts = current.objects.filter((object) => {
    const before = previousObjects.get(object.objectId);
    return before === undefined || JSON.stringify(before) !== JSON.stringify(object);
  });
  const objectRemovals = [...previousObjects.keys()].filter((id) => !currentObjects.has(id));
  return {
    entityUpserts,
    entityRemovals,
    objectUpserts,
    objectRemovals,
    ...(JSON.stringify(previous.environment) !== JSON.stringify(current.environment)
      ? { environment: { ...current.environment } }
      : {}),
  };
}
