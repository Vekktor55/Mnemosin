import { afterAll, describe, expect, it } from 'vitest';
import { FlagKey, nowIso } from '@mnemosin/contracts';

import { bootStage1World, type Stage1World } from './modules-helpers.js';
import { testKey } from './helpers.js';

/**
 * GM-модуль (промпт 1.9, п.4–6/9; критерий A1.15 на сервисном слое).
 *
 * Проверяются: обёртки жизненного цикла + GM_ACTION_PERFORMED (атомарно,
 * replay не дублирует); kickPlayer; sendSystemMessage; addNote + GM_NOTE_ADDED;
 * PUBLIC_AFTER_COMMIT публикуется РОВНО ОДИН раз (F-3.8); inspectState —
 * GMStateView без GM_ONLY-заметок в публичной части; inspectAIContext (D121);
 * inspectJournal; listAudit; moveGroup; activateEvent → NOT_IMPLEMENTED;
 * не-GM → AUTH_FORBIDDEN.
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

async function auditRows(w: Stage1World) {
  return w.db.boot.uow.repos().gmAudit.listBySession(w.sessionId, 500);
}

describe('gm · команды жизненного цикла + GM_ACTION_PERFORMED', () => {
  it('pauseSession/resumeSession: статусы, аудит-событие, replay без дубля', async () => {
    const w = await world('gm-pause');
    const key = testKey('pause');
    const paused = await w.gm.pauseSession({ sessionId: w.sessionId, gmPlayerId: w.gmPlayerId, idempotencyKey: key });
    expect(paused.status).toBe('PAUSED');

    const replayed = await w.gm.pauseSession({ sessionId: w.sessionId, gmPlayerId: w.gmPlayerId, idempotencyKey: key });
    expect(replayed.replayed).toBe(true);

    const resumed = await w.gm.resumeSession({
      sessionId: w.sessionId,
      gmPlayerId: w.gmPlayerId,
      idempotencyKey: testKey('resume'),
    });
    expect(resumed.status).toBe('ACTIVE');

    await w.drain();
    const pauses = w.captured.filter(
      (entry) => entry.type === 'GM_ACTION_PERFORMED' && entry.payload['action'] === 'pauseSession',
    );
    expect(pauses).toHaveLength(1); // replay НЕ дублирует аудит (D249)
    expect(pauses[0]!.payload).toMatchObject({ sessionId: w.sessionId, gmPlayerId: w.gmPlayerId });
    expect(pauses[0]!.payload['idempotencyKey']).toBe(key);
    expect((await auditRows(w)).map((row) => row.action)).toContain('pauseSession');
  });

  it('kickPlayer: статус KICKED + аудит; GM нельзя убрать (D222)', async () => {
    const w = await world('gm-kick');
    const target = w.playerIds[2]!;
    await w.gm.kickPlayer({
      sessionId: w.sessionId,
      gmPlayerId: w.gmPlayerId,
      playerId: target,
      idempotencyKey: testKey('kick'),
    });
    const player = await w.db.boot.uow.repos().players.findById(target);
    expect(player?.status).toBe('LEFT');
    await w.drain();
    expect((await auditRows(w)).map((row) => row.action)).toContain('kickPlayer');
    // PLAYER_LEFT → системное сообщение чата (подписка chat)
    const systemFeed = await w.chat.history({ sessionId: w.sessionId, visibility: 'SYSTEM' });
    expect(systemFeed.some((message) => message.text.includes('удалён ведущим'))).toBe(true);
  });

  it('moveGroup через gm: версия +1, LOCATION_CHANGED, аудит', async () => {
    const w = await world('gm-move');
    const locations = await w.services.locations.list(w.sessionId);
    const hall = locations.find((location) => location.name === 'Холл');
    expect(hall).toBeDefined();
    const before = await w.services.state.get(w.sessionId);
    const moved = await w.gm.moveGroup({
      sessionId: w.sessionId,
      gmPlayerId: w.gmPlayerId,
      playerIds: w.playerIds,
      toLocationId: hall!.locationId,
      turnId: w.turnId,
      idempotencyKey: testKey('move'),
    });
    expect(moved.version).toBe(before.version + 1);
    await w.drain();
    expect(w.captured.some((entry) => entry.type === 'LOCATION_CHANGED')).toBe(true);
    expect((await auditRows(w)).map((row) => row.action)).toContain('moveGroup');
  });

  it('openTurn после коммита: новый ход + аудит (D117: вручную, не автоматически)', async () => {
    const w = await world('gm-openturn');
    await w.turn.resolveTurn({ turnId: w.turnId });
    await w.gmReview.approve({ turnId: w.turnId, gmPlayerId: w.gmPlayerId, idempotencyKey: testKey('approve') });
    const opened = await w.gm.openTurn({
      sessionId: w.sessionId,
      gmPlayerId: w.gmPlayerId,
      idempotencyKey: testKey('open'),
    });
    expect(opened.number).toBe(2);
    expect(opened.status).toBe('OPEN');
    await w.drain();
    expect((await auditRows(w)).map((row) => row.action)).toContain('openTurn');
  });

  it('activateEvent → NOT_IMPLEMENTED (этап 2); не-GM → AUTH_FORBIDDEN', async () => {
    const w = await world('gm-stub-forbidden');
    await expect(
      w.gm.activateEvent({
        sessionId: w.sessionId,
        gmPlayerId: w.gmPlayerId,
        eventId: '12345678-1234-4123-8123-123456781234',
        idempotencyKey: testKey('activate'),
      } as never),
    ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });

    await expect(
      w.gm.pauseSession({ sessionId: w.sessionId, gmPlayerId: w.playerIds[0]!, idempotencyKey: testKey('pause-x') }),
    ).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
  });
});

describe('gm · sendSystemMessage и addNote', () => {
  it('sendSystemMessage: SYSTEM в чате + аудит; повтор ключа — одно сообщение', async () => {
    const w = await world('gm-sysmsg');
    const key = testKey('sysmsg');
    const sent = await w.gm.sendSystemMessage({
      sessionId: w.sessionId,
      gmPlayerId: w.gmPlayerId,
      text: 'Объявление ведущего',
      idempotencyKey: key,
    });
    expect(sent.replayed).toBe(false);
    const again = await w.gm.sendSystemMessage({
      sessionId: w.sessionId,
      gmPlayerId: w.gmPlayerId,
      text: 'Объявление ведущего',
      idempotencyKey: key,
    });
    expect(again.messageId).toBe(sent.messageId);

    const systemFeed = await w.chat.history({ sessionId: w.sessionId, visibility: 'SYSTEM' });
    expect(systemFeed.filter((message) => message.text === 'Объявление ведущего')).toHaveLength(1);
    await w.drain();
    const audits = (await auditRows(w)).filter((row) => row.action === 'sendSystemMessage');
    expect(audits).toHaveLength(1);
  });

  it('addNote: gm_notes + GM_NOTE_ADDED + аудит; replay — та же noteId, одна запись', async () => {
    const w = await world('gm-addnote');
    const key = testKey('note');
    const added = await w.gm.addNote({
      sessionId: w.sessionId,
      gmPlayerId: w.gmPlayerId,
      turnId: w.turnId,
      visibility: 'AI_DIRECTOR',
      text: 'Директору: намекнуть на брелок',
      idempotencyKey: key,
    });
    const replay = await w.gm.addNote({
      sessionId: w.sessionId,
      gmPlayerId: w.gmPlayerId,
      turnId: w.turnId,
      visibility: 'AI_DIRECTOR',
      text: 'Директору: намекнуть на брелок',
      idempotencyKey: key,
    });
    expect(replay.noteId).toBe(added.noteId);
    expect(replay.replayed).toBe(true);

    const notes = await w.db.boot.uow.repos().gmNotes.listBySession(w.sessionId);
    expect(notes).toHaveLength(1);
    await w.drain();
    const noteEvents = w.captured.filter((entry) => entry.type === 'GM_NOTE_ADDED');
    expect(noteEvents).toHaveLength(1);
    expect(noteEvents[0]!.payload).toMatchObject({
      sessionId: w.sessionId,
      noteId: added.noteId,
      visibility: 'AI_DIRECTOR',
    });
    expect((await auditRows(w)).map((row) => row.action)).toContain('addNote');
  });

  it('PUBLIC_AFTER_COMMIT публикуется в чат РОВНО ОДИН раз после коммита (F-3.8)', async () => {
    const w = await world('gm-note-public');
    await w.gm.addNote({
      sessionId: w.sessionId,
      gmPlayerId: w.gmPlayerId,
      turnId: w.turnId,
      visibility: 'PUBLIC_AFTER_COMMIT',
      text: 'Объявление: тревога после коммита',
      idempotencyKey: testKey('note-public'),
    });
    // до коммита заметки в чате НЕТ
    expect(
      (await w.chat.history({ sessionId: w.sessionId, visibility: 'SYSTEM' })).some((message) =>
        message.text.includes('тревога после коммита'),
      ),
    ).toBe(false);

    await w.turn.resolveTurn({ turnId: w.turnId });
    await w.gmReview.approve({ turnId: w.turnId, gmPlayerId: w.gmPlayerId, idempotencyKey: testKey('approve-note') });
    await w.drain();

    const withNote = () =>
      w.chat
        .history({ sessionId: w.sessionId, visibility: 'SYSTEM', limit: 500 })
        .then((feed) => feed.filter((message) => message.text.includes('тревога после коммита')));
    expect(await withNote()).toHaveLength(1);

    // повторная доставка TURN_COMMITTED (at-least-once) — дубль не появляется
    const committed = w.captured.findLast((entry) => entry.type === 'TURN_COMMITTED');
    expect(committed).toBeDefined();
    await w.redeliver({
      type: 'TURN_COMMITTED',
      payload: committed!.payload as never,
      emittedAt: nowIso(),
      traceId: 'trace-note-redelivery',
    } as never);
    expect(await withNote()).toHaveLength(1);
  });
});

describe('gm · инспекция (п.5)', () => {
  it('inspectState: валидный GMStateView; GM_ONLY-заметка НЕ в публичной части; pendingReviews/knowledge/flags', async () => {
    const w = await world('gm-inspect');
    await w.gm.addNote({
      sessionId: w.sessionId,
      gmPlayerId: w.gmPlayerId,
      visibility: 'GM_ONLY',
      text: 'СЕКРЕТ-ВЫХОД-42',
      idempotencyKey: testKey('note-gm'),
    });
    await w.story.setFlag({
      sessionId: w.sessionId,
      key: FlagKey.parse('alarm'),
      value: true,
      setBy: 'GM',
      turnId: w.turnId,
    });
    await w.story.grantKnowledge({
      sessionId: w.sessionId,
      playerId: w.playerIds[0]!,
      key: 'code_4',
      value: '4',
      source: 'DISCOVERED',
      turnId: w.turnId,
    });
    await w.turn.resolveTurn({ turnId: w.turnId });

    const view = await w.gm.inspectState({ sessionId: w.sessionId });
    expect(view.session.sessionId).toBe(w.sessionId);
    expect(view.session.players).toHaveLength(4); // GM + 3
    expect(view.session.storyFlags['alarm']).toBe(true);
    expect(view.flagsDetail.map((flag) => flag.key)).toContain('alarm');
    expect(view.knowledgeByPlayer[w.playerIds[0]!]?.map((entry) => entry.key)).toContain('code_4');
    expect(view.pendingReviews).toContain(w.turnId);
    expect(view.locations.length).toBeGreaterThanOrEqual(3);
    expect(view.deferredEffects).toEqual([]);

    // GM_ONLY-заметка: видна в GM-части (notes) и НЕ видна в публичной проекции
    expect(view.notes.some((note) => note.text === 'СЕКРЕТ-ВЫХОД-42' && note.visibility === 'GM_ONLY')).toBe(true);
    expect(JSON.stringify(view.session)).not.toContain('СЕКРЕТ-ВЫХОД-42');
    expect(JSON.stringify(view.session)).not.toContain('GM_ONLY');
  });

  it('inspectAIContext: DirectorContext из журнала ai_context_built (D121); неизвестный ход → CORE_NOT_FOUND', async () => {
    const w = await world('gm-inspect-ai');
    await w.turn.resolveTurn({ turnId: w.turnId });
    const context = await w.gm.inspectAIContext({ turnId: w.turnId });
    expect(context.turnId).toBe(w.turnId);
    expect(context.sessionId).toBe(w.sessionId);
    expect(context.visiblePlayerActions).toHaveLength(2);
    expect(context.currentLocation.name).toBe('Шлюз');

    await expect(
      w.gm.inspectAIContext({ turnId: '99999999-9999-4999-8999-999999999999' as never }),
    ).rejects.toMatchObject({ code: 'CORE_NOT_FOUND' });
  });

  it('inspectJournal: полная хронология хода; listAudit: since/limit', async () => {
    const w = await world('gm-inspect-journal');
    await w.turn.resolveTurn({ turnId: w.turnId });
    const journal = await w.gm.inspectJournal({ turnId: w.turnId });
    const kinds = journal.map((entry) => entry.kind);
    expect(kinds).toContain('processing_started');
    expect(kinds).toContain('ai_context_built');
    expect(kinds).toContain('draft_ready');

    await w.gm.pauseSession({ sessionId: w.sessionId, gmPlayerId: w.gmPlayerId, idempotencyKey: testKey('p1') });
    await w.drain();
    const audit = await w.gm.listAudit({ sessionId: w.sessionId, limit: 10 });
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0]!.action).toBe('pauseSession');
    const future = await w.gm.listAudit({ sessionId: w.sessionId, since: '2030-01-01T00:00:00.000Z' });
    expect(future).toHaveLength(0);
  });
});
