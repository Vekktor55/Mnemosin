import { describe, expect, it } from 'vitest';

import {
  ColdToHotCommandSchema,
  HotGameplayEventAckSchema,
  HotGameplayEventEnvelopeSchema,
  HotGameplayEventPayloadSchemas,
  HotSnapshotSchema,
  SnapshotSchema,
} from '@mnemosin/contracts';

const uuid = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const at = '2026-11-22T12:00:00.000Z';

function event(type: keyof typeof HotGameplayEventPayloadSchemas = 'prototype.item.acquired') {
  const payload =
    type === 'prototype.item.acquired'
      ? { itemId: uuid(5), ownerId: uuid(2) }
      : type === 'prototype.filter.depleted'
        ? { filterId: uuid(5) }
        : { capturedParticipantId: uuid(2) };
  return {
    schemaVersion: 1,
    eventId: uuid(10),
    matchId: uuid(1),
    worldEpoch: 1,
    simulationTick: 40,
    serverTimeMs: 2_000,
    eventSequence: 1,
    actor: { participantId: uuid(2) },
    source: { kind: 'hot-runtime', runtimeId: uuid(3) },
    correlation: { correlationId: uuid(4), causationId: null },
    type,
    payload,
  };
}

function coldState() {
  return {
    sessionId: uuid(1),
    worldState: { currentLocationId: uuid(6), timeOfDay: 'NIGHT', weather: null, ambientFlags: {} },
    storyFlags: {},
    objectStates: {},
    playerKnowledge: {},
    endingState: null,
    version: 0,
    updatedAt: at,
  };
}

function hotSnapshot() {
  return {
    id: uuid(20),
    sessionId: uuid(1),
    label: 'hot:v1',
    turnNumber: 40,
    createdByTurnId: null,
    createdBy: 'SYSTEM',
    state: coldState(),
    checksum: 'a'.repeat(64),
    createdAt: at,
    snapshotVersion: 1,
    recoveryPoint: {
      lastAppliedEventId: uuid(10),
      matchId: uuid(1),
      coldRevision: 2,
      worldEpoch: 1,
      simulationTick: 40,
    },
    runtime: {
      simulationTick: 40,
      players: [
        {
          participantId: uuid(2),
          position: { x: 1.5, y: 0.5 },
          direction: { directionX: 0, directionY: 0 },
          velocity: { x: 0, y: 0 },
          activeInputStreamId: null,
          lastProcessedInputSequence: null,
          lastInputTick: null,
        },
      ],
      prototypeFacts: {},
    },
  };
}

describe('P06 HOT/COLD contracts', () => {
  it.each(Object.keys(HotGameplayEventPayloadSchemas) as (keyof typeof HotGameplayEventPayloadSchemas)[])(
    'accepts strict durable event %s with typed payload and correlation context',
    (type) => {
      const parsed = HotGameplayEventEnvelopeSchema.parse(event(type));
      expect(parsed.type).toBe(type);
      expect(parsed.matchId).toBe(uuid(1));
      expect(parsed.eventSequence).toBe(1);
    },
  );

  it('rejects unknown payload, extra envelope fields and mixed event payload', () => {
    expect(HotGameplayEventEnvelopeSchema.safeParse({ ...event(), payload: { arbitrary: true } }).success).toBe(false);
    expect(HotGameplayEventEnvelopeSchema.safeParse({ ...event(), clientPosition: { x: 9, y: 9 } }).success).toBe(
      false,
    );
    expect(
      HotGameplayEventEnvelopeSchema.safeParse({
        ...event('prototype.filter.depleted'),
        payload: { itemId: uuid(5), ownerId: uuid(2) },
      }).success,
    ).toBe(false);
  });

  it('keeps ACK commit outcome and cold version explicit', () => {
    expect(
      HotGameplayEventAckSchema.parse({
        eventId: uuid(10),
        matchId: uuid(1),
        worldEpoch: 1,
        eventSequence: 1,
        simulationTick: 40,
        outcome: 'replayed',
        coldStateVersion: 3,
        committedAt: at,
      }).outcome,
    ).toBe('replayed');
  });

  it('requires positive command revision, world epoch and strict target/payload', () => {
    const command = {
      schemaVersion: 1,
      commandId: uuid(30),
      matchId: uuid(1),
      revision: 2,
      worldEpoch: 1,
      issuedAtEventId: uuid(10),
      type: 'prototype.runtime.fact',
      target: { participantId: uuid(2) },
      payload: { key: 'probe', value: true },
    };
    expect(ColdToHotCommandSchema.parse(command).revision).toBe(2);
    expect(ColdToHotCommandSchema.safeParse({ ...command, revision: 0 }).success).toBe(false);
    expect(
      ColdToHotCommandSchema.safeParse({ ...command, payload: { key: 'probe', value: true, speed: 9 } }).success,
    ).toBe(false);
  });

  it('validates HOT snapshot v1 recovery point and rejects inconsistent tick/version', () => {
    expect(HotSnapshotSchema.parse(hotSnapshot()).snapshotVersion).toBe(1);
    expect(HotSnapshotSchema.safeParse({ ...hotSnapshot(), turnNumber: 39 }).success).toBe(false);
    expect(HotSnapshotSchema.safeParse({ ...hotSnapshot(), snapshotVersion: 2 }).success).toBe(false);
    expect(
      HotSnapshotSchema.safeParse({
        ...hotSnapshot(),
        runtime: { simulationTick: 39, players: [], prototypeFacts: {} },
      }).success,
    ).toBe(false);
  });

  it('keeps legacy GameState SnapshotSchema readable without HOT metadata', () => {
    const snapshot = hotSnapshot() as Record<string, unknown>;
    delete snapshot['snapshotVersion'];
    delete snapshot['recoveryPoint'];
    delete snapshot['runtime'];
    const parsed = SnapshotSchema.parse(snapshot);
    expect(parsed.snapshotVersion).toBeUndefined();
    expect(parsed.state.sessionId).toBe(uuid(1));
  });
});
