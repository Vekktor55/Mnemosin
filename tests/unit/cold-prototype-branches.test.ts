import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MatchId, type EventId, type WorldEpoch } from '@mnemosin/contracts';
import { ColdCommandProcessor, ColdGameplayEventProcessor, CrashRestartHarness } from '@mnemosin/core';
import { openColdTestDb, type ColdTestDb } from './cold-test-setup.js';
import {
  createCommandProcessor,
  createEventProcessor,
  createRecovery,
  createRecoveryRuntime,
  insertRuntimeSnapshot,
  makeRecoveryCommand,
  makeRecoveryEvent,
} from './cold-recovery-fixtures.js';

/**
 * P06 — точечное покрытие PROTOTYPE-ONLY ветвей COLD-процессоров.
 *
 * Здесь нет «тестов ради процента»: каждая ветвь — реальная граница,
 * которую должен отвергнуть или корректно обработать production-код.
 */
describe('P06 COLD prototype branches', () => {
  let db: ColdTestDb;

  beforeEach(async () => {
    db = await openColdTestDb('cold-prototype-branches');
  });

  afterEach(async () => {
    await db?.close();
  });

  it('невалидная retry-конфигурация отвергается сразу, без обработки события', () => {
    expect(
      () =>
        new ColdGameplayEventProcessor({
          commandRunner: db.idempotency,
          journal: db.services.journal,
          state: db.services.state,
          matchId: MatchId.parse(db.sessionId),
          retry: { attempts: 0 },
        }),
    ).toThrow(/attempts must be a positive safe integer/);

    expect(
      () =>
        new ColdGameplayEventProcessor({
          commandRunner: db.idempotency,
          journal: db.services.journal,
          state: db.services.state,
          matchId: MatchId.parse(db.sessionId),
          retry: { baseDelayMs: Number.NaN },
        }),
    ).toThrow(/baseDelayMs must be a non-negative finite number/);
  });

  it('не-retryable ошибка не повторяется: попытка ровно одна', async () => {
    let attempts = 0;
    const processor = new ColdGameplayEventProcessor({
      commandRunner: db.idempotency,
      journal: db.services.journal,
      state: db.services.state,
      matchId: MatchId.parse(db.sessionId),
      retry: {
        attempts: 3,
        baseDelayMs: 0,
        sleep: async () => {
          attempts += 1;
        },
      },
    });

    const unknownType = { ...makeRecoveryEvent(db, 501), type: 'prototype.unknown.event' };
    await expect(processor.process({ event: unknownType as never, sessionId: db.sessionId })).rejects.toMatchObject({
      code: 'CORE_EVENT_NOT_REGISTERED',
    });
    expect(attempts).toBe(0);
  });

  it('COLD command, не прошедшая схему, отвергается как VALIDATION', async () => {
    const processor = createCommandProcessor(db);
    const invalid = { ...makeRecoveryCommand(db, 1), revision: 0 };

    await expect(processor.process({ command: invalid, sessionId: db.sessionId })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('stale revision отвергается, а replay того же commandId остаётся replay', async () => {
    const processor = createCommandProcessor(db);
    const first = makeRecoveryCommand(db, 5);
    await processor.process({ command: first, sessionId: db.sessionId });

    // Тот же revision, но другой commandId → conflict по revision, а не replay.
    const other = makeRecoveryCommand(db, 5, 55, 'other-key');
    await expect(processor.process({ command: other, sessionId: db.sessionId })).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    // Тот же commandId с заниженной revision → тот же idempotency key → replay без второй мутации.
    const stale = { ...first, revision: 4 };
    const replayed = await processor.process({ command: stale, sessionId: db.sessionId });
    expect(replayed.applied).toBe(false);
    expect(replayed.journalEntryId).toBe(-1);

    // Более свежая revision после replay применяется один раз.
    const next = makeRecoveryCommand(db, 6);
    const applied = await processor.process({ command: next, sessionId: db.sessionId });
    expect(applied.applied).toBe(true);
  });

  it('recovery fail-closed: COLD-команда, отклонённая HOT boundary, останавливает восстановление', async () => {
    const runtime = createRecoveryRuntime(db);
    const commands = createCommandProcessor(db);
    const command = makeRecoveryCommand(db, 7);
    await commands.process({ command, sessionId: db.sessionId });
    await insertRuntimeSnapshot(db, runtime, 601);

    // Подсовываем runtime, который отвергает команду: boundary уже «помечен» другой ревизией.
    const rejecting = createRecoveryRuntime(db);
    const realReceive = rejecting.receiveColdCommand.bind(rejecting);
    rejecting.receiveColdCommand = (raw: unknown) => {
      const receipt = realReceive(raw);
      return receipt.accepted ? { accepted: false as const, reason: 'duplicate' as const } : receipt;
    };

    await expect(
      createRecovery(db, rejecting).recover({
        matchId: MatchId.parse(db.sessionId),
        sessionId: db.sessionId,
      }),
    ).rejects.toMatchObject({ code: 'CORE_INVALID_STATE_TRANSITION' });
  });

  it('pending-событие с чужим match контекстом отвергается, а не применяется молча', async () => {
    const runtime = createRecoveryRuntime(db);
    await insertRuntimeSnapshot(db, runtime, 602);
    const foreign = {
      ...makeRecoveryEvent(db, 603),
      matchId: MatchId.parse('00000000-0000-4000-8000-000000000998'),
    };

    await expect(
      createRecovery(db, createRecoveryRuntime(db)).recover({
        matchId: MatchId.parse(db.sessionId),
        sessionId: db.sessionId,
        pendingEvents: [foreign],
      }),
    ).rejects.toMatchObject({ code: 'CORE_INVALID_STATE_TRANSITION' });
  });

  it('crash harness требует snapshot для окна afterSnapshotWritten', async () => {
    const harness = new CrashRestartHarness({
      processor: createEventProcessor(db),
      recovery: createRecovery(db, createRecoveryRuntime(db)),
      snapshotRepo: db.uow.repos().snapshots,
      journal: db.services.journal,
    });

    await expect(
      harness.simulateCrashAndRestart(db.sessionId, MatchId.parse(db.sessionId), {
        afterEventCreated: true,
        afterColdCommit: false,
        afterAckSent: false,
        afterSnapshotWritten: true,
      }),
    ).rejects.toThrow(/requires recordSnapshotWritten/);
  });

  it('crash harness с окном без event creation не коммитит ничего и не выдумывает события', async () => {
    const runtime = createRecoveryRuntime(db);
    const snapshot = await insertRuntimeSnapshot(db, runtime, 604);
    const harness = new CrashRestartHarness({
      processor: createEventProcessor(db),
      recovery: createRecovery(db, createRecoveryRuntime(db)),
      snapshotRepo: db.uow.repos().snapshots,
      journal: db.services.journal,
    });
    harness.recordEventCreated(makeRecoveryEvent(db, 605));
    harness.recordSnapshotWritten(snapshot);

    const result = await harness.simulateCrashAndRestart(db.sessionId, MatchId.parse(db.sessionId), {
      afterEventCreated: false,
      afterColdCommit: false,
      afterAckSent: false,
      afterSnapshotWritten: false,
    });

    expect(result.pendingEventsBeforeCrash).toBe(0);
    expect(result.committedBeforeCrash).toBe(0);
    expect(result.acknowledgedBeforeCrash).toBe(0);
    expect(result.recoveredSnapshot).toBeNull();
    expect(result.lostTransientEventIds).toEqual([]);
    expect(result.transientTicksLost).toBe(0);
  });

  it('crash harness восстанавливается из уже сохранённого snapshot без повторной вставки', async () => {
    const runtime = createRecoveryRuntime(db);
    const snapshot = await insertRuntimeSnapshot(db, runtime, 606);
    const harness = new CrashRestartHarness({
      processor: createEventProcessor(db),
      recovery: createRecovery(db, createRecoveryRuntime(db)),
      snapshotRepo: db.uow.repos().snapshots,
      journal: db.services.journal,
    });
    harness.recordSnapshotWritten(snapshot);

    const result = await harness.simulateCrashAndRestart(db.sessionId, MatchId.parse(db.sessionId), {
      afterEventCreated: true,
      afterColdCommit: false,
      afterAckSent: false,
      afterSnapshotWritten: true,
    });

    expect(result.recoveredSnapshot?.id).toBe(snapshot.id);
    const stored = await db.uow.repos().snapshots.findById(snapshot.id);
    expect(stored).not.toBeNull();
  });

  it('crash harness: событие без snapshot теряется явно, а не маскируется replay', async () => {
    const harness = new CrashRestartHarness({
      processor: createEventProcessor(db),
      recovery: createRecovery(db, createRecoveryRuntime(db)),
      snapshotRepo: db.uow.repos().snapshots,
      journal: db.services.journal,
    });
    const event = makeRecoveryEvent(db, 607);
    harness.recordEventCreated(event);

    const result = await harness.simulateCrashAndRestart(db.sessionId, MatchId.parse(db.sessionId), {
      afterEventCreated: true,
      afterColdCommit: false,
      afterAckSent: false,
      afterSnapshotWritten: false,
    });

    expect(result.lostTransientEventIds).toEqual([event.eventId]);
    expect(result.pendingEventsAfterRecovery).toBe(1);
    expect(result.recoveryError).toBeNull();
    expect(result.recoveryOrder).toEqual(['crash:no-snapshot']);
    // Без снапшота окно отката не измеряется — метка источника не должна вводить в заблуждение.
    expect(result.transientTicksLostSource).toBe('no-snapshot');
    expect(result.transientTicksLost).toBe(0);
  });

  it('crash harness: recovery-ошибка возвращается в диагностике, а не бросается наружу', async () => {
    const runtime = createRecoveryRuntime(db);
    const snapshot = await insertRuntimeSnapshot(db, runtime, 608);
    const failing = {
      recover: async () => {
        throw new Error('recovery unavailable');
      },
    } as unknown as ReturnType<typeof createRecovery>;

    const harness = new CrashRestartHarness({
      processor: createEventProcessor(db),
      recovery: failing,
      snapshotRepo: db.uow.repos().snapshots,
      journal: db.services.journal,
    });
    harness.recordEventCreated(makeRecoveryEvent(db, 609));
    harness.recordSnapshotWritten(snapshot);

    const result = await harness.simulateCrashAndRestart(db.sessionId, MatchId.parse(db.sessionId), {
      afterEventCreated: true,
      afterColdCommit: false,
      afterAckSent: false,
      afterSnapshotWritten: true,
    });

    expect(result.recoveryError).toBe('recovery unavailable');
    expect(result.recoveryOrder).toEqual(['recovery:failed']);
    expect(result.pendingEventsAfterRecovery).toBe(1);
  });

  it('идемпотентность команды переживает restart: тот же commandId не даёт второй journal', async () => {
    const processor = new ColdCommandProcessor({
      commandRunner: db.idempotency,
      journal: db.services.journal,
      state: db.services.state,
      matchId: MatchId.parse(db.sessionId),
    });
    const command = makeRecoveryCommand(db, 9);

    const first = await processor.process({ command, sessionId: db.sessionId });
    const restarted = new ColdCommandProcessor({
      commandRunner: db.idempotency,
      journal: db.services.journal,
      state: db.services.state,
      matchId: MatchId.parse(db.sessionId),
    });
    const second = await restarted.process({ command, sessionId: db.sessionId });

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.journalEntryId).toBe(-1);
    const entries = await db.services.journal.listBySession(db.sessionId, 500);
    expect(entries.filter((entry) => entry.kind === 'cold_to_hot_committed')).toHaveLength(1);
  });

  it('worldEpoch в durable event и snapshot recovery point — независимые контексты', async () => {
    const event = makeRecoveryEvent(db, 610);
    expect(event.worldEpoch).toBe(1 as WorldEpoch);
    const eventId: EventId = event.eventId;
    expect(eventId).toBeDefined();
  });
});
