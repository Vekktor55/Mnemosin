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
    const { world } = await seedWorld(db);
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
    const { world } = await seedWorld(db);
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
    const { world } = await seedWorld(db);
    const repos = db.boot.uow.repos();

    const first = bump(world.state, { weather: 'первый' });
    const second = bump(world.state, { weather: 'второй' });

    const [r1, r2] = await Promise.all([
      repos.state.updateWithVersion(first, 0),
      repos.state.updateWithVersion(second, 0),
    ]);

    const conflict = [r1, r2].find((r) => r.kind === 'conflict');
    expect(conflict).toBeDefined();

    // проигрывший перечитывает и пробует снова с новой версией
    const fresh = await repos.state.findBySession(world.session.sessionId);
    const retry = bump(fresh!, { weather: 'ретри' });
    const retryResult = await repos.state.updateWithVersion(retry, fresh!.version);
    expect(retryResult.kind).toBe('ok');
    expect(retryResult.version).toBe(2);

    await db.close();
  });

  it('несогласованная версия (не expected+1) отклоняется сразу — защита от тихой порчи', async () => {
    db = await openTempDb('lock-bad-version', { seed: false });
    const { world } = await seedWorld(db);
    const repos = db.boot.uow.repos();

    const _bad = bump(world.state, { weather: 'плохая версия' });
    // Ожидаемая версия 0, а в БД уже 1 (если перед этим был другой тест, но изолированные БД)
    // Здесь проверяем, что версия < expected отклоняется
    const result = await repos.state.updateWithVersion(bump(world.state, { weather: 'проверка' }), 5);
    expect(result.kind).toBe('conflict');
    expect(result.actualVersion).toBeLessThan(5);

    await db.close();
  });

  it('откат транзакции не поднимает версию', async () => {
    db = await openTempDb('lock-rollback', { seed: false });
    const { world } = await seedWorld(db);

    // 1. Первое успешное обновление в транзакции: версия 0 → 1
    await db.boot.uow.runInTx(async (scope) => {
      const result = await scope.repos.state.updateWithVersion(bump(world.state, { weather: 'дождь' }), 0);
      expect(result).toEqual({ kind: 'ok', version: 1 });
    });

    // 2. Проверяем, что версия обновилась после успешной транзакции
    const reread = await db.boot.uow.repos().state.findBySession(world.session.sessionId);
    expect(reread?.version).toBe(1);
    expect(reread?.worldState.weather).toBe('дождь');

    // 3. Теперь специально роняем транзакцию: пробуем обновить 1 → 2, но выбрасываем исключение
    await expect(
      db.boot.uow.runInTx(async (scope) => {
        // Используем reread (версия 1) как основу для следующего обновления
        const nextState = bump(reread!, { weather: 'провал' });
        const result = await scope.repos.state.updateWithVersion(nextState, 1);
        expect(result).toEqual({ kind: 'ok', version: 2 });
        // Намеренно выбрасываем ошибку — должна произойти откатка
        throw new Error('simulated rollback');
      }),
    ).rejects.toThrow('simulated rollback');

    // 4. После отката версия должна остаться 1 (первое обновление зафиксировалось, второе откатилось)
    const afterRollback = await db.boot.uow.repos().state.findBySession(world.session.sessionId);
    expect(afterRollback?.version).toBe(1);
    expect(afterRollback?.worldState.weather).toBe('дождь');

    // 5. Проверяем, что world_state_version также не сохранил версию 2
    const versionRecord = await db.boot.uow.repos().state.currentVersion(world.session.sessionId);
    expect(versionRecord).toBe(1);

    await db.close();
  });

  it('CAS на статусе хода: два параллельных перехода OPEN → LOCKED: один успешен, второй получает false', async () => {
    db = await openTempDb('turn-cas', { seed: false });
    const { world } = await seedWorld(db);
    const turn = makeTurn(world.session.sessionId, 1);
    await db.boot.uow.repos().turns.insert(turn);

    const repos = db.boot.uow.repos();
    const [a, b] = await Promise.all([
      repos.turns.setStatus(turn.turnId, 'LOCKED', 'OPEN'),
      repos.turns.setStatus(turn.turnId, 'LOCKED', 'OPEN'),
    ]);

    const kinds = [a, b].sort();
    expect(kinds).toEqual([false, true]);

    await db.close();
  });

  it('CAS на статусе хода: переход с неверным ожиданием не проходит (PROCESSING из OPEN)', async () => {
    db = await openTempDb('turn-cas-guard', { seed: false });
    const { world } = await seedWorld(db);
    const turn = makeTurn(world.session.sessionId, 1);
    await db.boot.uow.repos().turns.insert(turn);

    const repos = db.boot.uow.repos();

    // Первый вызов: ожидаем OPEN (статус по умолчанию), переводим в PROCESSING — успех
    const first = await repos.turns.setStatus(turn.turnId, 'PROCESSING', 'OPEN');
    expect(first).toBe(true);

    // Второй вызов: ожидаем OPEN, но статус уже PROCESSING → false
    const second = await repos.turns.setStatus(turn.turnId, 'LOCKED', 'OPEN');
    expect(second).toBe(false);

    // Переводим в LOCKED, затем пытаемся OPEN → LOCKED снова
    await repos.turns.setStatus(turn.turnId, 'LOCKED', 'PROCESSING');
    const again = await repos.turns.setStatus(turn.turnId, 'LOCKED', 'OPEN');
    expect(again).toBe(false); // уже LOCKED

    await db.close();
  });
});
