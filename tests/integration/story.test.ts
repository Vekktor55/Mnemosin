import { afterAll, describe, expect, it } from 'vitest';
import { FlagKey } from '@mnemosin/contracts';

import { bootStage1World, type Stage1World } from './modules-helpers.js';

/**
 * Story (промпт 1.9, п.3/9; D120/F-8.4: запись только через StateService).
 *
 * setFlag меняет version ровно на 1 и пишет journal; повтор идентичной команды —
 * replay (детерминированный серверный ключ, D217-образец), version не растёт;
 * grantKnowledge пополняет playerKnowledge; listKnownFacts фильтрует по игроку.
 */

const worlds: Stage1World[] = [];
async function world(label: string): Promise<Stage1World> {
  const created = await bootStage1World(label);
  worlds.push(created);
  return created;
}

afterAll(async () => {
  for (const entry of worlds) await entry.close();
});

describe('story · setFlag (D120: через StateService.apply)', () => {
  it('version +1 ровно, флаг в состоянии, journal state_applied, STATE_COMMITTED в outbox', async () => {
    const w = await world('story-setflag');
    const before = await w.services.state.get(w.sessionId);

    const result = await w.story.setFlag({
      sessionId: w.sessionId,
      key: FlagKey.parse('lights_on'),
      value: true,
      setBy: 'GM',
      turnId: w.turnId,
    });
    expect(result.version).toBe(before.version + 1);
    expect(result.replayed).toBe(false);

    const after = await w.services.state.get(w.sessionId);
    expect(after.version).toBe(before.version + 1); // ровно на 1
    expect(after.storyFlags['lights_on']?.value).toBe(true);
    expect(after.storyFlags['lights_on']?.setBy).toBe('GM');
    expect(after.storyFlags['lights_on']?.setAtTurnId).toBe(w.turnId);

    const kinds = (await w.services.journal.list(w.turnId)).map((entry) => entry.kind);
    expect(kinds).toContain('state_applied');

    await w.drain();
    expect(w.captured.some((entry) => entry.type === 'STATE_COMMITTED')).toBe(true);
  });

  it('повтор идентичного setFlag → replayed, version НЕ растёт; новое значение → снова +1', async () => {
    const w = await world('story-setflag-replay');
    const input = {
      sessionId: w.sessionId,
      key: FlagKey.parse('door_open'),
      value: false,
      setBy: 'ENGINE' as const,
      turnId: w.turnId,
    };
    const first = await w.story.setFlag(input);
    const second = await w.story.setFlag(input);
    expect(second.replayed).toBe(true);
    expect(second.version).toBe(first.version);
    expect((await w.services.state.get(w.sessionId)).version).toBe(first.version);

    const third = await w.story.setFlag({ ...input, value: true });
    expect(third.replayed).toBe(false);
    expect(third.version).toBe(first.version + 1);
  });

  it('неизвестная сессия → CORE_NOT_FOUND', async () => {
    const w = await world('story-setflag-404');
    await expect(
      w.story.setFlag({
        sessionId: '99999999-9999-4999-8999-999999999999' as never,
        key: FlagKey.parse('x'),
        value: 1,
        setBy: 'GM',
      }),
    ).rejects.toMatchObject({ code: 'CORE_NOT_FOUND' });
  });
});

describe('story · grantKnowledge и listKnownFacts', () => {
  it('знание добавляется игроку, version +1; listKnownFacts фильтрует по playerId', async () => {
    const w = await world('story-knowledge');
    const before = await w.services.state.get(w.sessionId);
    const [p0, p1] = w.playerIds as [never, never];

    const granted = await w.story.grantKnowledge({
      sessionId: w.sessionId,
      playerId: p0,
      key: 'code_on_keychain',
      value: '4',
      source: 'DISCOVERED',
      turnId: w.turnId,
    });
    expect(granted.version).toBe(before.version + 1);

    await w.story.grantKnowledge({
      sessionId: w.sessionId,
      playerId: p1,
      key: 'heard_voice',
      value: true,
      source: 'OBSERVED',
    });

    const all = await w.story.listKnownFacts({ sessionId: w.sessionId });
    expect(all).toHaveLength(2);
    const onlyP0 = await w.story.listKnownFacts({ sessionId: w.sessionId, playerId: p0 });
    expect(onlyP0).toHaveLength(1);
    expect(onlyP0[0]).toMatchObject({ playerId: p0, key: 'code_on_keychain', value: '4', source: 'DISCOVERED' });
    expect(onlyP0[0]!.learnedAtTurnId).toBe(w.turnId);

    const state = await w.services.state.get(w.sessionId);
    expect(state.playerKnowledge[p0]?.entries.map((entry) => entry.key)).toEqual(['code_on_keychain']);
  });

  it('grantKnowledge чужому игроку → CORE_NOT_FOUND', async () => {
    const w = await world('story-knowledge-404');
    await expect(
      w.story.grantKnowledge({
        sessionId: w.sessionId,
        playerId: '99999999-9999-4999-8999-999999999999' as never,
        key: 'x',
        value: 1,
        source: 'GM',
      }),
    ).rejects.toMatchObject({ code: 'CORE_NOT_FOUND' });
  });
});
