import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import type { CoreServices } from '@mnemosin/core';
import type { ObjectId, PlayerId, SessionId, TurnId } from '@mnemosin/contracts';

import {
  buildTestServices,
  errorCodeOf,
  makeTurn,
  outboxEvents,
  openTempDb,
  seedWorld,
  type TempDb,
} from './helpers.js';

/**
 * StateService (промпт 1.6; инварианты 7–8, 13 — единственный путь мутации
 * GameState; optimistic lock A1.5 на уровне сервиса).
 *
 * Проверяются: все виды StateMutation как функции, version+1, changedKeys,
 * journal 'state_applied', state_history, событие STATE_COMMITTED, конфликт
 * версий, атомарность (откат всей серии при ошибке в одной мутации).
 */

let db: TempDb;
let services: CoreServices;
let sessionId: SessionId;
let turnId: TurnId;
let objectId: ObjectId;
let playerId: PlayerId;

beforeAll(async () => {
  db = await openTempDb('state-service', { seed: false });
  services = buildTestServices(db);
  // Мир из хелперов 1.4: сессия ACTIVE, состояние version 0, объекты фикстур.
  const world = await seedWorld(db);
  sessionId = world.session.sessionId;
  playerId = world.players[1]!.playerId;
  objectId = Object.keys(world.state.objectStates)[0] as ObjectId;
  await db.boot.uow.runInTx(async (scope) => {
    const turn = makeTurn(sessionId, 1);
    turnId = turn.turnId;
    await scope.repos.turns.insert(turn);
  });
});

afterAll(async () => {
  await db?.close();
});

describe('apply: мутации как функции (этап 1, без DSL)', () => {
  it('SET_FLAG: флаг с setAtTurnId/setBy, version+1, changedKeys, событие, журнал, история', async () => {
    const result = await services.state.apply({
      sessionId,
      mutations: [{ kind: 'SET_FLAG', key: 'floor-1_lobby.clock_stopped', value: true, setBy: 'ENGINE' }],
      expectedVersion: 0,
      turnId,
      traceId: 'trace-flag',
    });
    expect(result.version).toBe(1);
    expect(result.changedKeys).toEqual(['storyFlags.floor-1_lobby.clock_stopped']);
    const flag = result.state.storyFlags['floor-1_lobby.clock_stopped']!;
    expect(flag.value).toBe(true);
    expect(flag.setAtTurnId).toBe(turnId);
    expect(flag.setBy).toBe('ENGINE');
    expect(flag.flagId).toMatch(/^[0-9a-f-]{36}$/);

    // Персистентно:
    const reread = await services.state.get(sessionId);
    expect(reread.version).toBe(1);
    expect(reread.storyFlags['floor-1_lobby.clock_stopped']?.value).toBe(true);

    // Событие STATE_COMMITTED — в outbox той же транзакцией:
    const committed = (await outboxEvents(db)).filter((e) => e.eventName === 'STATE_COMMITTED');
    expect(committed.length).toBe(1);
    expect(committed[0]!.payload).toMatchObject({ sessionId, version: 1 });
    expect(committed[0]!.payload['changedKeys']).toEqual(['storyFlags.floor-1_lobby.clock_stopped']);

    // Журнал хода:
    const journal = await services.journal.list(turnId);
    const applied = journal.filter((e) => e.kind === 'state_applied');
    expect(applied.length).toBe(1);
    expect(applied[0]!.traceId).toBe('trace-flag');
    expect(applied[0]!.payload).toMatchObject({ fromVersion: 0, toVersion: 1, mutations: 1 });

    // История мутаций:
    const history = await db.boot.uow.repos().state.listHistory(sessionId);
    expect(history.length).toBe(1);
    expect(history[0]!).toMatchObject({ fromVersion: 0, toVersion: 1, turnId });
  });

  it('OBJECT_PATCH / OBJECT_TAKEN / OBJECT_VISIBLE: состояние объекта и lastChangedAtTurnId', async () => {
    const result = await services.state.apply({
      sessionId,
      mutations: [
        { kind: 'OBJECT_PATCH', objectId, patch: { condition: 'broken', dust: 3 } },
        { kind: 'OBJECT_TAKEN', objectId, taken: true },
        { kind: 'OBJECT_VISIBLE', objectId, visible: false },
      ],
      expectedVersion: 1,
      turnId,
      traceId: 'trace-object',
    });
    expect(result.version).toBe(2);
    const objectState = result.state.objectStates[objectId]!;
    expect(objectState.state).toEqual({ condition: 'broken', dust: 3 });
    expect(objectState.taken).toBe(true);
    expect(objectState.visible).toBe(false);
    expect(objectState.lastChangedAtTurnId).toBe(turnId);
    expect(result.changedKeys).toEqual([
      `objectStates.${objectId}.state.condition`,
      `objectStates.${objectId}.state.dust`,
      `objectStates.${objectId}.taken`,
      `objectStates.${objectId}.visible`,
    ]);
  });

  it('WORLD_PATCH: timeOfDay, weather, ambientFlags (слияние), currentLocationId', async () => {
    const before = await services.state.get(sessionId);
    const result = await services.state.apply({
      sessionId,
      mutations: [
        { kind: 'WORLD_PATCH', timeOfDay: 'NIGHT', weather: 'дождь по крыше' },
        { kind: 'WORLD_PATCH', ambientFlags: { hum: 2 } },
        { kind: 'WORLD_PATCH', ambientFlags: { lights: 'off' } },
      ],
      expectedVersion: before.version,
      turnId,
      traceId: 'trace-world',
    });
    expect(result.state.worldState.timeOfDay).toBe('NIGHT');
    expect(result.state.worldState.weather).toBe('дождь по крыше');
    expect(result.state.worldState.ambientFlags).toEqual({ hum: 2, lights: 'off' });
    expect(result.changedKeys).toContain('worldState.timeOfDay');
    expect(result.changedKeys).toContain('worldState.ambientFlags.hum');
    expect(result.changedKeys).toContain('worldState.ambientFlags.lights');
  });

  it('GRANT_KNOWLEDGE: новая запись и обновление существующей по key', async () => {
    let state = await services.state.get(sessionId);
    const first = await services.state.apply({
      sessionId,
      mutations: [
        { kind: 'GRANT_KNOWLEDGE', playerId: playerId, key: 'journal.last_entry', value: '17.03', source: 'OBSERVED' },
      ],
      expectedVersion: state.version,
      turnId,
      traceId: 'trace-knowledge',
    });
    let entries = first.state.playerKnowledge[playerId]!.entries;
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({
      key: 'journal.last_entry',
      value: '17.03',
      source: 'OBSERVED',
      learnedAtTurnId: turnId,
    });

    state = await services.state.get(sessionId);
    const second = await services.state.apply({
      sessionId,
      mutations: [
        { kind: 'GRANT_KNOWLEDGE', playerId: playerId, key: 'journal.last_entry', value: '18.03', source: 'TOLD' },
      ],
      expectedVersion: state.version,
      turnId,
      traceId: 'trace-knowledge-2',
    });
    entries = second.state.playerKnowledge[playerId]!.entries;
    expect(entries.length).toBe(1); // обновление, не дубль
    expect(entries[0]).toMatchObject({ value: '18.03', source: 'TOLD' });
  });

  it('REACH_ENDING: endingState с reachedAtTurnId; без turnId → VALIDATION', async () => {
    const state = await services.state.get(sessionId);
    const noTurn = await errorCodeOf(() =>
      services.state.apply({
        sessionId,
        mutations: [{ kind: 'REACH_ENDING', endingId: 'escape', summary: 'Побег', survivors: [] }],
        expectedVersion: state.version,
        traceId: 'trace-ending',
      }),
    );
    expect(noTurn).toBe('VALIDATION');

    const result = await services.state.apply({
      sessionId,
      mutations: [
        {
          kind: 'REACH_ENDING',
          endingId: 'escape',
          summary: 'Группа вышла через шлюз',
          survivors: [playerId],
        },
      ],
      expectedVersion: state.version,
      turnId,
      traceId: 'trace-ending',
    });
    expect(result.state.endingState).toMatchObject({ endingId: 'escape', reachedAtTurnId: turnId });
    expect(result.changedKeys).toContain('endingState');
  });

  it('apply без turnId: журнал не пишется (journal turn-scoped), история и событие — пишутся', async () => {
    const state = await services.state.get(sessionId);
    const before = await services.journal.lastId(sessionId);
    const result = await services.state.apply({
      sessionId,
      mutations: [{ kind: 'SET_FLAG', key: 'system.probe', value: 1, setBy: 'GM' }],
      expectedVersion: state.version,
      turnId: null,
      traceId: 'trace-no-turn',
    });
    expect(result.version).toBe(state.version + 1);
    const after = await services.journal.lastId(sessionId);
    expect(after).toBe(before); // ни одной новой записи журнала
    const history = await db.boot.uow.repos().state.listHistory(sessionId);
    expect(history[0]!.turnId).toBeNull();
  });
});

describe('apply: блокировки и ошибки', () => {
  it('устаревший expectedVersion → CORE_VERSION_CONFLICT с фактической версией', async () => {
    const state = await services.state.get(sessionId);
    let caught: { code?: string; meta?: Record<string, unknown> } | null = null;
    try {
      await services.state.apply({
        sessionId,
        mutations: [{ kind: 'SET_FLAG', key: 'late.flag', value: true, setBy: 'GM' }],
        expectedVersion: state.version - 1,
        traceId: 'trace-conflict',
      });
    } catch (cause) {
      caught = cause as { code?: string; meta?: Record<string, unknown> };
    }
    expect(caught?.code).toBe('CORE_VERSION_CONFLICT');
    expect(caught?.meta).toMatchObject({ actualVersion: state.version });
  });

  it('неизвестный объект → CORE_NOT_FOUND; неизвестная сессия → CORE_NOT_FOUND', async () => {
    const state = await services.state.get(sessionId);
    const noObject = await errorCodeOf(() =>
      services.state.apply({
        sessionId,
        mutations: [{ kind: 'OBJECT_PATCH', objectId: randomUUID() as ObjectId, patch: { x: 1 } }],
        expectedVersion: state.version,
        traceId: 'trace-bad-object',
      }),
    );
    expect(noObject).toBe('CORE_NOT_FOUND');
    const noSession = await errorCodeOf(() =>
      services.state.apply({
        sessionId: randomUUID() as SessionId,
        mutations: [{ kind: 'SET_FLAG', key: 'x', value: 1, setBy: 'GM' }],
        expectedVersion: 0,
        traceId: 'trace-bad-session',
      }),
    );
    expect(noSession).toBe('CORE_NOT_FOUND');
  });

  it('мутация вне схемы → VALIDATION', async () => {
    const state = await services.state.get(sessionId);
    const code = await errorCodeOf(() =>
      services.state.apply({
        sessionId,
        mutations: [{ kind: 'TELEPORT_ME', where: 'nowhere' } as never],
        expectedVersion: state.version,
        traceId: 'trace-bad-mutation',
      }),
    );
    expect(code).toBe('VALIDATION');
  });

  it('атомарность: ошибка во второй мутации откатывает ВСЮ серию (version не меняется)', async () => {
    const state = await services.state.get(sessionId);
    const code = await errorCodeOf(() =>
      services.state.apply({
        sessionId,
        mutations: [
          { kind: 'SET_FLAG', key: 'atomic.first', value: true, setBy: 'GM' },
          { kind: 'OBJECT_PATCH', objectId: randomUUID() as ObjectId, patch: { boom: 1 } },
        ],
        expectedVersion: state.version,
        turnId,
        traceId: 'trace-atomic',
      }),
    );
    expect(code).toBe('CORE_NOT_FOUND');
    const after = await services.state.get(sessionId);
    expect(after.version).toBe(state.version);
    expect(after.storyFlags['atomic.first']).toBeUndefined();
  });

  it('последовательные apply двумя вызывающими: второй со устаревшей версией проигрывает (A1.5 на сервисе)', async () => {
    const snapshot = await services.state.get(sessionId);
    const first = await services.state.apply({
      sessionId,
      mutations: [{ kind: 'SET_FLAG', key: 'race.first', value: 1, setBy: 'GM' }],
      expectedVersion: snapshot.version,
      traceId: 'trace-race-1',
    });
    expect(first.version).toBe(snapshot.version + 1);
    const code = await errorCodeOf(() =>
      services.state.apply({
        sessionId,
        mutations: [{ kind: 'SET_FLAG', key: 'race.second', value: 2, setBy: 'GM' }],
        expectedVersion: snapshot.version, // устарела
        traceId: 'trace-race-2',
      }),
    );
    expect(code).toBe('CORE_VERSION_CONFLICT');
    // Retry с актуальной версией проходит:
    const retry = await services.state.apply({
      sessionId,
      mutations: [{ kind: 'SET_FLAG', key: 'race.second', value: 2, setBy: 'GM' }],
      expectedVersion: first.version,
      traceId: 'trace-race-3',
    });
    expect(retry.version).toBe(first.version + 1);
    expect(retry.state.storyFlags['race.first']?.value).toBe(1);
    expect(retry.state.storyFlags['race.second']?.value).toBe(2);
  });
});

describe('get', () => {
  it('возвращает состояние; неизвестная сессия → CORE_NOT_FOUND', async () => {
    const state = await services.state.get(sessionId);
    expect(state.sessionId).toBe(sessionId);
    const code = await errorCodeOf(() => services.state.get(randomUUID() as SessionId));
    expect(code).toBe('CORE_NOT_FOUND');
  });
});
