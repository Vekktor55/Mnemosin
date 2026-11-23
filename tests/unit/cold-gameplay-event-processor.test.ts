import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { id, ObjectId, ParticipantId, EventId } from '@mnemosin/contracts';
import type { WorldEpoch, SimulationTick, EventSequence, HotGameplayEventEnvelope } from '@mnemosin/contracts';
import { ColdGameplayEventProcessor } from '@mnemosin/core';
import { openColdTestDb, type ColdTestDb } from './cold-test-setup.js';

describe('P06 ColdGameplayEventProcessor', () => {
  let db: ColdTestDb;
  let processor: ColdGameplayEventProcessor;

  beforeEach(async () => {
    db = await openColdTestDb('cold-event');
    processor = new ColdGameplayEventProcessor({
      uow: db.uow,
      journal: db.services.journal,
      state: db.services.state,
    });
  });

  afterEach(async () => {
    await db?.close();
  });

  const TEST_ITEM_ID = id(ObjectId, '00000000-0000-4000-8000-000000000101');
  const TEST_FILTER_ID = id(ObjectId, '00000000-0000-4000-8000-000000000200');
  const TEST_CAPTURED_ID = id(ParticipantId, '00000000-0000-4000-8000-000000000002');
  const TEST_EVENT_ID = id(EventId, '00000000-0000-4000-8000-000000000100');
  const TEST_RUNTIME_ID = id(EventId, '00000000-0000-4000-8000-000000000002');
  const TEST_CORRELATION_ID = id(EventId, '00000000-0000-4000-8000-000000000003');

  function makeEvent(overrides: Record<string, unknown> = {}): HotGameplayEventEnvelope {
    return {
      schemaVersion: 1,
      eventId: TEST_EVENT_ID,
      matchId: db.sessionId,
      worldEpoch: 1 as WorldEpoch,
      simulationTick: 40 as SimulationTick,
      serverTimeMs: 2000,
      eventSequence: 1 as EventSequence,
      actor: { participantId: db.playerId },
      source: { kind: 'hot-runtime', runtimeId: TEST_RUNTIME_ID },
      correlation: { correlationId: TEST_CORRELATION_ID, causationId: null },
      type: 'prototype.item.acquired',
      payload: { itemId: TEST_ITEM_ID, ownerId: db.playerId },
      ...overrides,
    };
  }

  it('processes new event and returns committed ack', async () => {
    const event = makeEvent();

    const result = await processor.process({ event, sessionId: db.sessionId });

    expect(result.ack.outcome).toBe('committed');
    expect(result.ack.eventId).toBe(event.eventId);
    expect(result.ack.coldStateVersion).toBeGreaterThan(0);
    expect(result.journalEntryId).toBeGreaterThan(0);

    const state = await db.services.state.get(db.sessionId);
    const flag = state.storyFlags['prototype.item.00000000-0000-4000-8000-000000000101.owner'];
    expect(flag?.value).toBe(db.playerId);
    expect(flag?.setBy).toBe('ENGINE');
  });

  it('replays event with replayed outcome on duplicate', async () => {
    const event = makeEvent();

    await processor.process({ event, sessionId: db.sessionId });
    const replayed = await processor.process({ event, sessionId: db.sessionId });

    expect(replayed.ack.outcome).toBe('replayed');
    expect(replayed.ack.coldStateVersion).toBeGreaterThan(0);
    expect(replayed.journalEntryId).toBe(-1);
  });

  it('processes prototype.filter.depleted event', async () => {
    const event = makeEvent({
      type: 'prototype.filter.depleted',
      payload: { filterId: TEST_FILTER_ID },
    });

    const result = await processor.process({ event, sessionId: db.sessionId });

    expect(result.ack.outcome).toBe('committed');

    const state = await db.services.state.get(db.sessionId);
    const flag = state.storyFlags[`prototype.filter.${TEST_FILTER_ID}.depleted`];
    expect(flag?.value).toBe(true);
  });

  it('processes prototype.capture.recorded event', async () => {
    const event = makeEvent({
      type: 'prototype.capture.recorded',
      payload: { capturedParticipantId: TEST_CAPTURED_ID },
    });

    const result = await processor.process({ event, sessionId: db.sessionId });

    expect(result.ack.outcome).toBe('committed');

    const state = await db.services.state.get(db.sessionId);
    const flag = state.storyFlags[`prototype.capture.${TEST_CAPTURED_ID}`];
    expect(flag?.value).toBe(true);
  });

  it('replays event correctly on duplicate', async () => {
    const event = makeEvent();

    // First call succeeds
    const result = await processor.process({ event, sessionId: db.sessionId });
    expect(result.ack.outcome).toBe('committed');

    // Second call with same event is replayed
    const replayed = await processor.process({ event, sessionId: db.sessionId });
    expect(replayed.ack.outcome).toBe('replayed');
  });
});
