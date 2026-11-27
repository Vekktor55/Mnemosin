import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IdempotencyKey, MatchId, type ColdToHotCommand, type CommandId, type Scalar } from '@mnemosin/contracts';
import {
  ColdCommandProcessor,
  PROTOTYPE_COLD_COMMAND_JOURNAL_SCAN_LIMIT,
  coldCommandIdempotencyKey,
} from '@mnemosin/core';
import { openColdTestDb, type ColdTestDb } from './cold-test-setup.js';

describe('P06 ColdCommandProcessor — durable command journal and idempotency', () => {
  let db: ColdTestDb;
  let processor: ColdCommandProcessor;

  beforeEach(async () => {
    db = await openColdTestDb('cold-cmd');
    processor = createProcessor();
  });

  afterEach(async () => {
    await db?.close();
  });

  function createProcessor(): ColdCommandProcessor {
    return new ColdCommandProcessor({
      commandRunner: db.idempotency,
      journal: db.services.journal,
      state: db.services.state,
      matchId: MatchId.parse(db.sessionId),
    });
  }

  function makeCommand(revision: number, suffix = 10, key = 'probe', value: Scalar = true): ColdToHotCommand {
    return {
      schemaVersion: 1,
      commandId: `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}` as CommandId,
      matchId: db.sessionId,
      revision,
      worldEpoch: 1,
      type: 'prototype.runtime.fact',
      target: { participantId: db.playerId },
      payload: { key, value },
    };
  }

  it('применяет команду и сохраняет саму revisioned command в durable journal', async () => {
    const command = makeCommand(1);
    const result = await processor.process({ command, sessionId: db.sessionId });

    expect(result).toMatchObject({ applied: true, revision: 1 });
    expect((await db.services.state.get(db.sessionId)).storyFlags['prototype.runtime.probe']?.value).toBe(true);
    const entries = await db.services.journal.listBySession(db.sessionId, 100);
    const committed = entries.filter((entry) => entry.kind === 'cold_to_hot_committed');
    expect(committed).toHaveLength(1);
    expect(committed[0]?.payload).toEqual({ command });
  });

  it('не применяет повторный commandId и возвращает исходную revision', async () => {
    const command = makeCommand(1, 11, 'probe2', 42);
    await processor.process({ command, sessionId: db.sessionId });
    const duplicate = await processor.process({
      command: { ...command, revision: 2, payload: { key: 'probe2', value: 99 } },
      sessionId: db.sessionId,
    });

    expect(duplicate).toMatchObject({ applied: false, revision: 1, journalEntryId: -1 });
    expect((await db.services.state.get(db.sessionId)).version).toBe(1);
  });

  it('сохраняет idempotency после restart processor: один journal и один state increment', async () => {
    const command = makeCommand(1, 12, 'after-restart', 'once');
    await processor.process({ command, sessionId: db.sessionId });
    const before = await db.services.state.get(db.sessionId);

    const restarted = createProcessor();
    const replayed = await restarted.process({ command, sessionId: db.sessionId });

    expect(replayed.applied).toBe(false);
    expect((await db.services.state.get(db.sessionId)).version).toBe(before.version);
    const entries = await db.services.journal.listBySession(db.sessionId, 100);
    expect(entries.filter((entry) => entry.kind === 'cold_to_hot_committed')).toHaveLength(1);
  });

  it('применяет монотонные revisions и записывает setBy=ENGINE', async () => {
    for (let revision = 1; revision <= 3; revision += 1) {
      const result = await processor.process({
        command: makeCommand(revision, revision, `key${revision}`, revision),
        sessionId: db.sessionId,
      });
      expect(result).toMatchObject({ applied: true, revision });
    }
    const state = await db.services.state.get(db.sessionId);
    expect(state.version).toBe(3);
    expect(state.storyFlags['prototype.runtime.key3']).toMatchObject({ value: 3, setBy: 'ENGINE' });
  });

  it('отклоняет конфликт revision другим commandId без второй mutation', async () => {
    await processor.process({ command: makeCommand(1, 20), sessionId: db.sessionId });
    await expect(
      processor.process({ command: makeCommand(1, 21, 'conflict', true), sessionId: db.sessionId }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await db.services.state.get(db.sessionId)).version).toBe(1);
  });

  it('переполнение журнального окна даёт CONFLICT, а не решение по неполной истории', async () => {
    const overflowingEntries = Array.from({ length: PROTOTYPE_COLD_COMMAND_JOURNAL_SCAN_LIMIT + 1 }, (_, index) => ({
      id: index + 1,
      turnId: null,
      sessionId: db.sessionId,
      traceId: 'overflow',
      kind: 'cold_to_hot_committed' as const,
      payload: {},
      createdAt: new Date().toISOString(),
    }));
    const limited = new ColdCommandProcessor({
      commandRunner: db.idempotency,
      journal: {
        append: db.services.journal.append.bind(db.services.journal),
        listBySession: async () => overflowingEntries,
      } as never,
      state: db.services.state,
      matchId: MatchId.parse(db.sessionId),
    });

    await expect(limited.process({ command: makeCommand(1, 40), sessionId: db.sessionId })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('ошибка state откатывает transaction и не оставляет idempotency/journal записей', async () => {
    const missingSessionId = '00000000-0000-4000-8000-00000000dead' as never;
    const command: ColdToHotCommand = { ...makeCommand(1, 30, 'missing-state', true), matchId: missingSessionId };
    // Процессор привязан к тому же match, что и команда: проверяется именно
    // откат транзакции из-за отсутствующей state-строки, а не отказ по match.
    const boundProcessor = new ColdCommandProcessor({
      commandRunner: db.idempotency,
      journal: db.services.journal,
      state: db.services.state,
      matchId: missingSessionId,
    });

    await expect(boundProcessor.process({ command, sessionId: missingSessionId })).rejects.toMatchObject({
      code: 'CORE_NOT_FOUND',
    });
    const record = await db.uow.repos().idempotency.findByKey(IdempotencyKey.parse(coldCommandIdempotencyKey(command)));
    expect(record).toBeNull();
    expect(await db.services.journal.listBySession(missingSessionId, 100)).toHaveLength(0);
  });

  it('B1 root: команда чужого match отклоняется до commit — журнал и state не меняются', async () => {
    const foreign = {
      ...makeCommand(1, 40, 'foreign-match', true),
      matchId: MatchId.parse('00000000-0000-4000-8000-000000000998'),
    };

    await expect(processor.process({ command: foreign, sessionId: db.sessionId })).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    expect((await db.services.state.get(db.sessionId)).version).toBe(0);
    expect(await db.services.journal.listBySession(db.sessionId, 100)).toHaveLength(0);
  });
});
