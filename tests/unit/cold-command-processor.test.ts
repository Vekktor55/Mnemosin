import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import type { CommandId } from '@mnemosin/contracts';
import { ColdCommandProcessor } from '@mnemosin/core';
import { openColdTestDb, type ColdTestDb } from './cold-test-setup.js';

describe('P06 ColdCommandProcessor', () => {
  let db: ColdTestDb;
  let processor: ColdCommandProcessor;

  beforeEach(async () => {
    db = await openColdTestDb('cold-cmd');
    processor = new ColdCommandProcessor({
      uow: db.uow,
      state: db.services.state,
    });
  });

  afterEach(async () => {
    await db?.close();
  });

  it('applies command first time and records revision', async () => {
    const result = await processor.process({
      command: {
        schemaVersion: 1,
        commandId: '00000000-0000-4000-8000-000000000010' as CommandId,
        matchId: db.sessionId,
        revision: 1,
        worldEpoch: 1,
        type: 'prototype.runtime.fact',
        target: { participantId: db.playerId },
        payload: { key: 'probe', value: true },
      },
      sessionId: db.sessionId,
    });

    expect(result.applied).toBe(true);
    expect(result.revision).toBe(1);

    const state = await db.services.state.get(db.sessionId);
    const flag = state.storyFlags['prototype.runtime.probe'];
    expect(flag?.value).toBe(true);
    expect(flag?.setBy).toBe('ENGINE');
  });

  it('rejects duplicate commandId (idempotent)', async () => {
    await processor.process({
      command: {
        schemaVersion: 1,
        commandId: '00000000-0000-4000-8000-000000000011' as CommandId,
        matchId: db.sessionId,
        revision: 1,
        worldEpoch: 1,
        type: 'prototype.runtime.fact',
        target: { participantId: db.playerId },
        payload: { key: 'probe2', value: 42 },
      },
      sessionId: db.sessionId,
    });

    const second = await processor.process({
      command: {
        schemaVersion: 1,
        commandId: '00000000-0000-4000-8000-000000000011' as CommandId,
        matchId: db.sessionId,
        revision: 2,
        worldEpoch: 1,
        type: 'prototype.runtime.fact',
        target: { participantId: db.playerId },
        payload: { key: 'probe2', value: 99 },
      },
      sessionId: db.sessionId,
    });

    expect(second.applied).toBe(false);
    expect(second.revision).toBe(1);
  });

  it('increments revision on each successful apply', async () => {
    for (let i = 1; i <= 3; i++) {
      const result = await processor.process({
        command: {
          schemaVersion: 1,
          commandId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` as CommandId,
          matchId: db.sessionId,
          revision: i,
          worldEpoch: 1,
          type: 'prototype.runtime.fact',
          target: { participantId: db.playerId },
          payload: { key: `key${i}`, value: i },
        },
        sessionId: db.sessionId,
      });
      expect(result.applied).toBe(true);
      expect(result.revision).toBe(i);
    }
  });

  it('getAppliedRevision returns null for unknown commandId', () => {
    expect(processor.getAppliedRevision('00000000-0000-4000-8000-000000000999' as CommandId)).toBeNull();
  });

  it('applies SET_FLAG mutation with correct setBy=ENGINE', async () => {
    await processor.process({
      command: {
        schemaVersion: 1,
        commandId: '00000000-0000-4000-8000-000000000020' as CommandId,
        matchId: db.sessionId,
        revision: 1,
        worldEpoch: 1,
        type: 'prototype.runtime.fact',
        target: { participantId: db.playerId },
        payload: { key: 'runtime.flag', value: 'test-value' },
      },
      sessionId: db.sessionId,
    });

    const state = await db.services.state.get(db.sessionId);
    const flag = state.storyFlags['prototype.runtime.runtime.flag'];
    expect(flag).toBeDefined();
    expect(flag?.value).toBe('test-value');
    expect(flag?.setBy).toBe('ENGINE');
  });
});
