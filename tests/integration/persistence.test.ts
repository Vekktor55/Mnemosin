import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { sql } from 'drizzle-orm';

import { nowIso, type TurnId } from '@mnemosin/contracts';
import { openDatabase, runMigrations } from '@mnemosin/database';

import {
  fixtures,
  makeAction,
  makeChat,
  makeNote,
  makeSnapshot,
  makeTurn,
  openTempDb,
  seedWorld,
  type TempDb,
} from './helpers.js';

/**
 * Промпт 1.4 · критерии A1.4 и A1.11 (часть «схема и сохранность»).
 *
 * Здесь проверяется то, что нельзя проверить юнит-тестами: реальная SQLite-БД на диске,
 * миграции, FK-ограничения, lossless round-trip доменных объектов через body_json,
 * атомарность «журнал + outbox + состояние» в одной транзакции и каскадное удаление.
 */

describe('миграции и схема', () => {
  let db: TempDb;

  it('применяются и идемпотентны (повторный вызов ничего не меняет)', async () => {
    const handle = await openDatabase({ url: `file:/tmp/mnemosin-mig-${randomUUID()}.sqlite` });
    const first = await runMigrations(handle.db);
    expect(first.changed).toBe(true);
    expect(first.version.applied).toBe(1);
    expect(first.version.lastTag).toBe('0000_init');

    const second = await runMigrations(handle.db);
    expect(second.changed).toBe(false);
    expect(second.version.applied).toBe(1);

    const tables = await handle.db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '__drizzle%' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
    expect(tables).toHaveLength(17);
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'sessions',
        'players',
        'characters',
        'turns',
        'actions',
        'game_state',
        'idempotency_records',
        'event_outbox',
        'journal_entries',
        'snapshots',
        'locations',
      ]),
    );

    const indexes = await handle.db.all<{ c: number }>(
      sql`SELECT count(*) AS c FROM sqlite_master WHERE type='index' AND (name LIKE 'idx_%' OR name LIKE 'uq_%')`,
    );
    expect(Number(indexes[0]?.c)).toBeGreaterThanOrEqual(20);
    await handle.close();
  });

  it('PRAGMA применяются: WAL, foreign_keys=ON, busy_timeout, synchronous=NORMAL', async () => {
    db = await openTempDb('pragma');
    expect(db.boot.handle.pragmas['journal_mode']).toBe('wal');
    expect(db.boot.handle.pragmas['foreign_keys']).toBe(1);
    expect(db.boot.handle.pragmas['busy_timeout']).toBe(5000);
    expect(db.boot.handle.pragmas['synchronous']).toBe(1); // NORMAL
    await db.close();
  });

  it('FK действительно работают: действие с несуществующим turnId отклоняется', async () => {
    db = await openTempDb('fk', { seed: false });
    const world = await seedWorld(db);
    const action = makeAction(randomUUID() as TurnId, world.players[1]!.playerId, 1);

    // drizzle оборачивает ошибку драйвера в «Failed query: …», причина лежит в cause —
    // поэтому проверяем весь текст ошибки целиком, а не только верхний message.
    let caught: unknown = null;
    try {
      await db.boot.uow.runInTx(async (scope) => {
        await scope.repos.actions.insert(action);
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    const text = `${String((caught as Error).message)} ${String((caught as { cause?: unknown }).cause ?? '')}`;
    expect(text).toMatch(/FOREIGN KEY constraint failed/i);

    // и сирота не осталась в таблице
    const count = await db.boot.uow.repos().actions.countByTurn(action.turnId);
    expect(count).toBe(0);
    await db.close();
  });

  it('каскадное удаление: удаление сессии убирает игроков, ходы и состояние', async () => {
    db = await openTempDb('cascade', { seed: false });
    const world = await seedWorld(db);
    const turn = makeTurn(world.session.sessionId, 1);
    await db.boot.uow.runInTx(async (scope) => {
      await scope.repos.turns.insert(turn);
      await scope.repos.actions.insert(makeAction(turn.turnId, world.players[1]!.playerId, 1));
    });

    await db.boot.handle.db.run(sql`DELETE FROM sessions WHERE session_id = ${world.session.sessionId}`);

    const repos = db.boot.uow.repos();
    expect(await repos.sessions.findById(world.session.sessionId)).toBeNull();
    expect(await repos.players.listBySession(world.session.sessionId)).toHaveLength(0);
    expect(await repos.turns.findLatestBySession(world.session.sessionId)).toBeNull();
    expect(await repos.state.findBySession(world.session.sessionId)).toBeNull();
    await db.close();
  });
});

describe('round-trip доменных объектов через БД', () => {
  let db: TempDb;

  it('сессия, игроки, персонажи, состояние, ход, действие, чат, заметка, снапшот, локация', async () => {
    db = await openTempDb('roundtrip', { seed: false });
    const at = nowIso();
    const world = await seedWorld(db, at);
    const repos = db.boot.uow.repos();

    const session = await repos.sessions.findById(world.session.sessionId);
    expect(session).toEqual(world.session);

    const players = await repos.players.listBySession(world.session.sessionId);
    expect(players).toHaveLength(7);
    expect(players.find((p) => p.playerId === world.gm.playerId)).toEqual(world.gm);

    const characters = await repos.characters.listBySession(world.session.sessionId);
    expect(characters).toHaveLength(7);
    expect(characters.find((c) => c.characterId === world.gmCharacter.characterId)).toEqual(world.gmCharacter);
    expect(await repos.characters.findByPlayer(world.gm.playerId)).toEqual(world.gmCharacter);

    const state = await repos.state.findBySession(world.session.sessionId);
    expect(state).toEqual(world.state);
    expect(state?.objectStates).toBeDefined();
    expect(Object.keys(state?.objectStates ?? {})).toHaveLength(Object.keys(world.state.objectStates).length);

    const turn = makeTurn(world.session.sessionId, 1, at);
    const action = makeAction(turn.turnId, world.players[1]!.playerId, 1, at);
    const chat = makeChat(world.session.sessionId, world.players[1]!.playerId, at);
    const note = makeNote(world.session.sessionId, at);
    const snapshot = makeSnapshot(world.session.sessionId, world.state, 0, at);

    await db.boot.uow.runInTx(async (scope) => {
      await scope.repos.turns.insert(turn);
      await scope.repos.actions.insert(action);
      await scope.repos.chat.insert(chat);
      await scope.repos.gmNotes.insert(note);
      await scope.repos.snapshots.insert(snapshot);
    });

    expect(await repos.turns.findById(turn.turnId)).toEqual(turn);
    expect(await repos.turns.findLatestBySession(world.session.sessionId)).toEqual(turn);
    expect(await repos.actions.listByTurn(turn.turnId)).toEqual([action]);
    expect(await repos.actions.findByIdempotencyKey(action.idempotencyKey)).toEqual(action);
    expect(await repos.actions.nextSequenceId(turn.turnId)).toBe(2);
    expect(await repos.chat.findById(chat.messageId)).toEqual(chat);
    expect(await repos.gmNotes.findById(note.noteId)).toEqual(note);

    const restoredSnapshot = await repos.snapshots.findById(snapshot.id);
    expect(restoredSnapshot?.state).toEqual(snapshot.state);
    expect(restoredSnapshot?.label).toBe(snapshot.label);

    for (const location of fixtures.locations) {
      expect(await repos.locations.findById(location.locationId)).toEqual(location);
    }
    expect(await repos.locations.count()).toBe(fixtures.locations.length);

    // GM-аудит: auditId присваивает БД, тело записи остаётся валидным по контракту
    const audit = await repos.gmAudit.append({
      sessionId: world.session.sessionId,
      gmPlayerId: world.gm.playerId,
      action: 'startSession',
      meta: { note: 'тест' },
      traceId: 'trace-roundtrip',
      idempotencyKey: null,
      at,
    });
    expect(audit.auditId).toBeGreaterThan(0);
    expect((await repos.gmAudit.listBySession(world.session.sessionId))[0]).toEqual(audit);

    await db.close();
  });

  it('журнал и outbox пишутся в ту же транзакцию, что и изменение состояния', async () => {
    db = await openTempDb('outbox', { seed: false });
    const world = await seedWorld(db);
    const turn = makeTurn(world.session.sessionId, 1);
    await db.boot.uow.runInTx(async (scope) => {
      await scope.repos.turns.insert(turn);
    });

    // успешная транзакция: состояние + журнал + outbox видны вместе
    const nextState = { ...world.state, version: 1, updatedAt: nowIso() };
    await db.boot.uow.runInTx(async (scope) => {
      const write = await scope.repos.state.updateWithVersion(nextState, 0);
      expect(write.kind).toBe('ok');
      await scope.repos.journal.append({
        turnId: turn.turnId,
        sessionId: world.session.sessionId,
        traceId: 'trace-commit',
        kind: 'state_applied',
        payload: { fromVersion: 0, toVersion: 1 },
        createdAt: nowIso(),
      });
      await scope.repos.outbox.append({
        eventName: 'state.changed',
        payloadJson: JSON.stringify({ sessionId: world.session.sessionId, version: 1 }),
        traceId: 'trace-commit',
        emittedAt: nowIso(),
      });
    });

    const repos = db.boot.uow.repos();
    expect((await repos.state.findBySession(world.session.sessionId))?.version).toBe(1);
    expect(await repos.journal.lastId(world.session.sessionId)).toBe(1);
    expect(await repos.outbox.countByStatus('PENDING')).toBe(1);
    const journal = await repos.journal.listByTurn(turn.turnId);
    expect(journal[0]?.kind).toBe('state_applied');
    expect(journal[0]?.payload).toEqual({ fromVersion: 0, toVersion: 1 });
    const pending = await repos.outbox.listPending();
    expect(pending[0]?.eventName).toBe('state.changed');
    expect(JSON.parse(pending[0]!.payloadJson)).toEqual({ sessionId: world.session.sessionId, version: 1 });

    // откат: ни состояние, ни журнал, ни outbox не изменились
    await expect(
      db.boot.uow.runInTx(async (scope) => {
        await scope.repos.state.updateWithVersion({ ...nextState, version: 2, updatedAt: nowIso() }, 1);
        await scope.repos.journal.append({
          turnId: turn.turnId,
          sessionId: world.session.sessionId,
          traceId: 'trace-rollback',
          kind: 'failed',
          payload: { reason: 'тест отката' },
          createdAt: nowIso(),
        });
        await scope.repos.outbox.append({
          eventName: 'state.changed',
          payloadJson: '{}',
          traceId: 'trace-rollback',
          emittedAt: nowIso(),
        });
        throw new Error('намеренный отказ внутри транзакции');
      }),
    ).rejects.toThrow('намеренный отказ');

    expect((await repos.state.findBySession(world.session.sessionId))?.version).toBe(1);
    expect(await repos.journal.lastId(world.session.sessionId)).toBe(1);
    expect(await repos.outbox.countByStatus('PENDING')).toBe(1);
    await db.close();
  });
});

describe('посев dev-сессии (bootstrap)', () => {
  it('создаёт сессию, 7 игроков, 3 локации и стартовое состояние; повторный bootstrap не дублирует', async () => {
    const db = await openTempDb('seed');
    expect(db.boot.seed.created).toBe(true);
    expect(db.boot.seed.locations).toBe(3);
    expect(db.boot.seed.players).toBe(7);

    const repos = db.boot.uow.repos();
    const active = await repos.sessions.findActive();
    expect(active).not.toBeNull();
    expect(active?.playerIds).toHaveLength(7);
    const state = await repos.state.findBySession(active!.sessionId);
    expect(state?.version).toBe(0);
    expect(state?.worldState.currentLocationId).toBe(fixtures.startLocationId);

    // второй bootstrap на той же БД: посев пропускается (D108 — одна активная сессия)
    const { bootstrapDatabase } = await import('@mnemosin/database');
    const second = await bootstrapDatabase({ url: db.url });
    expect(second.seed.created).toBe(false);
    expect(second.seed.sessionId).toBe(active!.sessionId);
    expect(await second.uow.repos().sessions.listAll()).toHaveLength(1);
    await second.close();
    await db.close();
  });
});
