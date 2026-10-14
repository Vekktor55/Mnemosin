import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import type { CoreServices } from '@mnemosin/core';
import type { CharacterId, PlayerId, SessionId } from '@mnemosin/contracts';

import {
  buildTestServices,
  errorCodeOf,
  fixtures,
  outboxCounts,
  outboxEvents,
  openTempDb,
  startLocationId,
  testKey,
  type TempDb,
} from './helpers.js';

/**
 * SessionService (промпт 1.6; машина состояний сессии — F-3.5).
 *
 * Проверяются: createSession (LOBBY + GM + pack + GameState v0), joinSession
 * (лимиты, уникальность имени, статус LOBBY), startSession (≥1 игрок не-GM,
 * ход №1), pause/resume, endSession (archivedAt, SESSION_ENDED, join закрыт),
 * removePlayer/leaveSession (LEFT + PLAYER_LEFT), createCharacter, D108.
 */

let db: TempDb;
let services: CoreServices;

beforeAll(async () => {
  db = await openTempDb('session-service', { seed: false });
  services = buildTestServices(db);
});

afterAll(async () => {
  await db?.close();
});

describe('createSession', () => {
  let sessionId: SessionId;
  let gmPlayerId: PlayerId;

  it('создаёт LOBBY: GM-игрок, локации pack, GameState version 0 на стартовой локации', async () => {
    const created = await services.sessions.createSession({
      title: 'Ночная смена',
      gmDisplayName: 'Ведущая',
      idempotencyKey: testKey('create'),
      traceId: 'trace-create',
    });
    sessionId = created.sessionId;
    gmPlayerId = created.gmPlayerId;
    expect(created.status).toBe('LOBBY');

    const session = await services.sessions.getSession(sessionId);
    expect(session.status).toBe('LOBBY');
    expect(session.playerIds).toEqual([gmPlayerId]);
    expect(session.gmPlayerId).toBe(gmPlayerId);
    expect(session.worldPackId).toBe(fixtures.packId);
    expect(session.worldPackVersion).toBe(fixtures.version);
    expect(session.currentTurnId).toBeNull();
    expect(session.archivedAt).toBeNull();

    const players = await services.sessions.listPlayers(sessionId);
    expect(players.length).toBe(1);
    expect(players[0]!.isGM).toBe(true);
    expect(players[0]!.displayName).toBe('Ведущая');

    const locations = await services.locations.list(sessionId);
    expect(locations.length).toBe(fixtures.locations.length);
    for (const location of locations) expect(location.sessionId).toBe(sessionId);

    const state = await services.state.get(sessionId);
    expect(state.version).toBe(0);
    expect(state.worldState.currentLocationId).toBe(startLocationId);
    expect(state.worldState.timeOfDay).toBe('UNKNOWN'); // Q1 открыт — нейтральный канон
    expect(Object.keys(state.objectStates).length).toBe(9); // 3 локации × 3 объекта
    expect(state.playerKnowledge[gmPlayerId]).toBeDefined();
  });

  it('D108: вторая живая сессия на сервере → CONFLICT', async () => {
    const code = await errorCodeOf(() =>
      services.sessions.createSession({
        title: 'Вторая сессия',
        gmDisplayName: 'Ведущий 2',
        idempotencyKey: testKey('create2'),
      }),
    );
    expect(code).toBe('CONFLICT');
  });

  it('createSession идемпотентна: повтор того же ключа возвращает прежний результат', async () => {
    const key = testKey('idem-create');
    // Сессия уже существует → выполнится ветка D108? Нет: guard СОХРАНИЛ результат
    // первого вызова только для ЭТОГО ключа. Проверяем на отдельном сервере-состоянии:
    // конец сессии → create → create(тот же ключ) → replayed.
    await services.sessions.endSession({ sessionId, reason: 'тест идемпотентности', idempotencyKey: testKey('end') });
    const first = await services.sessions.createSession({
      title: 'Сессия после архива',
      gmDisplayName: 'Ведущий 3',
      idempotencyKey: key,
    });
    const second = await services.sessions.createSession({
      title: 'Сессия после архива',
      gmDisplayName: 'Ведущий 3',
      idempotencyKey: key,
    });
    expect(second.replayed).toBe(true);
    expect(second.sessionId).toBe(first.sessionId);
    const counts = await outboxCounts(db);
    expect(counts['SESSION_CREATED']).toBe(2); // первая сессия + эта; replay события не добавил
  });
});

describe('joinSession / startSession / жизненный цикл', () => {
  let sessionId: SessionId;
  let gmPlayerId: PlayerId;
  let alice: PlayerId;
  let bob: PlayerId;

  beforeAll(async () => {
    // Активная сессия уже существует (создана в конце describe('createSession')).
    const sessions = await db.boot.uow.repos().sessions.listAll();
    const live = sessions.find((s) => s.status === 'LOBBY')!;
    sessionId = live.sessionId;
    gmPlayerId = live.gmPlayerId;
  });

  it('join в LOBBY: игрок + персонаж, playerIds растёт, PLAYER_JOINED', async () => {
    const joined = await services.sessions.joinSession({
      sessionId,
      displayName: 'Алиса',
      idempotencyKey: testKey('join'),
    });
    alice = joined.playerId;
    expect(joined.displayName).toBe('Алиса');
    const session = await services.sessions.getSession(sessionId);
    expect(session.playerIds).toContain(alice);
    expect(session.playerIds.length).toBe(2);

    const character = await db.boot.uow.repos().characters.findById(joined.characterId);
    expect(character?.name).toBe('Алиса'); // D157: имя персонажа = имя игрока при join
    expect(character?.stats).toEqual({});

    const events = (await outboxEvents(db)).filter((e) => e.eventName === 'PLAYER_JOINED');
    expect(events.at(-1)!.payload).toMatchObject({ sessionId, playerId: alice, characterName: 'Алиса' });
  });

  it('displayName уникален в сессии → CONFLICT', async () => {
    const code = await errorCodeOf(() =>
      services.sessions.joinSession({ sessionId, displayName: 'Алиса', idempotencyKey: testKey('join-dup') }),
    );
    expect(code).toBe('CONFLICT');
  });

  it('startSession без игроков (кроме GM) → CONFLICT', async () => {
    // Алиса есть, но для чистоты проверим на fresh-сессии позже; здесь — успешный старт:
    const joined = await services.sessions.joinSession({
      sessionId,
      displayName: 'Борис',
      idempotencyKey: testKey('join-b'),
    });
    bob = joined.playerId;
    const started = await services.sessions.startSession({ sessionId, idempotencyKey: testKey('start') });
    expect(started.status).toBe('ACTIVE');
    expect(started.turnNumber).toBe(1);
    const session = await services.sessions.getSession(sessionId);
    expect(session.status).toBe('ACTIVE');
    expect(session.currentTurnId).toBe(started.turnId);
  });

  it('join после старта → CORE_INVALID_STATE_TRANSITION (только LOBBY)', async () => {
    const code = await errorCodeOf(() =>
      services.sessions.joinSession({ sessionId, displayName: 'Вера', idempotencyKey: testKey('join-late') }),
    );
    expect(code).toBe('CORE_INVALID_STATE_TRANSITION');
  });

  it('pause → PAUSED, resume → ACTIVE; повторный pause из ACTIVE обязателен, из PAUSED — ошибка', async () => {
    const paused = await services.sessions.pauseSession({ sessionId, idempotencyKey: testKey('pause') });
    expect(paused.status).toBe('PAUSED');
    const code = await errorCodeOf(() =>
      services.sessions.pauseSession({ sessionId, idempotencyKey: testKey('pause2') }),
    );
    expect(code).toBe('CORE_INVALID_STATE_TRANSITION');
    const resumed = await services.sessions.resumeSession({ sessionId, idempotencyKey: testKey('resume') });
    expect(resumed.status).toBe('ACTIVE');
    const code2 = await errorCodeOf(() =>
      services.sessions.resumeSession({ sessionId, idempotencyKey: testKey('resume2') }),
    );
    expect(code2).toBe('CORE_INVALID_STATE_TRANSITION');
  });

  it('removePlayer (GM): статус LEFT, roster уменьшается, PLAYER_LEFT{KICKED}', async () => {
    const removed = await services.sessions.removePlayer({
      sessionId,
      playerId: bob,
      idempotencyKey: testKey('kick'),
    });
    expect(removed.status).toBe('LEFT');
    const session = await services.sessions.getSession(sessionId);
    expect(session.playerIds).not.toContain(bob);
    const player = await db.boot.uow.repos().players.findById(bob);
    expect(player?.status).toBe('LEFT');
    expect(player?.leftAt).not.toBeNull();

    const left = (await outboxEvents(db)).filter((e) => e.eventName === 'PLAYER_LEFT');
    expect(left.at(-1)!.payload).toMatchObject({ playerId: bob, reason: 'KICKED' });

    // Повторный kick уже ушедшего — no-op без второго события:
    const again = await services.sessions.removePlayer({
      sessionId,
      playerId: bob,
      idempotencyKey: testKey('kick2'),
    });
    expect(again.status).toBe('LEFT');
    const leftAfter = (await outboxEvents(db)).filter((e) => e.eventName === 'PLAYER_LEFT');
    expect(leftAfter.length).toBe(left.length);
  });

  it('GM нельзя удалить и GM не может выйти (D222)', async () => {
    const kickGm = await errorCodeOf(() =>
      services.sessions.removePlayer({ sessionId, playerId: gmPlayerId, idempotencyKey: testKey('kick-gm') }),
    );
    expect(kickGm).toBe('CONFLICT');
    const gmLeave = await errorCodeOf(() =>
      services.sessions.leaveSession({ sessionId, playerId: gmPlayerId, idempotencyKey: testKey('leave-gm') }),
    );
    expect(gmLeave).toBe('CONFLICT');
  });

  it('leaveSession: игрок уходит сам → LEFT + PLAYER_LEFT{LEFT}', async () => {
    const left = await services.sessions.leaveSession({
      sessionId,
      playerId: alice,
      idempotencyKey: testKey('leave'),
    });
    expect(left.status).toBe('LEFT');
    const events = (await outboxEvents(db)).filter((e) => e.eventName === 'PLAYER_LEFT');
    expect(events.at(-1)!.payload).toMatchObject({ playerId: alice, reason: 'LEFT' });
  });

  it('endSession: ENDED + archivedAt + SESSION_ENDED; повтор → CORE_INVALID_STATE_TRANSITION', async () => {
    const ended = await services.sessions.endSession({
      sessionId,
      reason: 'Партия доиграна',
      idempotencyKey: testKey('end'),
    });
    expect(ended.status).toBe('ENDED');
    const session = await services.sessions.getSession(sessionId);
    expect(session.archivedAt).not.toBeNull();
    const events = (await outboxEvents(db)).filter((e) => e.eventName === 'SESSION_ENDED');
    expect(events.at(-1)!.payload).toMatchObject({ sessionId, reason: 'Партия доиграна' });

    const code = await errorCodeOf(() =>
      services.sessions.endSession({ sessionId, reason: 'ещё раз', idempotencyKey: testKey('end2') }),
    );
    expect(code).toBe('CORE_INVALID_STATE_TRANSITION');
  });

  it('после endSession join закрыт', async () => {
    const code = await errorCodeOf(() =>
      services.sessions.joinSession({ sessionId, displayName: 'Поздний гость', idempotencyKey: testKey('join-x') }),
    );
    expect(code).toBe('CORE_INVALID_STATE_TRANSITION');
  });
});

describe('лимит партии и createCharacter', () => {
  it('maxPlayersPerSession=3: GM + 2 игрока, третий → CONFLICT (session_full)', async () => {
    const smallDb = await openTempDb('session-limit', { seed: false });
    try {
      const small = buildTestServices(smallDb, { maxPlayersPerSession: 3 });
      const created = await small.sessions.createSession({
        title: 'Маленькая партия',
        gmDisplayName: 'Ведущий',
        idempotencyKey: testKey('create-small'),
      });
      await small.sessions.joinSession({
        sessionId: created.sessionId,
        displayName: 'Первый',
        idempotencyKey: testKey('join-s1'),
      });
      await small.sessions.joinSession({
        sessionId: created.sessionId,
        displayName: 'Второй',
        idempotencyKey: testKey('join-s2'),
      });
      const code = await errorCodeOf(() =>
        small.sessions.joinSession({
          sessionId: created.sessionId,
          displayName: 'Третий',
          idempotencyKey: testKey('join-s3'),
        }),
      );
      expect(code).toBe('CONFLICT');
    } finally {
      await smallDb.close();
    }
  });

  it('startSession без игроков не-GM → CONFLICT (need_at_least_one_player)', async () => {
    const soloDb = await openTempDb('session-solo', { seed: false });
    try {
      const solo = buildTestServices(soloDb);
      const created = await solo.sessions.createSession({
        title: 'Соло',
        gmDisplayName: 'Ведущий',
        idempotencyKey: testKey('create-solo'),
      });
      const code = await errorCodeOf(() =>
        solo.sessions.startSession({ sessionId: created.sessionId, idempotencyKey: testKey('start-solo') }),
      );
      expect(code).toBe('CONFLICT');
    } finally {
      await soloDb.close();
    }
  });

  it('createCharacter: свободный персонаж со stats={}; join с существующим characterId', async () => {
    const charDb = await openTempDb('session-chars', { seed: false });
    try {
      const svc = buildTestServices(charDb);
      const created = await svc.sessions.createSession({
        title: 'Персонажи',
        gmDisplayName: 'Ведущий',
        idempotencyKey: testKey('create-c'),
      });
      const character = await svc.sessions.createCharacter({
        sessionId: created.sessionId,
        name: 'Доктор Вейс',
        archetype: 'medic',
        idempotencyKey: testKey('char'),
      });
      const stored = await charDb.boot.uow.repos().characters.findById(character.characterId);
      expect(stored?.name).toBe('Доктор Вейс');
      expect(stored?.archetype).toBe('medic');
      expect(stored?.stats).toEqual({});

      const joined = await svc.sessions.joinSession({
        sessionId: created.sessionId,
        displayName: 'Игрок Вейса',
        characterId: character.characterId,
        idempotencyKey: testKey('join-c'),
      });
      expect(joined.characterId).toBe(character.characterId);

      // Второй игрок с тем же персонажем → CONFLICT (character_taken):
      const code = await errorCodeOf(() =>
        svc.sessions.joinSession({
          sessionId: created.sessionId,
          displayName: 'Самозванец',
          characterId: character.characterId,
          idempotencyKey: testKey('join-c2'),
        }),
      );
      expect(code).toBe('CONFLICT');

      // Чужой characterId (не из этой сессии) → CORE_NOT_FOUND:
      const foreign = await errorCodeOf(() =>
        svc.sessions.joinSession({
          sessionId: created.sessionId,
          displayName: 'Чужой',
          characterId: randomUUID() as CharacterId,
          idempotencyKey: testKey('join-c3'),
        }),
      );
      expect(foreign).toBe('CORE_NOT_FOUND');

      // createCharacter в завершённой сессии → CONFLICT:
      await svc.sessions.endSession({
        sessionId: created.sessionId,
        reason: 'стоп',
        idempotencyKey: testKey('end-c'),
      });
      const afterEnd = await errorCodeOf(() =>
        svc.sessions.createCharacter({
          sessionId: created.sessionId,
          name: 'Поздний',
          idempotencyKey: testKey('char2'),
        }),
      );
      expect(afterEnd).toBe('CONFLICT');
    } finally {
      await charDb.close();
    }
  });
});

describe('ошибки входа', () => {
  it('короткий idempotencyKey (<16) → VALIDATION', async () => {
    const code = await errorCodeOf(() =>
      services.sessions.createSession({ title: 'X', gmDisplayName: 'Y', idempotencyKey: 'short' }),
    );
    expect(code).toBe('VALIDATION');
  });

  it('несуществующая сессия → CORE_NOT_FOUND', async () => {
    const code = await errorCodeOf(() => services.sessions.getSession(randomUUID() as SessionId));
    expect(code).toBe('CORE_NOT_FOUND');
  });
});
