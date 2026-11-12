import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import type { CoreServices } from '@mnemosin/core';
import { moveIdempotencyKey } from '@mnemosin/core';
import type { LocationDefinition, LocationId, PlayerId, SessionId, TurnId } from '@mnemosin/contracts';

import {
  bootLobby,
  buildTestServices,
  errorCodeOf,
  fixtures,
  makeLocation,
  outboxCounts,
  outboxEvents,
  openTempDb,
  startLocationId,
  testKey,
  type TempDb,
} from './helpers.js';

/**
 * LocationService (промпт 1.6, критерий A1.15; закрывает F-3.6).
 *
 * Проверяются: loadPackToSession, get/list/exitsOf, moveGroup — счастливый путь
 * (LOCATION_CHANGED + STATE_COMMITTED + version+1), идемпотентность
 * детерминированным ключом (F-3.6/D217), locked exit → CORE_RULE_REJECTED,
 * несуществующая локация → CORE_LOCATION_NOT_FOUND, чужой игрок → CORE_NOT_FOUND.
 */

let db: TempDb;
let services: CoreServices;
let sessionId: SessionId;
let playerIds: PlayerId[];
let turnId: TurnId;
let lobbyId: LocationId;
let receptionId: LocationId;

/** Локации фикстур: airlock (старт) → lobby → reception. */
const airlockId = startLocationId;

beforeAll(async () => {
  db = await openTempDb('location-service', { seed: false });
  services = buildTestServices(db);
  const world = await bootLobby(services, { players: 3 });
  sessionId = world.sessionId;
  playerIds = world.playerIds;
  turnId = world.turnId!;
  const byName = new Map((await services.locations.list(sessionId)).map((l) => [l.name, l.locationId]));
  lobbyId = byName.get('Холл')!;
  receptionId = byName.get('Регистратура')!;
});

afterAll(async () => {
  await db?.close();
});

describe('loadPackToSession / get / list / exitsOf', () => {
  it('pack загружен при createSession: 3 локации с sessionId', async () => {
    const locations = await services.locations.list(sessionId);
    expect(locations.length).toBe(3);
    for (const location of locations) {
      expect(location.sessionId).toBe(sessionId);
    }
  });

  it('повторный loadPackToSession идемпотентен (upsert, те же UUID — D221)', async () => {
    const result = await services.locations.loadPackToSession({ sessionId });
    expect(result.loaded).toBe(3);
    expect(result.startLocationId).toBe(airlockId);
    const locations = await services.locations.list(sessionId);
    expect(locations.length).toBe(3);
  });

  it('get: локация по id; неизвестная → CORE_LOCATION_NOT_FOUND', async () => {
    const airlock = await services.locations.get(airlockId);
    expect(airlock.name).toBe('Шлюз');
    const code = await errorCodeOf(() => services.locations.get(randomUUID() as LocationId));
    expect(code).toBe('CORE_LOCATION_NOT_FOUND');
  });

  it('exitsOf: выходы локации (Шлюз — лестница вниз + запертая наружная дверь)', async () => {
    const exits = await services.locations.exitsOf(airlockId);
    expect(exits.length).toBe(2);
    const stairs = exits.find((e) => e.kind === 'LOCATION')!;
    expect(stairs.toLocationId).toBe(lobbyId);
    expect(stairs.locked).toBe(false);
    const outside = exits.find((e) => e.kind === 'DESCRIPTIVE')!;
    expect(outside.locked).toBe(true);
    expect(outside.lock.reason).toBeTruthy();
  });
});

describe('moveGroup: счастливый путь (A1.15)', () => {
  it('перемещает группу: version+1, currentLocationId обновлён, LOCATION_CHANGED', async () => {
    const before = await services.state.get(sessionId);
    expect(before.worldState.currentLocationId).toBe(airlockId);

    const moved = await services.locations.moveGroup({
      sessionId,
      playerIds,
      toLocationId: lobbyId,
      turnId,
      traceId: 'trace-move-1',
    });
    expect(moved.fromLocationId).toBe(airlockId);
    expect(moved.toLocationId).toBe(lobbyId);
    expect(moved.alreadyThere).toBe(false);
    expect(moved.replayed).toBe(false);
    expect(moved.version).toBe(before.version + 1);

    const after = await services.state.get(sessionId);
    expect(after.worldState.currentLocationId).toBe(lobbyId);
    expect(after.version).toBe(before.version + 1);

    const events = (await outboxEvents(db)).filter((e) => e.eventName === 'LOCATION_CHANGED');
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toMatchObject({
      sessionId,
      fromLocationId: airlockId,
      toLocationId: lobbyId,
      playerIds,
    });

    // STATE_COMMITTED + журнал хода (moveGroup с turnId):
    const committed = (await outboxEvents(db)).filter((e) => e.eventName === 'STATE_COMMITTED');
    expect(committed.length).toBe(1);
    const journal = await services.journal.list(turnId);
    expect(journal.some((e) => e.kind === 'state_applied')).toBe(true);
  });

  it('повтор ТОГО ЖЕ перемещения → replayed детерминированным ключом, version не растёт (F-3.6)', async () => {
    const before = await services.state.get(sessionId);
    const again = await services.locations.moveGroup({
      sessionId,
      playerIds,
      toLocationId: lobbyId,
      turnId,
      // Намеренно ДРУГОЙ транспортный ключ — guard-ключ детерминированный (D217):
      idempotencyKey: testKey('ignored-by-design'),
      traceId: 'trace-move-replay',
    });
    expect(again.replayed).toBe(true);
    const after = await services.state.get(sessionId);
    expect(after.version).toBe(before.version); // ровно один подъём версии
    const counts = await outboxCounts(db);
    expect(counts['LOCATION_CHANGED']).toBe(1); // событие не задвоилось
  });

  it('детерминированный ключ: порядок playerIds не важен, turnId важен', () => {
    const a = moveIdempotencyKey({ sessionId, turnId, playerIds, toLocationId: lobbyId });
    const b = moveIdempotencyKey({ sessionId, turnId, playerIds: [...playerIds].reverse(), toLocationId: lobbyId });
    expect(a).toBe(b); // sha1 от JSON отсортированного массива (F-3.6)
    expect(a).toMatch(/^move:[0-9a-f]{40}$/);
    expect(a.length).toBeLessThanOrEqual(128); // контракт IdempotencyKey
    const otherTurn = moveIdempotencyKey({
      sessionId,
      turnId: randomUUID() as TurnId,
      playerIds,
      toLocationId: lobbyId,
    });
    expect(otherTurn).not.toBe(a);
    const naive = moveIdempotencyKey({ sessionId, turnId: null, playerIds, toLocationId: lobbyId });
    expect(naive).not.toBe(a);
  });

  it('перемещение в текущую локацию → alreadyThere, version не меняется', async () => {
    const before = await services.state.get(sessionId);
    const noop = await services.locations.moveGroup({
      sessionId,
      playerIds,
      toLocationId: lobbyId, // уже здесь; ключ ОТЛИЧАЕТСЯ (состояние то же) — сработает alreadyThere
      turnId: randomUUID() as TurnId,
      traceId: 'trace-move-noop',
    });
    expect(noop.alreadyThere).toBe(true);
    const after = await services.state.get(sessionId);
    expect(after.version).toBe(before.version);
  });

  it('последующий переход Холл → Регистратура работает (другой ключ)', async () => {
    const moved = await services.locations.moveGroup({
      sessionId,
      playerIds,
      toLocationId: receptionId,
      turnId,
      traceId: 'trace-move-2',
    });
    expect(moved.fromLocationId).toBe(lobbyId);
    expect(moved.alreadyThere).toBe(false);
    const after = await services.state.get(sessionId);
    expect(after.worldState.currentLocationId).toBe(receptionId);
    const counts = await outboxCounts(db);
    expect(counts['LOCATION_CHANGED']).toBe(2);
  });
});

describe('moveGroup: отказы (A1.15)', () => {
  it('нет выхода в цель → CORE_RULE_REJECTED (exit_not_found)', async () => {
    // Группа в Регистратуре; прямого выхода в Шлюз нет (только через Холл).
    let caught: { code?: string; meta?: Record<string, unknown> } | null = null;
    try {
      await services.locations.moveGroup({
        sessionId,
        playerIds,
        toLocationId: airlockId,
        turnId,
        traceId: 'trace-move-nopath',
      });
    } catch (cause) {
      caught = cause as { code?: string; meta?: Record<string, unknown> };
    }
    expect(caught?.code).toBe('CORE_RULE_REJECTED');
    expect(caught?.meta).toMatchObject({ reason: 'exit_not_found' });
  });

  it('запертый выход → CORE_RULE_REJECTED (exit_locked) с причиной из lock.reason', async () => {
    // Строим пару локаций «Коридор → Техотсек» с запертым выходом (сценарий A1.15).
    const corridorId = randomUUID() as LocationId;
    const techId = randomUUID() as LocationId;
    const corridor: LocationDefinition = makeLocation({
      locationId: corridorId,
      sessionId,
      name: 'Технический коридор',
      exits: [
        {
          kind: 'LOCATION',
          toLocationId: techId,
          label: 'Гермодверь в техотсек',
          description: null,
          oneWay: false,
          hidden: false,
          via: 'door',
          locked: true,
          lock: { type: 'keycard', keyRequired: 'card.tech', requiresFlag: null, reason: 'Нужен ключ-карта техотсека' },
        },
      ],
    });
    const tech = makeLocation({ locationId: techId, sessionId, name: 'Техотсек', exits: [] });
    await db.boot.uow.runInTx(async (scope) => {
      await scope.repos.locations.upsert(corridor);
      await scope.repos.locations.upsert(tech);
    });

    // Переводим группу в Коридор sanctioned-путём (StateService, инвариант 13):
    const state = await services.state.get(sessionId);
    await services.state.apply({
      sessionId,
      mutations: [{ kind: 'WORLD_PATCH', currentLocationId: corridorId }],
      expectedVersion: state.version,
      traceId: 'trace-teleport',
    });

    let caught: { code?: string; meta?: Record<string, unknown> } | null = null;
    try {
      await services.locations.moveGroup({
        sessionId,
        playerIds,
        toLocationId: techId,
        turnId,
        traceId: 'trace-move-locked',
      });
    } catch (cause) {
      caught = cause as { code?: string; meta?: Record<string, unknown> };
    }
    expect(caught?.code).toBe('CORE_RULE_REJECTED');
    expect(caught?.meta).toMatchObject({ reason: 'exit_locked', lockType: 'keycard' });
    expect(String(caught?.meta?.['reason'])).toBe('exit_locked');

    // Состояние не изменилось:
    const after = await services.state.get(sessionId);
    expect(after.worldState.currentLocationId).toBe(corridorId);
  });

  it('неизвестная локация назначения → CORE_LOCATION_NOT_FOUND', async () => {
    const code = await errorCodeOf(() =>
      services.locations.moveGroup({
        sessionId,
        playerIds,
        toLocationId: randomUUID() as LocationId,
        turnId,
        traceId: 'trace-move-unknown',
      }),
    );
    expect(code).toBe('CORE_LOCATION_NOT_FOUND');
  });

  it('игрок не из сессии → CORE_NOT_FOUND; пустой список → VALIDATION', async () => {
    const code = await errorCodeOf(() =>
      services.locations.moveGroup({
        sessionId,
        playerIds: [randomUUID() as PlayerId],
        toLocationId: lobbyId,
        turnId,
        traceId: 'trace-move-foreign',
      }),
    );
    expect(code).toBe('CORE_NOT_FOUND');
    const empty = await errorCodeOf(() =>
      services.locations.moveGroup({ sessionId, playerIds: [], toLocationId: lobbyId, turnId }),
    );
    expect(empty).toBe('VALIDATION');
  });

  it('перемещение в PAUSED-сессии → CORE_INVALID_STATE_TRANSITION', async () => {
    await services.sessions.pauseSession({ sessionId, idempotencyKey: testKey('pause-loc') });
    // turnId входит в детерминированный ключ (D217): берём свежий, чтобы команда
    // действительно выполнилась, а не вернулась из кэша предыдущего перемещения.
    const code = await errorCodeOf(() =>
      services.locations.moveGroup({
        sessionId,
        playerIds,
        toLocationId: lobbyId,
        turnId: randomUUID() as TurnId,
        traceId: 'trace-move-paused',
      }),
    );
    expect(code).toBe('CORE_INVALID_STATE_TRANSITION');
    await services.sessions.resumeSession({ sessionId, idempotencyKey: testKey('resume-loc') });
  });
});

describe('итог по событиям', () => {
  it('LOCATION_CHANGED ровно по числу успешных перемещений', async () => {
    const counts = await outboxCounts(db);
    // Успешные: airlock→lobby, lobby→reception = 2; отказы и replay событий не дали.
    expect(counts['LOCATION_CHANGED']).toBe(2);
    // STATE_COMMITTED: 2 перемещения + 1 служебный WORLD_PATCH (в Коридор) = 3.
    expect(counts['STATE_COMMITTED']).toBe(3);
  });

  it('pack-фикстуры не мутированы сервисом (sessionId проставлен только в БД)', () => {
    expect(fixtures.locations.every((l) => l.sessionId === null)).toBe(true);
  });
});
