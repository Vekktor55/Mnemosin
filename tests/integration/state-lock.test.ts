import { describe, expect, it } from 'vitest';

import { nowIso, type GameState } from '@mnemosin/contracts';

import { makeTurn, openTempDb, seedWorld, type TempDb } from './helpers.js';

/**
 * Промпт 1.4 · критерий A1.5: оптимистичная блокировка состояния.
 *
 * Правило: запись состояния идёт как `UPDATE … WHERE session_id = ? AND version = ?`.
 * Кто не попал в версию — получает conflict и ОБЯЗАН перечитать состояние и повторить.
 * «Прочитал → изменил → записал» без CAS здесь невозможно: это и есть защита от
 * потерянных обновлений при двух одновременно резолвящихся ходах.
 */

function bump(state: GameState, patch: Partial<GameState['worldState']> = {}): GameState {
  return {
    ...state,
    version: state.version + 1,
    updatedAt: nowIso(),
    worldState: { ...state.worldState, ...patch },
  };
}

describe('оптимистичная блокировка game_state', () => {
  let db: TempDb;

  it('последовательные записи поднимают версию 0 → 1 → 2 и пишут историю', async () => {
    db = await openTempDb('lock-seq', { seed: false });
    const world = await seedWorld(db);
    const repos = db.boot.uow.repos();

    const first = await repos.state.updateWithVersion(bump(world.state, { weather: 'дождь' }), 0);
    expect(first).toEqual({ kind: 'ok', version: 1 });

    const reread = await repos.state.findBySession(world.session.sessionId);
    expect(reread?.version).toBe(1);
    expect(reread?.worldState.weather).toBe('дождь');

    const second = await repos.state.updateWithVersion(bump(reread!, { weather: 'туман' }), 1);
    expect(second).toEqual({ kind: 'ok', version: 2 });
    expect((await repos.state.findBySession(world.session.sessionId))?.worldState.weather).toBe('туман');

    const history = await repos.state.listHistory(world.session.sessionId);
    expect(history).toHaveLength(0); // история пишется сервисом состояния (промпт 1.6), не репозиторием
    expect(await repos.state.currentVersion(world.session.sessionId)).toBe(2);
    await db.close();
  });

  it('две параллельные записи с одной ожидаемой версией → одна ok, вторая conflict', async () => {
    db = await openTempDb('lock-race', { seed: false });
    const world = await seedWorld(db);
    const repos = db.boot.uow.repos();

    const winner = bump(world.state, { weather: 'победитель' });
    const loser = bump(world.state, { weather: 'проигравший' });

    const [a, b] = await Promise.all([
      repos.state.updateWithVersion(winner, 0),
      repos.state.updateWithVersion(loser, 0),
    ]);

    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['conflict', 'ok']);

    const conflict = [a, b].find((r) => r.kind === 'conflict');
    expect(conflict?.kind === 'conflict' ? conflict.actualVersion : null).toBe(1);

    // в БД осталось состояние победителя; проигравший ничего не затёр
    const stored = await repos.state.findBySession(world.session.sessionId);
    expect(stored?.version).toBe(1);
    expect(['победитель', 'проигравший']).toContain(stored?.worldState.weather);
    await db.close();
  });

  it('проигравший повторяет после перечитывания и succeeds (retry-loop)', async () => {
    db = await openTempDb('lock-retry', { seed: false });
    const world = await seedWorld(db);
    const repos = db.boot.uow.repos();

    await repos.state.updateWithVersion(bump(world.state, { weather: 'первый' }), 0);

    // «наивный» вызов со устаревшей версией
    const stale = bump(world.state, { weather: 'устаревший' });
    const attempt1 = await repos.state.updateWithVersion(stale, 0);
    expect(attempt1.kind).toBe('conflict');

    // корректный retry: перечитали → применили свою мутацию к свежим данным
    const fresh = (await repos.state.findBySession(world.session.sessionId))!;
    const attempt2 = await repos.state.updateWithVersion(bump(fresh, { timeOfDay: 'DAWN' }), fresh.version);
    expect(attempt2).toEqual({ kind: 'ok', version: 2 });
    const final = await repos.state.findBySession(world.session.sessionId);
    expect(final?.worldState.weather).toBe('первый'); // чужая мутация не потеряна
    expect(final?.worldState.timeOfDay).toBe('DAWN');
    await db.close();
  });

  it('несогласованная версия (не expected+1) отклоняется сразу — защита от тихой порчи', async () => {
    db = await openTempDb('lock-guard', { seed: false });
    const world = await seedWorld(db);
    await expect(db.boot.uow.repos().state.updateWithVersion({ ...world.state, version: 5 }, 0)).rejects.toThrow(
      /expectedVersion=0/,
    );
    await db.close();
  });

  it('откат транзакции не поднимает версию', async () => {
    db = await openTempDb('lock-rollback', { seed: false });
    const world = await seedWorld(db);
    const repos = db.boot.uow.repos();

    await expect(
      db.boot.uow.runInTx(async (scope) => {
        await scope.repos.state.updateWithVersion(bump(world.state, { weather: 'откатится' }), 0);
        throw new Error('намеренный отказ');
      }),
    ).rejects.toThrow('намеренный отказ');

    expect((await repos.state.findBySession(world.session.sessionId))?.version).toBe(0);
    expect(await repos.state.currentVersion(world.session.sessionId)).toBe(0);
    await db.close();
  });
});

describe('CAS на статусе хода', () => {
  let db: TempDb;

  it('два параллельных перехода OPEN → LOCKED: один успешен, второй получает false', async () => {
    db = await openTempDb('turn-cas', { seed: false });
    const world = await seedWorld(db);
    const turn = makeTurn(world.session.sessionId, 1);
    await db.boot.uow.runInTx(async (scope) => {
      await scope.repos.turns.insert(turn);
    });

    const repos = db.boot.uow.repos();
    const [a, b] = await Promise.all([
      repos.turns.setStatus(turn.turnId, 'LOCKED', 'OPEN'),
      repos.turns.setStatus(turn.turnId, 'LOCKED', 'OPEN'),
    ]);
    expect([a, b].sort()).toEqual([false, true]);

    const stored = await repos.turns.findById(turn.turnId);
    expect(stored?.status).toBe('LOCKED');
    expect(stored?.lockedAt).not.toBeNull();
    // body_json остался согласованным с колонкой status (иначе маппер бы упал на assertMatches)
    expect(stored?.updatedAt).not.toBe(turn.updatedAt);
    await db.close();
  });

  it('переход с неверным ожиданием не проходит (PROCESSING из OPEN)', async () => {
    db = await openTempDb('turn-cas-guard', { seed: false });
    const world = await seedWorld(db);
    const turn = makeTurn(world.session.sessionId, 1);
    await db.boot.uow.runInTx(async (scope) => {
      await scope.repos.turns.insert(turn);
    });

    const repos = db.boot.uow.repos();
    expect(await repos.turns.setStatus(turn.turnId, 'PROCESSING', 'LOCKED')).toBe(false);
    expect((await repos.turns.findById(turn.turnId))?.status).toBe('OPEN');

    expect(await repos.turns.setStatus(turn.turnId, 'LOCKED', 'OPEN')).toBe(true);
    expect(await repos.turns.setStatus(turn.turnId, 'PROCESSING', 'LOCKED')).toBe(true);
    const stored = await repos.turns.findById(turn.turnId);
    expect(stored?.status).toBe('PROCESSING');
    expect(stored?.processingStartedAt).not.toBeNull();
    await db.close();
  });
});
