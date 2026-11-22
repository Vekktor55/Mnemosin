import { describe, expect, it } from 'vitest';

import {
  WS_CLIENT_MESSAGE_TYPES,
  WS_SERVER_MESSAGE_TYPES,
  WsClientEnvelopeSchema,
  WsEnvelopeSchema,
  WsErrorPayloadSchema,
  WsServerEnvelopeSchema,
  type SceneDeltaPayload,
  type SceneKeyframePayload,
  type WsClientEnvelope,
} from '@mnemosin/contracts';

const uuid = (suffix: string) => `00000000-0000-4000-8000-${suffix}`;
const ids = {
  matchId: uuid('000000000001'),
  messageId: uuid('000000000002'),
  actorId: uuid('000000000003'),
  connectionId: uuid('000000000004'),
  inputStreamId: uuid('000000000005'),
  snapshotId: uuid('000000000006'),
  participantId: uuid('000000000007'),
  objectId: uuid('000000000008'),
  worldId: uuid('000000000009'),
  floorId: uuid('000000000010'),
  worldSpaceId: uuid('000000000011'),
};

function envelope<T extends WsClientEnvelope['type']>(
  type: T,
  payload: Extract<WsClientEnvelope, { type: T }>['payload'],
) {
  return { protocolVersion: 'v1', schemaVersion: 1, messageId: ids.messageId, type, payload };
}

const projection = {
  projectionKind: 'player',
  entities: [],
  objects: [],
  environment: { worldId: ids.worldId, floorId: ids.floorId, worldSpaceId: ids.worldSpaceId },
} as const;

const keyframe: SceneKeyframePayload = {
  matchId: ids.matchId,
  worldEpoch: 1,
  snapshotId: ids.snapshotId,
  sceneSequence: 1,
  simulationTick: 10,
  serverTimeMs: 500,
  projectionRevision: 1,
  worldPackVersion: '4.0.0-test',
  projection,
};

const delta: SceneDeltaPayload = {
  matchId: ids.matchId,
  worldEpoch: 1,
  sceneSequence: 2,
  baseSceneSequence: 1,
  simulationTick: 11,
  serverTimeMs: 550,
  projectionRevision: 1,
  projectionKind: 'player',
  entityUpserts: [],
  entityRemovals: [],
  objectUpserts: [],
  objectRemovals: [],
};

describe('v4 realtime WS envelopes', () => {
  it('has one typed catalog for the P05-A client and server messages', () => {
    expect(WS_CLIENT_MESSAGE_TYPES).toEqual([
      'connection:client-ready',
      'connection:ping',
      'scene:input',
      'scene:resync',
    ]);
    expect(WS_SERVER_MESSAGE_TYPES).toEqual([
      'connection:welcome',
      'connection:ready',
      'connection:pong',
      'connection:error',
      'scene:keyframe',
      'scene:delta',
      'scene:input-ack',
      'scene:resync-required',
    ]);
    expect(WsEnvelopeSchema.options).toHaveLength(12);
  });

  it('parses every client variant with its own payload', () => {
    const cases = [
      envelope('connection:client-ready', {}),
      envelope('connection:ping', { pingId: 'ping-001', clientTimeMs: 100 }),
      envelope('scene:input', {
        inputStreamId: ids.inputStreamId,
        inputSequence: 1,
        input: { directionX: 1, directionY: 0 },
      }),
      envelope('scene:resync', { lastAppliedSceneSequence: 4, worldEpoch: 1, reason: 'sequence_gap' }),
    ];
    for (const value of cases) expect(WsClientEnvelopeSchema.parse(value)).toEqual(value);
  });

  it('parses lifecycle, replication, ACK and resync-required server variants', () => {
    const common = { protocolVersion: 'v1', schemaVersion: 1, messageId: ids.messageId } as const;
    const cases = [
      {
        ...common,
        type: 'connection:welcome',
        payload: {
          connectionId: ids.connectionId,
          actorId: ids.actorId,
          actorType: 'player',
          matchId: ids.matchId,
          sessionId: ids.matchId,
          connectionEpoch: 2,
          inputStreamId: ids.inputStreamId,
          projectionKind: 'player',
          protocolVersion: 'v1',
          serverVersion: 'test',
          contractsVersion: 'test',
          permissions: ['scene:input'],
          isReconnect: false,
          supportedFeatures: ['scene:input'],
        },
      },
      { ...common, type: 'connection:ready', payload: {} },
      { ...common, type: 'connection:pong', payload: { pingId: 'ping-001', serverTimeMs: 10, simulationTick: 1 } },
      {
        ...common,
        type: 'connection:error',
        payload: { code: 'PROTOCOL_INVALID_MESSAGE', messageKey: 'protocol.invalid', retryable: false },
      },
      { ...common, type: 'scene:keyframe', payload: keyframe },
      { ...common, type: 'scene:delta', payload: delta },
      {
        ...common,
        type: 'scene:input-ack',
        payload: {
          inputStreamId: ids.inputStreamId,
          lastProcessedInputSequence: 1,
          simulationTick: 1,
          authoritativePosition: { x: 1, y: 1 },
          authoritativeVelocity: { x: 0, y: 0 },
        },
      },
      { ...common, type: 'scene:resync-required', payload: { lastValidSceneSequence: 1, reason: 'sequence_gap' } },
    ];
    for (const value of cases) expect(WsServerEnvelopeSchema.parse(value)).toEqual(value);
  });

  it('rejects unknown envelope fields and typed payload fields instead of accepting payload:any', () => {
    expect(
      WsClientEnvelopeSchema.safeParse({ ...envelope('connection:ping', {}), payload: { actorType: 'observer' } })
        .success,
    ).toBe(false);
    expect(WsClientEnvelopeSchema.safeParse({ ...envelope('connection:ping', {}), extra: true }).success).toBe(false);
    expect(
      WsClientEnvelopeSchema.safeParse(
        envelope('scene:input', {
          inputStreamId: ids.inputStreamId,
          inputSequence: 1,
          input: { directionX: 1, directionY: 0, speed: 1000 },
        }),
      ).success,
    ).toBe(false);
    expect(
      WsClientEnvelopeSchema.safeParse({ ...envelope('connection:ping', {}), protocolVersion: 'v2' }).success,
    ).toBe(false);
    expect(WsClientEnvelopeSchema.safeParse({ ...envelope('connection:ping', {}), type: 'TURN_UPDATE' }).success).toBe(
      false,
    );
  });

  it('keeps replication identifiers distinct and validates delta continuity', () => {
    const invalidBase = { ...delta, baseSceneSequence: delta.sceneSequence };
    expect(
      WsServerEnvelopeSchema.safeParse({
        protocolVersion: 'v1',
        schemaVersion: 1,
        messageId: ids.messageId,
        type: 'scene:delta',
        payload: invalidBase,
      }).success,
    ).toBe(false);
    expect(keyframe.inputStreamId).not.toBe(ids.connectionId);
    expect(delta.baseSceneSequence).not.toBe(delta.sceneSequence);
    expect(delta.simulationTick).not.toBe(delta.sceneSequence);
    expect(Object.keys(delta)).toEqual(
      expect.arrayContaining([
        'worldEpoch',
        'projectionRevision',
        'simulationTick',
        'sceneSequence',
        'baseSceneSequence',
      ]),
    );
    expect(delta.worldEpoch).toBe(1);
    expect(delta.projectionRevision).toBe(1);
    expect(delta.simulationTick).toBe(11);
    expect(delta.sceneSequence).toBe(2);
    expect(delta.baseSceneSequence).toBe(1);
  });

  it('keeps commandId/eventSequence out of the realtime catalog and outside scene payload', () => {
    expect(WS_CLIENT_MESSAGE_TYPES).not.toContain('domain:command');
    expect(WS_SERVER_MESSAGE_TYPES).not.toContain('domain:event');
    expect(
      WsClientEnvelopeSchema.safeParse({
        ...envelope('scene:input', {
          inputStreamId: ids.inputStreamId,
          inputSequence: 1,
          input: { directionX: 1, directionY: 0 },
        }),
        commandId: ids.messageId,
      }).success,
    ).toBe(false);
    expect(
      WsServerEnvelopeSchema.safeParse({
        protocolVersion: 'v1',
        schemaVersion: 1,
        messageId: ids.messageId,
        type: 'scene:delta',
        payload: { ...delta, eventSequence: 99 },
      }).success,
    ).toBe(false);
    expect(
      WsServerEnvelopeSchema.safeParse({
        protocolVersion: 'v1',
        schemaVersion: 1,
        messageId: ids.messageId,
        type: 'scene:delta',
        payload: { ...delta },
      }).success,
    ).toBe(true);
  });

  it('exposes each identifier only in its semantic payload scope', () => {
    const welcome = WsServerEnvelopeSchema.parse({
      protocolVersion: 'v1',
      schemaVersion: 1,
      messageId: ids.messageId,
      type: 'connection:welcome',
      payload: {
        connectionId: ids.connectionId,
        actorId: ids.actorId,
        actorType: 'player',
        matchId: ids.matchId,
        sessionId: ids.matchId,
        connectionEpoch: 2,
        inputStreamId: ids.inputStreamId,
        projectionKind: 'player',
        protocolVersion: 'v1',
        serverVersion: 'test',
        contractsVersion: 'test',
        permissions: ['scene:input'],
        isReconnect: false,
        supportedFeatures: ['scene:input'],
      },
    });
    expect(welcome.payload.connectionEpoch).toBe(2);
    expect(welcome.payload.inputStreamId).toBe(ids.inputStreamId);
    expect(welcome.messageId).toBe(ids.messageId);
    expect('commandId' in welcome.payload).toBe(false);
    expect('eventSequence' in welcome.payload).toBe(false);
    expect('sceneSequence' in welcome.payload).toBe(false);
  });

  it('rejects observer secrets in a player delta and requires explicit observer DTO fields', () => {
    const entity = {
      participantId: ids.participantId,
      position: { x: 1, y: 1 },
      velocity: { x: 0, y: 0 },
      hiddenRole: 'secret',
      infected: true,
    };
    expect(
      WsServerEnvelopeSchema.safeParse({
        protocolVersion: 'v1',
        schemaVersion: 1,
        messageId: ids.messageId,
        type: 'scene:delta',
        payload: { ...delta, entityUpserts: [entity] },
      }).success,
    ).toBe(false);
    expect(
      WsServerEnvelopeSchema.safeParse({
        protocolVersion: 'v1',
        schemaVersion: 1,
        messageId: ids.messageId,
        type: 'scene:delta',
        payload: {
          ...delta,
          projectionKind: 'observer',
          entityUpserts: [{ ...entity, hiddenRole: undefined, infected: undefined }],
        },
      }).success,
    ).toBe(false);
  });
});

describe('WsErrorPayload', () => {
  it('uses one strict machine-readable error payload', () => {
    const error = {
      code: 'INPUT_STALE',
      messageKey: 'input.stale',
      retryable: false,
      correlationId: ids.messageId,
      relatedMessageId: ids.messageId,
      details: { sequence: 1, reason: 'stale_sequence' },
    };
    expect(WsErrorPayloadSchema.parse(error)).toEqual(error);
  });

  it.each([
    { code: 'UNKNOWN', messageKey: 'bad', retryable: false },
    { code: 'AUTH_INVALID', messageKey: 'auth.invalid', retryable: false, token: 'do-not-leak' },
    { code: 'AUTH_INVALID', messageKey: 'auth.invalid', retryable: 'no' },
  ])('rejects invalid or secret-bearing error payloads: %j', (value) => {
    expect(WsErrorPayloadSchema.safeParse(value).success).toBe(false);
  });
});
