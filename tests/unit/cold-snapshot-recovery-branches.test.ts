import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MatchId,
  type EventId,
  type SessionId,
  type Snapshot,
  type SnapshotId,
  type WorldEpoch,
} from '@mnemosin/contracts';
import { openColdTestDb, type ColdTestDb } from './cold-test-setup.js';
import { PROTOTYPE_RECOVERY_JOURNAL_SCAN_LIMIT, SnapshotRecoveryOrchestrator } from '@mnemosin/core';
import {
  createCommandProcessor,
  createEventProcessor,
  createRecovery,
  createRecoveryRuntime,
  insertRuntimeSnapshot,
  makeRecoveryCommand,
  makeRecoveryEvent,
} from './cold-recovery-fixtures.js';

describe('P06 SnapshotRecoveryOrchestrator — fail-closed границы', () => {
  let db: ColdTestDb;

  beforeEach(async () => {
    db = await openColdTestDb('cold-snapshot-branches');
  });

  afterEach(async () => {
    await db?.close();
  });

  it('legacy snapshot без HOT v1 metadata отклоняется', async () => {
    const state = await db.services.state.get(db.sessionId);
    const legacy: Snapshot = {
      id: '00000000-0000-4000-8000-000000000400' as SnapshotId,
      sessionId: db.sessionId,
      label: 'legacy-snapshot',
      turnNumber: 3,
      createdByTurnId: null,
      createdBy: 'SYSTEM',
      state,
      checksum: 'e'.repeat(64),
      createdAt: new Date().toISOString(),
    };
    await db.uow.runInTx(async (scope) => scope.repos.snapshots.insert(legacy));

    await expect(
      createRecovery(db, createRecoveryRuntime(db)).recover({
        matchId: MatchId.parse(db.sessionId),
        sessionId: db.sessionId,
      }),
    ).rejects.toThrow('Only HOT v1 snapshots supported');
  });

  it('явный targetSnapshot выбирается по id', async () => {
    const older = await insertRuntimeSnapshot(db, createRecoveryRuntime(db), 401);
    await insertRuntimeSnapshot(db, createRecoveryRuntime(db), 402);

    const result = await createRecovery(db, createRecoveryRuntime(db)).recover({
      matchId: MatchId.parse(db.sessionId),
      sessionId: db.sessionId,
      targetSnapshot: older.id,
    });

    expect(result.recoveredSnapshot.id).toBe(older.id);
    expect(result.recoveredRuntime.runtime.simulationTick).toBe(older.runtime.simulationTick);
    expect(result.appliedColdRevisions).toBe(0);
  });

  it('revision gap после snapshot отклоняется, а не считается применённым', async () => {
    const original = createRecoveryRuntime(db);
    const commands = createCommandProcessor(db);
    const first = makeRecoveryCommand(db, 1);
    await commands.process({ command: first, sessionId: db.sessionId });
    original.receiveColdCommand(first);
    original.tick();
    await insertRuntimeSnapshot(db, original, 403);

    // revision 2 отсутствует; revision 3 не может быть применена как будто цепочка полная.
    await commands.process({ command: makeRecoveryCommand(db, 3), sessionId: db.sessionId });

    await expect(
      createRecovery(db, createRecoveryRuntime(db)).recover({
        matchId: MatchId.parse(db.sessionId),
        sessionId: db.sessionId,
      }),
    ).rejects.toMatchObject({ code: 'CORE_INVALID_STATE_TRANSITION' });
  });

  it('отсутствующий event watermark не приводит к replay всего журнала', async () => {
    const missing = '00000000-0000-4000-8000-000000000410' as EventId;
    await insertRuntimeSnapshot(db, createRecoveryRuntime(db), 404, missing);

    await expect(
      createRecovery(db, createRecoveryRuntime(db)).recover({
        matchId: MatchId.parse(db.sessionId),
        sessionId: db.sessionId,
      }),
    ).rejects.toMatchObject({ code: 'CORE_INVALID_STATE_TRANSITION' });
  });

  it('snapshot другого matchId не восстанавливается в текущий runtime', async () => {
    await insertRuntimeSnapshot(db, createRecoveryRuntime(db), 405);
    const otherMatch = MatchId.parse('00000000-0000-4000-8000-000000000999');

    await expect(
      createRecovery(db, createRecoveryRuntime(db)).recover({ matchId: otherMatch, sessionId: db.sessionId }),
    ).rejects.toMatchObject({ code: 'CORE_INVALID_STATE_TRANSITION' });
  });

  it('B2: targetSnapshot чужой сессии отклоняется, а не применяется к целевой сессии', async () => {
    const snapshot = await insertRuntimeSnapshot(db, createRecoveryRuntime(db), 406);
    const otherSessionId = '00000000-0000-4000-8000-00000000beef' as SessionId;

    await expect(
      createRecovery(db, createRecoveryRuntime(db)).recover({
        matchId: MatchId.parse(db.sessionId),
        sessionId: otherSessionId,
        targetSnapshot: snapshot.id,
      }),
    ).rejects.toMatchObject({ code: 'CORE_INVALID_STATE_TRANSITION' });

    // В журнале целевой сессии не появилось записи о восстановлении.
    expect(await db.services.journal.listBySession(otherSessionId, 100)).toHaveLength(0);
  });

  it('B1: committed journal-запись чужого match даёт fail-closed, а не молчаливую фильтрацию', async () => {
    await insertRuntimeSnapshot(db, createRecoveryRuntime(db), 407);
    // Напрямую пишем durable-запись чужого match: processor теперь такое не допускает,
    // но recovery обязан защититься от уже записанного состояния.
    const foreignEvent = {
      ...makeRecoveryEvent(db, 408, 1, 41),
      matchId: MatchId.parse('00000000-0000-4000-8000-000000000998'),
    };
    await db.uow.runInTx(async (scope) =>
      scope.repos.journal.append({
        turnId: null,
        sessionId: db.sessionId,
        traceId: 'foreign-match',
        kind: 'hot_gameplay_committed',
        payload: { event: foreignEvent },
        createdAt: new Date().toISOString(),
      }),
    );

    await expect(
      createRecovery(db, createRecoveryRuntime(db), createEventProcessor(db)).recover({
        matchId: MatchId.parse(db.sessionId),
        sessionId: db.sessionId,
      }),
    ).rejects.toMatchObject({ code: 'CORE_INVALID_STATE_TRANSITION' });
  });

  it('B1: committed COLD-команда чужого worldEpoch даёт fail-closed', async () => {
    await insertRuntimeSnapshot(db, createRecoveryRuntime(db), 409);
    const commands = createCommandProcessor(db);
    await commands.process({ command: makeRecoveryCommand(db, 1), sessionId: db.sessionId });
    // Та же ревизия, но другой epoch: recovery не должен молча исключать её.
    const foreignEpoch = { ...makeRecoveryCommand(db, 2, 92), worldEpoch: 2 as WorldEpoch };
    await db.uow.runInTx(async (scope) =>
      scope.repos.journal.append({
        turnId: null,
        sessionId: db.sessionId,
        traceId: 'foreign-epoch',
        kind: 'cold_to_hot_committed',
        payload: { command: foreignEpoch },
        createdAt: new Date().toISOString(),
      }),
    );

    await expect(
      createRecovery(db, createRecoveryRuntime(db), createEventProcessor(db)).recover({
        matchId: MatchId.parse(db.sessionId),
        sessionId: db.sessionId,
      }),
    ).rejects.toMatchObject({ code: 'CORE_INVALID_STATE_TRANSITION' });
  });

  it('LOW: рассогласование match recovery point и процессора останавливает recovery до мутаций', async () => {
    await insertRuntimeSnapshot(db, createRecoveryRuntime(db), 411);
    // Процессор обслуживает другой match: recovery обязан остановиться ДО
    // restoreFromSnapshot/мутаций, а не полагаться на поздний guard processor'а.
    const foreignProcessor = createEventProcessor(db, MatchId.parse('00000000-0000-4000-8000-000000000996'));
    const recovery = new SnapshotRecoveryOrchestrator({
      snapshotRepo: db.uow.repos().snapshots,
      journal: db.services.journal,
      eventProcessor: foreignProcessor,
      runtime: createRecoveryRuntime(db),
    });

    await expect(
      recovery.recover({ matchId: MatchId.parse(db.sessionId), sessionId: db.sessionId }),
    ).rejects.toMatchObject({ code: 'CORE_INVALID_STATE_TRANSITION' });
    // В журнале нет записи reconciled_on_boot — recovery не завершился.
    expect(
      (await db.services.journal.listBySession(db.sessionId, 100)).filter(
        (entry) => entry.kind === 'reconciled_on_boot',
      ),
    ).toHaveLength(0);
  });

  it('переполнение журнального окна даёт fail-closed, а не применение неполной истории', async () => {
    await insertRuntimeSnapshot(db, createRecoveryRuntime(db), 410);
    // Журнал отдаёт больше записей, чем допускает окно: recovery обязан отказаться,
    // а не применить неполную цепочку ревизий (HC-07). Проверка срабатывает
    // ДО разбора payload, поэтому содержимое записей не важно.
    const overflowingEntries = Array.from({ length: PROTOTYPE_RECOVERY_JOURNAL_SCAN_LIMIT + 1 }, (_, index) => ({
      id: index + 1,
      turnId: null,
      sessionId: db.sessionId,
      traceId: 'overflow',
      kind: 'hot_gameplay_committed' as const,
      payload: {},
      createdAt: new Date().toISOString(),
    }));
    const limited = new SnapshotRecoveryOrchestrator({
      snapshotRepo: db.uow.repos().snapshots,
      journal: { listBySession: async () => overflowingEntries } as never,
      eventProcessor: createEventProcessor(db),
      runtime: createRecoveryRuntime(db),
    });

    await expect(
      limited.recover({ matchId: MatchId.parse(db.sessionId), sessionId: db.sessionId }),
    ).rejects.toMatchObject({ code: 'CORE_INVALID_STATE_TRANSITION' });
  });
});
