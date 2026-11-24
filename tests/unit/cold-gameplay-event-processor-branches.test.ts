import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { id, ObjectId, ParticipantId, EventId } from '@mnemosin/contracts';
import type {
  WorldEpoch,
  SimulationTick,
  EventSequence,
  HotGameplayEventEnvelope,
  JournalKind,
} from '@mnemosin/contracts';
import { ColdGameplayEventProcessor } from '@mnemosin/core';
import { openColdTestDb, type ColdTestDb } from './cold-test-setup.js';

/**
 * P06: дополнительные ветви ColdGameplayEventProcessor.
 *
 * Цель — доказать commit/ACK семантику на границах:
 *  - ошибка внутри транзакции повторяется с backoff и не подтверждается ACK;
 *  - после исчерпания попыток выбрасывается CoreError с eventId в details;
 *  - неизвестный тип события не создаёт мутаций (default-ветка switch);
 *  - отсутствие state-строки обрабатывается как currentState === undefined.
 */
describe('P06 ColdGameplayEventProcessor — ветви ошибок и границ', () => {
  let db: ColdTestDb;

  const TEST_ITEM_ID = id(ObjectId, '00000000-0000-4000-8000-000000000101');
  const TEST_CAPTURED_ID = id(ParticipantId, '00000000-0000-4000-8000-000000000002');
  const TEST_EVENT_ID = id(EventId, '00000000-0000-4000-8000-000000000100');
  const TEST_RUNTIME_ID = id(EventId, '00000000-0000-4000-8000-000000000002');
  const TEST_CORRELATION_ID = id(EventId, '00000000-0000-4000-8000-000000000003');

  beforeEach(async () => {
    db = await openColdTestDb('cold-event-branches');
  });

  afterEach(async () => {
    await db?.close();
  });

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
    } as HotGameplayEventEnvelope;
  }

  it('повторяет транзакцию при временной ошибке и подтверждает только после успеха', async () => {
    let attempts = 0;
    const processor = new ColdGameplayEventProcessor({
      uow: db.uow,
      journal: {
        append: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('transient journal failure');
          return { id: 1 } as never;
        },
      } as never,
      state: db.services.state,
    });

    const result = await processor.process({ event: makeEvent(), sessionId: db.sessionId });

    expect(attempts).toBe(2);
    expect(result.ack.outcome).toBe('committed');
  });

  it('после исчерпания попыток выбрасывает CoreError без ACK', async () => {
    let attempts = 0;
    const processor = new ColdGameplayEventProcessor({
      uow: db.uow,
      journal: {
        append: async () => {
          attempts += 1;
          throw new Error('permanent journal failure');
        },
      } as never,
      state: db.services.state,
    });

    await expect(processor.process({ event: makeEvent(), sessionId: db.sessionId })).rejects.toMatchObject({
      code: 'CORE_EVENT_NOT_REGISTERED',
    });
    expect(attempts).toBe(3);
  });

  it('неизвестный тип события не создаёт мутаций и отклоняется без ACK (default switch)', async () => {
    const processor = new ColdGameplayEventProcessor({
      uow: db.uow,
      journal: db.services.journal,
      state: db.services.state,
    });

    // Неизвестный тип не проходит HotGameplayJournalPayloadSchema: default-ветка
    // switch даёт пустой набор мутаций, а journal-валидация отклоняет событие.
    await expect(
      processor.process({
        event: makeEvent({ type: 'prototype.unknown.kind', payload: { whatever: true } }),
        sessionId: db.sessionId,
      }),
    ).rejects.toMatchObject({ code: 'CORE_EVENT_NOT_REGISTERED' });

    const state = await db.services.state.get(db.sessionId);
    expect(Object.keys(state.storyFlags)).toHaveLength(0);
    expect(state.version).toBe(0);
  });

  it('не-Error исключение сохраняется в cause диагностики', async () => {
    const processor = new ColdGameplayEventProcessor({
      uow: db.uow,
      journal: {
        append: async () => {
          throw 'non-error failure';
        },
      } as never,
      state: db.services.state,
    });

    await expect(processor.process({ event: makeEvent(), sessionId: db.sessionId })).rejects.toMatchObject({
      code: 'CORE_EVENT_NOT_REGISTERED',
      meta: { cause: 'non-error failure' },
    });
  });

  it('состояние сессии отсутствует — currentState трактуется как undefined и транзакция откатывается', async () => {
    const processor = new ColdGameplayEventProcessor({
      uow: db.uow,
      journal: db.services.journal,
      state: db.services.state,
    });

    const missingSessionId = '00000000-0000-4000-8000-00000000dead' as never;

    await expect(processor.process({ event: makeEvent(), sessionId: missingSessionId })).rejects.toMatchObject({
      code: 'CORE_EVENT_NOT_REGISTERED',
    });
  });

  it('журнал durable события остаётся append-only и не дублируется при повторе', async () => {
    const processor = new ColdGameplayEventProcessor({
      uow: db.uow,
      journal: db.services.journal,
      state: db.services.state,
    });

    const event = makeEvent();
    await processor.process({ event, sessionId: db.sessionId });
    await processor.process({ event, sessionId: db.sessionId });

    const entries = await db.services.journal.listBySession(db.sessionId, 500);
    const durable = entries.filter((entry) => entry.kind === ('hot_gameplay_committed' satisfies JournalKind));
    expect(durable).toHaveLength(1);
  });

  it('capture-событие фиксирует флаг в state и журнале', async () => {
    const processor = new ColdGameplayEventProcessor({
      uow: db.uow,
      journal: db.services.journal,
      state: db.services.state,
    });

    const event = makeEvent({
      eventId: id(EventId, '00000000-0000-4000-8000-000000000300'),
      type: 'prototype.capture.recorded',
      payload: { capturedParticipantId: TEST_CAPTURED_ID },
    });

    await processor.process({ event, sessionId: db.sessionId });

    const state = await db.services.state.get(db.sessionId);
    expect(state.storyFlags[`prototype.capture.${TEST_CAPTURED_ID}`]?.value).toBe(true);
  });
});
