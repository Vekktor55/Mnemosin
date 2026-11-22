import { describe, expect, it } from 'vitest';

import {
  SceneDeltaPayloadSchema,
  WsServerEnvelopeSchema,
  type SceneDeltaPayload,
  type WsServerEnvelope,
} from '@mnemosin/contracts';
import { SceneDeliveryQueue, coalesceSceneDeltas } from '@mnemosin/gateway-ws';

const uuid = (suffix: string) => `00000000-0000-4000-8000-${suffix}`;
const ids = {
  matchId: uuid('000000000001'),
  participantId: uuid('000000000002'),
  objectId: uuid('000000000003'),
  snapshotId: uuid('000000000004'),
  worldId: uuid('000000000005'),
  floorId: uuid('000000000006'),
  worldSpaceId: uuid('000000000007'),
};

type DeliverySocket = ConstructorParameters<typeof SceneDeliveryQueue>[0];
type DeltaEnvelope = Extract<WsServerEnvelope, { type: 'scene:delta' }>;

/** Unit-only WebSocket fake: no network, timers or integration server. */
class FakeWebSocket {
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: string[] = [];

  send(serialized: string): void {
    this.sent.push(serialized);
  }

  asDeliverySocket(): DeliverySocket {
    return this as unknown as DeliverySocket;
  }
}

let messageSequence = 0;
function envelope<T extends WsServerEnvelope['type']>(
  type: T,
  payload: Extract<WsServerEnvelope, { type: T }>['payload'],
): Extract<WsServerEnvelope, { type: T }> {
  messageSequence += 1;
  return WsServerEnvelopeSchema.parse({
    protocolVersion: 'v1',
    schemaVersion: 1,
    messageId: uuid(String(messageSequence).padStart(12, '0')),
    type,
    payload,
  }) as Extract<WsServerEnvelope, { type: T }>;
}

function delta(
  sceneSequence: number,
  baseSceneSequence: number,
  changes: Partial<SceneDeltaPayload> = {},
): SceneDeltaPayload {
  return SceneDeltaPayloadSchema.parse({
    matchId: ids.matchId,
    worldEpoch: 1,
    sceneSequence,
    baseSceneSequence,
    simulationTick: sceneSequence * 10,
    serverTimeMs: sceneSequence * 100,
    projectionRevision: 1,
    projectionKind: 'player',
    entityUpserts: [],
    entityRemovals: [],
    objectUpserts: [],
    objectRemovals: [],
    ...changes,
  });
}

function deltaEnvelope(payload: SceneDeltaPayload): DeltaEnvelope {
  return envelope('scene:delta', payload);
}

function pong(pingId: string): WsServerEnvelope {
  return envelope('connection:pong', { pingId, serverTimeMs: 1_000, simulationTick: 10 });
}

function keyframe(): WsServerEnvelope {
  return envelope('scene:keyframe', {
    matchId: ids.matchId,
    worldEpoch: 1,
    snapshotId: ids.snapshotId,
    sceneSequence: 7,
    simulationTick: 70,
    serverTimeMs: 700,
    projectionRevision: 1,
    worldPackVersion: '4.0.0-test',
    projection: {
      projectionKind: 'player',
      entities: [],
      objects: [],
      environment: { worldId: ids.worldId, floorId: ids.floorId, worldSpaceId: ids.worldSpaceId },
    },
  });
}

function createQueue(maxQueuedMessages = 16, maxBufferedBytes = 64) {
  const socket = new FakeWebSocket();
  const delivered: WsServerEnvelope[] = [];
  const queue = new SceneDeliveryQueue(
    socket.asDeliverySocket(),
    maxQueuedMessages,
    maxBufferedBytes,
    (bufferedAmount, limit) => bufferedAmount >= limit,
    (sent) => delivered.push(sent),
  );
  const sentEnvelopes = () => socket.sent.map((serialized) => WsServerEnvelopeSchema.parse(JSON.parse(serialized)));
  return { queue, socket, delivered, sentEnvelopes };
}

describe('coalesceSceneDeltas', () => {
  it('merges contiguous deltas with the oldest base and newest sequence/state', () => {
    const older = delta(2, 1, {
      entityUpserts: [{ participantId: ids.participantId, position: { x: 1, y: 1 }, velocity: { x: 0, y: 0 } }],
      objectUpserts: [{ objectId: ids.objectId, position: { x: 4, y: 4 }, portalState: 'closed' }],
    });
    const newer = delta(3, 2, {
      entityUpserts: [{ participantId: ids.participantId, position: { x: 2, y: 2 }, velocity: { x: 1, y: 0 } }],
      objectRemovals: [ids.objectId],
    });

    const merged = coalesceSceneDeltas(older, newer);

    expect(merged).not.toBeNull();
    expect(merged).toMatchObject({
      baseSceneSequence: 1,
      sceneSequence: 3,
      simulationTick: 30,
      serverTimeMs: 300,
      entityUpserts: [{ participantId: ids.participantId, position: { x: 2, y: 2 }, velocity: { x: 1, y: 0 } }],
      entityRemovals: [],
      objectUpserts: [],
      objectRemovals: [ids.objectId],
    });
  });

  it.each([
    ['a base sequence gap', delta(5, 4)],
    ['another match', delta(3, 2, { matchId: uuid('000000000099') })],
    ['another world epoch', delta(3, 2, { worldEpoch: 2 })],
    ['another projection revision', delta(3, 2, { projectionRevision: 2 })],
    ['another projection kind', delta(3, 2, { projectionKind: 'observer' })],
  ])('does not coalesce %s', (_case, newer) => {
    expect(coalesceSceneDeltas(delta(2, 1), newer)).toBeNull();
  });
});

describe('SceneDeliveryQueue', () => {
  it('serializes one coalesced contiguous delta with the full sequence chain', () => {
    const { queue, socket, delivered, sentEnvelopes } = createQueue();

    expect(queue.enqueueDelta(deltaEnvelope(delta(2, 1)))).toBe('queued');
    expect(queue.enqueueDelta(deltaEnvelope(delta(3, 2)))).toBe('coalesced');
    expect(queue.size).toBe(1);
    expect(queue.deltaCount).toBe(1);
    expect(queue.reliableCount).toBe(0);

    socket.readyState = 1;
    queue.flush();

    const sent = sentEnvelopes();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'scene:delta',
      payload: { baseSceneSequence: 1, sceneSequence: 3 },
    });
    expect(delivered).toEqual(sent);
  });

  it('keeps reliable FIFO and never coalesces deltas across a reliable barrier', () => {
    const { queue, socket, sentEnvelopes } = createQueue();

    expect(queue.enqueueDelta(deltaEnvelope(delta(2, 1)))).toBe('queued');
    expect(queue.enqueueReliable(pong('reliable-0001'))).toBe(true);
    expect(queue.enqueueDelta(deltaEnvelope(delta(3, 2)))).toBe('queued');
    expect(queue.enqueueReliable(pong('reliable-0002'))).toBe(true);
    expect(queue.deltaCount).toBe(2);
    expect(queue.reliableCount).toBe(2);

    socket.readyState = 1;
    socket.bufferedAmount = 64;
    queue.flush();
    expect(socket.sent).toEqual([]);
    expect(queue.size).toBe(4);

    socket.bufferedAmount = 0;
    queue.flush();
    const sent = sentEnvelopes();
    expect(sent.map((message) => message.type)).toEqual([
      'scene:delta',
      'connection:pong',
      'scene:delta',
      'connection:pong',
    ]);
    expect(
      sent.filter((message) => message.type === 'connection:pong').map((message) => message.payload.pingId),
    ).toEqual(['reliable-0001', 'reliable-0002']);
    expect(queue.size).toBe(0);
  });

  it('returns resync on a base gap and discards only deltas for keyframe recovery', () => {
    const { queue, socket, sentEnvelopes } = createQueue(2);

    expect(queue.enqueueReliable(pong('reliable-before-gap'))).toBe(true);
    expect(queue.enqueueDelta(deltaEnvelope(delta(2, 1)))).toBe('queued');

    // The broken chain is rejected without evicting reliable entries or queueing the newer delta.
    expect(queue.enqueueDelta(deltaEnvelope(delta(4, 3)))).toBe('resync-required');
    expect(queue.size).toBe(2);
    expect(queue.deltaCount).toBe(1);
    expect(queue.reliableCount).toBe(1);

    queue.discardDeltasForKeyframe();
    expect(queue.size).toBe(1);
    expect(queue.deltaCount).toBe(0);
    expect(queue.reliableCount).toBe(1);

    expect(queue.enqueueReliable(keyframe())).toBe(true);
    socket.readyState = 1;
    queue.flush();

    const sent = sentEnvelopes();
    expect(sent.map((message) => message.type)).toEqual(['connection:pong', 'scene:keyframe']);
    expect(sent[0]).toMatchObject({ type: 'connection:pong', payload: { pingId: 'reliable-before-gap' } });
    expect(queue.reliableCount).toBe(0);
  });
});
