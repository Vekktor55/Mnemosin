import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CoreServices } from '@mnemosin/core';
import type { PlayerId, SessionId, TurnId } from '@mnemosin/contracts';

import {
  bootLobby,
  buildTestServices,
  errorCodeOf,
  outboxCounts,
  outboxEvents,
  openTempDb,
  testKey,
  type TempDb,
} from './helpers.js';

/**
 * TurnService (промпт 1.6, критерий A1.6; закрывает B-07).
 *
 * Проверяются: команды openTurn/lockTurn/unlockTurn/cancelTurn/submitAction,
 * полный путь OPEN→LOCKED→PROCESSING→REVIEW→COMMITTED через transition(),
 * запрещённые переходы, монотонность number и sequenceId под параллельной
 * нагрузкой, лимит действий, идемпотентность (replay), журнал и outbox-события.
 *
 * Раскладка действий по ходу №1 (лимит 5 на игрока, 5 игроков):
 *   базовые: p0, p1, p2 (по 1) → параллельные 20 (4 круга × 5 игроков) → всего 23;
 *   p0 после этого на лимите (1+4=5) — шестое действие → RATE_LIMIT.
 */

let db: TempDb;
let services: CoreServices;
let sessionId: SessionId;
let gmPlayerId: PlayerId;
let playerIds: PlayerId[];
let turn1: TurnId;

beforeAll(async () => {
  db = await openTempDb('turn-service', { seed: false });
  services = buildTestServices(db);
  const world = await bootLobby(services, { players: 5 });
  sessionId = world.sessionId;
  gmPlayerId = world.gmPlayerId;
  playerIds = world.playerIds;
  turn1 = world.turnId!;
});

afterAll(async () => {
  await db?.close();
});

describe('startSession/openTurn', () => {
  it('ход №1 открыт стартом сессии: статус OPEN, session.currentTurnId установлен', async () => {
    const turn = await services.turns.getTurn(turn1);
    expect(turn.status).toBe('OPEN');
    expect(turn.number).toBe(1);
    const session = await services.sessions.getSession(sessionId);
    expect(session.currentTurnId).toBe(turn1);
  });

  it('события SESSION_STATUS_CHANGED и TURN_OPENED записаны в outbox одной транзакцией', async () => {
    const events = await outboxEvents(db);
    const opened = events.filter((e) => e.eventName === 'TURN_OPENED');
    expect(opened.length).toBe(1);
    expect(opened[0]!.payload).toMatchObject({ turnId: turn1, number: 1, sessionId });
    expect(events.some((e) => e.eventName === 'SESSION_STATUS_CHANGED')).toBe(true);
  });
});

describe('submitAction', () => {
  it('принимает действие в OPEN-ход: sequenceId монотонно, событие ACTION_SUBMITTED', async () => {
    const first = await services.turns.submitAction({
      turnId: turn1,
      playerId: playerIds[0]!,
      rawText: 'Осматриваюсь по сторонам',
      idempotencyKey: testKey('act'),
      traceId: 'trace-submit-1',
    });
    expect(first.sequenceId).toBe(1);
    expect(first.duplicate).toBe(false);
    const second = await services.turns.submitAction({
      turnId: turn1,
      playerId: playerIds[1]!,
      rawText: 'Прислушиваюсь к гулу вентиляции',
      meta: { intent: 'OBSERVE' },
      idempotencyKey: testKey('act'),
    });
    expect(second.sequenceId).toBe(2);

    const submitted = (await outboxEvents(db)).filter((e) => e.eventName === 'ACTION_SUBMITTED');
    expect(submitted.length).toBe(2);
    expect(submitted[0]!.payload).toMatchObject({ actionId: first.actionId, sequenceId: 1 });
  });

  it('повтор того же idempotencyKey возвращает прежний actionId (duplicate, B-08)', async () => {
    const key = testKey('act-dup');
    const first = await services.turns.submitAction({
      turnId: turn1,
      playerId: playerIds[2]!,
      rawText: 'Проверяю карманы',
      idempotencyKey: key,
    });
    const again = await services.turns.submitAction({
      turnId: turn1,
      playerId: playerIds[2]!,
      rawText: 'Проверяю карманы',
      idempotencyKey: key,
    });
    expect(again.actionId).toBe(first.actionId);
    expect(again.sequenceId).toBe(first.sequenceId);
    expect(again.replayed).toBe(true);
    // Событие не задвоилось: ACTION_SUBMITTED по-прежнему 3 (2 из прошлого теста + 1).
    const submitted = (await outboxEvents(db)).filter((e) => e.eventName === 'ACTION_SUBMITTED');
    expect(submitted.length).toBe(3);
  });

  it('20 параллельных подач → ровно 20 уникальных sequenceId (UNIQUE(turn,seq) страхует гонку)', async () => {
    const jobs: Array<Promise<{ sequenceId: number }>> = [];
    for (let round = 0; round < 4; round += 1) {
      for (const playerId of playerIds) {
        jobs.push(
          services.turns.submitAction({
            turnId: turn1,
            playerId,
            rawText: `Действие круга ${round}: осматриваюсь`,
            idempotencyKey: testKey('par'),
          }),
        );
      }
    }
    const results = await Promise.all(jobs);
    const sequenceIds = results.map((r) => r.sequenceId).sort((a, b) => a - b);
    expect(sequenceIds).toEqual(Array.from({ length: 20 }, (_, i) => i + 4)); // 1..3 уже заняты
    expect(new Set(sequenceIds).size).toBe(20);
  });

  it('лимит действий на игрока за ход (5) → RATE_LIMIT', async () => {
    // p0 подал 1 (базовый) + 4 (параллельные) = 5 — ровно лимит; шестое отклоняется.
    const code = await errorCodeOf(() =>
      services.turns.submitAction({
        turnId: turn1,
        playerId: playerIds[0]!,
        rawText: 'Ещё одна попытка сверх лимита',
        idempotencyKey: testKey('over'),
      }),
    );
    expect(code).toBe('RATE_LIMIT');
    // Отказ не создал ни действия, ни события:
    const submitted = (await outboxEvents(db)).filter((e) => e.eventName === 'ACTION_SUBMITTED');
    expect(submitted.length).toBe(23);
  });
});

describe('lock/unlock/cancel — машина состояний на живых командах', () => {
  it('lockTurn: OPEN→LOCKED, actionIds из таблицы actions (F-1.17), lockedAt проставлен', async () => {
    const locked = await services.turns.lockTurn({ turnId: turn1, idempotencyKey: testKey('lock') });
    expect(locked.status).toBe('LOCKED');
    expect(locked.actionIds.length).toBe(23); // 3 базовых + 20 параллельных
    const turn = await services.turns.getTurn(turn1);
    expect(turn.lockedAt).not.toBeNull();

    const events = (await outboxEvents(db)).filter((e) => e.eventName === 'TURN_LOCKED');
    expect(events.length).toBe(1);
    expect((events[0]!.payload['actionIds'] as unknown[]).length).toBe(23);
  });

  it('lockTurn в LOCKED (новый ключ) → CORE_INVALID_STATE_TRANSITION, событие не дублируется', async () => {
    const eventsBefore = (await outboxEvents(db)).filter((e) => e.eventName === 'TURN_LOCKED').length;
    const code = await errorCodeOf(() => services.turns.lockTurn({ turnId: turn1, idempotencyKey: testKey('lock2') }));
    expect(code).toBe('CORE_INVALID_STATE_TRANSITION');
    const eventsAfter = (await outboxEvents(db)).filter((e) => e.eventName === 'TURN_LOCKED').length;
    expect(eventsAfter).toBe(eventsBefore);
  });

  it('submitAction в LOCKED-ход → TURN_NOT_OPEN', async () => {
    const code = await errorCodeOf(() =>
      services.turns.submitAction({
        turnId: turn1,
        playerId: playerIds[3]!,
        rawText: 'Поздно, ход закрыт',
        idempotencyKey: testKey('late'),
      }),
    );
    expect(code).toBe('TURN_NOT_OPEN');
  });

  it('cancelTurn в LOCKED → CORE_INVALID_STATE_TRANSITION (GM-отмена только из OPEN)', async () => {
    const code = await errorCodeOf(() =>
      services.turns.cancelTurn({ turnId: turn1, reason: 'нельзя', idempotencyKey: testKey('cancel') }),
    );
    expect(code).toBe('CORE_INVALID_STATE_TRANSITION');
  });

  it('unlockTurn: LOCKED→OPEN, lockedAt сброшен, событие TURN_UNLOCKED (D114)', async () => {
    const unlocked = await services.turns.unlockTurn({ turnId: turn1, idempotencyKey: testKey('unlock') });
    expect(unlocked.status).toBe('OPEN');
    const turn = await services.turns.getTurn(turn1);
    expect(turn.lockedAt).toBeNull();
    const events = (await outboxEvents(db)).filter((e) => e.eventName === 'TURN_UNLOCKED');
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toMatchObject({ turnId: turn1, sessionId });
  });

  it('unlockTurn в OPEN → CORE_INVALID_STATE_TRANSITION', async () => {
    const code = await errorCodeOf(() =>
      services.turns.unlockTurn({ turnId: turn1, idempotencyKey: testKey('unlock2') }),
    );
    expect(code).toBe('CORE_INVALID_STATE_TRANSITION');
  });

  it('полный путь OPEN→LOCKED→PROCESSING→REVIEW→COMMITTED (A1.6)', async () => {
    await services.turns.lockTurn({ turnId: turn1, idempotencyKey: testKey('lock3') });
    const p1 = await services.turns.transition({ turnId: turn1, trigger: 'startProcessing' });
    expect(p1.status).toBe('PROCESSING');
    const p2 = await services.turns.transition({ turnId: turn1, trigger: 'draftReady' });
    expect(p2.status).toBe('REVIEW');
    const p3 = await services.turns.transition({ turnId: turn1, trigger: 'commitTurn' });
    expect(p3.status).toBe('COMMITTED');
    const turn = await services.turns.getTurn(turn1);
    expect(turn.lockedAt).not.toBeNull();
    expect(turn.processingStartedAt).not.toBeNull();
    expect(turn.reviewReadyAt).not.toBeNull();
    expect(turn.committedAt).not.toBeNull();
  });

  it('transition с неприменимым триггером → CORE_INVALID_STATE_TRANSITION; COMMITTED терминален', async () => {
    const code = await errorCodeOf(() => services.turns.transition({ turnId: turn1, trigger: 'lockTurn' }));
    expect(code).toBe('CORE_INVALID_STATE_TRANSITION');
    const code2 = await errorCodeOf(() => services.turns.transition({ turnId: turn1, trigger: 'retry' }));
    expect(code2).toBe('CORE_INVALID_STATE_TRANSITION');
  });

  it('журнал хода содержит всю хронологию шагов с traceId', async () => {
    const entries = await services.journal.list(turn1);
    const kinds = entries.map((e) => e.kind);
    for (const expected of [
      'turn_opened',
      'action_submitted',
      'turn_locked',
      'turn_unlocked',
      'processing_started',
      'draft_ready',
      'committed',
    ]) {
      expect(kinds, `нет шага ${expected}`).toContain(expected);
    }
    const opened = entries.find((e) => e.kind === 'turn_opened')!;
    expect(opened.traceId.length).toBeGreaterThan(0);
    expect(opened.payload['number']).toBe(1);
  });
});

describe('getTurnView', () => {
  it('проекция COMMITTED-хода: actionCount полный, myActions — только действия viewer', async () => {
    const view = await services.turns.getTurnView(turn1, gmPlayerId);
    expect(view.status).toBe('COMMITTED');
    expect(view.actionCount).toBe(23);
    expect(view.myActions).toEqual([]); // GM действий не подавал
    expect(view.failed).toBeNull();

    const own = await services.turns.getTurnView(turn1, playerIds[0]);
    expect(own.myActions.length).toBe(5); // 1 базовое + 4 параллельных
    for (const action of own.myActions) {
      expect(action.rawText.length).toBeGreaterThan(0);
    }
  });
});

describe('openTurn: номерация и «один ход на сессию» (D220)', () => {
  let turn2: TurnId;

  it('после COMMITTED открывается ход №2; currentTurnId переключён', async () => {
    const opened = await services.turns.openTurn({ sessionId, idempotencyKey: testKey('open2') });
    expect(opened.number).toBe(2);
    expect(opened.status).toBe('OPEN');
    turn2 = opened.turnId;
    const session = await services.sessions.getSession(sessionId);
    expect(session.currentTurnId).toBe(turn2);
  });

  it('4 параллельных openTurn при живом OPEN-ходе → все отклонены, дублей номера нет', async () => {
    const race = await Promise.all(
      [1, 2, 3, 4].map(() =>
        errorCodeOf(() => services.turns.openTurn({ sessionId, idempotencyKey: testKey('race') })),
      ),
    );
    expect(race.every((code) => code === 'CORE_INVALID_STATE_TRANSITION')).toBe(true);

    const turns = await services.turns.listTurns(sessionId);
    const numbers = turns.map((t) => t.number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2]);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('действие в ход №2 видно в проекции', async () => {
    await services.turns.submitAction({
      turnId: turn2,
      playerId: playerIds[1]!,
      rawText: 'Действие в ход 2',
      idempotencyKey: testKey('act-t2'),
    });
    const view = await services.turns.getTurnView(turn2, playerIds[1]);
    expect(view.actionCount).toBe(1);
    expect(view.myActions.length).toBe(1);
    expect(view.myActions[0]!.rawText).toBe('Действие в ход 2');
    const other = await services.turns.getTurnView(turn2, playerIds[0]);
    expect(other.myActions).toEqual([]);
  });

  it('cancelTurn: OPEN→FAILED, failed.code, событие TURN_FAILED; затем ход №3', async () => {
    const cancelled = await services.turns.cancelTurn({
      turnId: turn2,
      reason: 'GM отменил ход: игрок отошёл',
      idempotencyKey: testKey('cancel2'),
      traceId: 'trace-cancel',
    });
    expect(cancelled.status).toBe('FAILED');
    expect(cancelled.failed.code).toBe('CONFLICT');
    expect(cancelled.failed.message).toContain('GM отменил ход');

    const failed = (await outboxEvents(db)).filter((e) => e.eventName === 'TURN_FAILED');
    expect(failed.length).toBe(1);
    expect(failed[0]!.payload).toMatchObject({ errorCode: 'CONFLICT', turnId: cancelled.turnId, sessionId });

    const turn3 = await services.turns.openTurn({ sessionId, idempotencyKey: testKey('open3') });
    expect(turn3.number).toBe(3);
  });
});

describe('outbox-итоги сценария', () => {
  it('счётчики событий соответствуют выполненным командам', async () => {
    const counts = await outboxCounts(db);
    expect(counts['SESSION_CREATED']).toBe(1);
    expect(counts['PLAYER_JOINED']).toBe(5);
    expect(counts['TURN_OPENED']).toBe(3); // ходы 1, 2, 3
    expect(counts['TURN_LOCKED']).toBe(2); // lock + lock3
    expect(counts['TURN_UNLOCKED']).toBe(1);
    expect(counts['TURN_FAILED']).toBe(1);
    expect(counts['ACTION_SUBMITTED']).toBe(24); // 3 + 20 + 1 (в ход 2)
  });
});
