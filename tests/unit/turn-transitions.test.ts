import { describe, expect, it } from 'vitest';

import {
  CoreError,
  SESSION_TRANSITIONS,
  TURN_TRANSITIONS,
  TURN_TRANSITION_TABLE,
  isSessionTransitionAllowed,
  isTurnTransitionAllowed,
  type SessionStatus,
  type TurnStatus,
} from '@mnemosin/contracts';
import { allowedTransitions, assertTransition, turnTransitionRow } from '@mnemosin/core';

/**
 * A1.6 (промпт 1.6): «обход всех разрешённых переходов + по одному запрещённому
 * на каждый статус» — здесь запрещённых больше: полный перебор всех пар.
 * Основание: v3 §II.5 (таблица переходов Turn), SPEC §3.3 (Session), B-07, F-3.5.
 */

const TURN_STATUSES: TurnStatus[] = ['OPEN', 'LOCKED', 'PROCESSING', 'REVIEW', 'COMMITTED', 'FAILED'];
const SESSION_STATUSES: SessionStatus[] = ['LOBBY', 'ACTIVE', 'PAUSED', 'ENDED'];

function allPairs<T extends string>(statuses: T[]): Array<[T, T]> {
  return statuses.flatMap((from) => statuses.map((to) => [from, to] as [T, T]));
}

describe('Машина состояний Turn (A1.6, v3 §II.5)', () => {
  it('все разрешённые переходы таблицы проходят assertTransition', () => {
    let allowed = 0;
    for (const [from, to] of allPairs(TURN_STATUSES)) {
      if (TURN_TRANSITIONS[from].includes(to)) {
        expect(() => assertTransition('turn', from, to), `${from}→${to}`).not.toThrow();
        expect(isTurnTransitionAllowed(from, to)).toBe(true);
        allowed += 1;
      }
    }
    // OPEN→{LOCKED,FAILED}, LOCKED→{OPEN,PROCESSING}, PROCESSING→{REVIEW,FAILED},
    // REVIEW→{COMMITTED,FAILED,OPEN} (retry, F-3.1) = 9 разрешённых пар.
    expect(allowed).toBe(9);
  });

  it('каждый запрещённый переход бросает CORE_INVALID_STATE_TRANSITION с meta {entity,from,to}', () => {
    let forbidden = 0;
    for (const [from, to] of allPairs(TURN_STATUSES)) {
      if (!TURN_TRANSITIONS[from].includes(to)) {
        let caught: unknown = null;
        try {
          assertTransition('turn', from, to);
        } catch (cause) {
          caught = cause;
        }
        expect(caught, `${from}→${to} не бросил`).toBeInstanceOf(CoreError);
        const err = caught as CoreError;
        expect(err.code).toBe('CORE_INVALID_STATE_TRANSITION');
        expect(err.meta).toMatchObject({ entity: 'turn', from, to });
        expect(isTurnTransitionAllowed(from, to)).toBe(false);
        forbidden += 1;
      }
    }
    // 36 пар − 9 разрешённых = 27 запрещённых (включая самопереходы и всё из COMMITTED/FAILED).
    expect(forbidden).toBe(27);
    // «по одному запрещённому на каждый статус» — минимум выполняется с запасом:
    for (const status of TURN_STATUSES) {
      const has = allPairs(TURN_STATUSES).some(
        ([from, to]) => (from === status || to === status) && !TURN_TRANSITIONS[from].includes(to),
      );
      expect(has, `нет запрещённого перехода для ${status}`).toBe(true);
    }
  });

  it('терминальные статусы не имеют выходов', () => {
    expect(TURN_TRANSITIONS['COMMITTED']).toEqual([]);
    expect(TURN_TRANSITIONS['FAILED']).toEqual([]);
  });

  it('TURN_TRANSITION_TABLE согласована с TURN_TRANSITIONS (данные ↔ карта)', () => {
    // Каждая строка таблицы — разрешённая пара.
    for (const row of TURN_TRANSITION_TABLE) {
      expect(TURN_TRANSITIONS[row.from], `${row.from}→${row.to}`).toContain(row.to);
      expect(turnTransitionRow(row.from, row.trigger)).toEqual(row);
    }
    // Каждая разрешённая пара покрыта ровно одной строкой таблицы.
    for (const [from, to] of allPairs(TURN_STATUSES)) {
      if (TURN_TRANSITIONS[from].includes(to)) {
        const rows = TURN_TRANSITION_TABLE.filter((r) => r.from === from && r.to === to);
        expect(rows.length, `${from}→${to}`).toBe(1);
      }
    }
  });

  it('turnTransitionRow: неприменимый триггер → null; allowedTransitions возвращает таблицу', () => {
    expect(turnTransitionRow('COMMITTED', 'lockTurn')).toBeNull();
    expect(turnTransitionRow('OPEN', 'commitTurn')).toBeNull();
    expect(allowedTransitions('turn', 'OPEN')).toEqual(['LOCKED', 'FAILED']);
    expect(allowedTransitions('turn', 'FAILED')).toEqual([]);
  });
});

describe('Машина состояний Session (F-3.5, SPEC §3.3)', () => {
  it('все разрешённые переходы проходят assertTransition', () => {
    let allowed = 0;
    for (const [from, to] of allPairs(SESSION_STATUSES)) {
      if (SESSION_TRANSITIONS[from].includes(to)) {
        expect(() => assertTransition('session', from, to), `${from}→${to}`).not.toThrow();
        expect(isSessionTransitionAllowed(from, to)).toBe(true);
        allowed += 1;
      }
    }
    // LOBBY→{ACTIVE,ENDED}, ACTIVE→{PAUSED,ENDED}, PAUSED→{ACTIVE,ENDED} = 6.
    expect(allowed).toBe(6);
  });

  it('каждый запрещённый переход бросает CORE_INVALID_STATE_TRANSITION', () => {
    let forbidden = 0;
    for (const [from, to] of allPairs(SESSION_STATUSES)) {
      if (!SESSION_TRANSITIONS[from].includes(to)) {
        let caught: unknown = null;
        try {
          assertTransition('session', from, to);
        } catch (cause) {
          caught = cause;
        }
        expect(caught, `${from}→${to} не бросил`).toBeInstanceOf(CoreError);
        expect((caught as CoreError).code).toBe('CORE_INVALID_STATE_TRANSITION');
        expect((caught as CoreError).meta).toMatchObject({ entity: 'session', from, to });
        forbidden += 1;
      }
    }
    expect(forbidden).toBe(10); // 16 пар − 6 разрешённых
  });

  it('ENDED терминален; из LOBBY нельзя в PAUSED напрямую', () => {
    expect(SESSION_TRANSITIONS['ENDED']).toEqual([]);
    expect(() => assertTransition('session', 'LOBBY', 'PAUSED')).toThrow(CoreError);
    expect(allowedTransitions('session', 'ENDED')).toEqual([]);
  });
});
