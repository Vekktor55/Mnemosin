import { afterAll, describe, expect, it } from 'vitest';
import { AppError, TurnResolutionSchema, nowIso, type TurnResolution } from '@mnemosin/contracts';
import { plusMs } from '@mnemosin/contracts';

import { bootStage1World, type Stage1World } from './modules-helpers.js';
import { testKey } from './helpers.js';

/**
 * Chat (промпт 1.9, п.2/9; критерий A1.10 на сервисном слое).
 *
 * Проверяются: видимости (публичное видят все, приватное — только адресат
 * и отправитель, GM-сообщение не уходит игрокам, SYSTEM — всем); sanitize
 * (trim, \r\n, лимит maxMessageLen, управляющие символы); rate limit
 * (token bucket → RATE_LIMIT); history-фильтры; доставка черновика по
 * TURN_COMMITTED (D238) — идемпотентно; системные сообщения ленты.
 */

const worlds: Stage1World[] = [];
async function world(label: string, options: Parameters<typeof bootStage1World>[1] = {}): Promise<Stage1World> {
  const created = await bootStage1World(label, options);
  worlds.push(created);
  return created;
}

afterAll(async () => {
  for (const entry of worlds) await entry.close();
});

async function visibleTo(w: Stage1World, playerId: (typeof w.playerIds)[number]) {
  return w.db.boot.uow.repos().chat.listForPlayer(w.sessionId, playerId, 500);
}

describe('chat · видимости (A1.10)', () => {
  it('публичное видят все; приватное — только адресат и отправитель; GM — только GM; SYSTEM — всем', async () => {
    const w = await world('chat-visibility');
    const [p0, p1, p2] = w.playerIds as [never, never, never];

    await w.chat.sendPublicMessage({ sessionId: w.sessionId, playerId: p0, text: 'Всем привет' });
    await w.chat.sendPrivateMessage({ sessionId: w.sessionId, fromPlayerId: p0, toPlayerId: p1, text: 'Только тебе' });
    await w.chat.sendGMMessage({ sessionId: w.sessionId, gmPlayerId: w.gmPlayerId, text: 'Заметка ведущего' });
    await w.chat.sendSystemMessage({ sessionId: w.sessionId, text: 'Системное объявление' });

    for (const player of [p0, p1, p2]) {
      const feed = await visibleTo(w, player);
      const texts = feed.map((message) => message.text);
      expect(texts).toContain('Всем привет');
      expect(texts).toContain('Системное объявление');
      expect(texts).not.toContain('Заметка ведущего'); // GM-канал игрокам недоступен
      if (player === p1)
        expect(texts).toContain('Только тебе'); // адресат
      else if (player === p0)
        expect(texts).toContain('Только тебе'); // отправитель
      else expect(texts).not.toContain('Только тебе'); // третий игрок — нет
    }

    const gmFeed = await visibleTo(w, w.gmPlayerId);
    const gmTexts = gmFeed.map((message) => message.text);
    expect(gmTexts).toContain('Заметка ведущего');
    expect(gmTexts).toContain('Всем привет');
    expect(gmTexts).not.toContain('Только тебе'); // чужая приватка GM не видна

    // события — по одному на сообщение, payload'ы по контракту (без текста, B-10)
    const kinds = w.captured.map((entry) => entry.type);
    // captureBus: события ещё в outbox (publisher не запускался) — публикуем
    await w.drain();
    const published = w.captured.map((entry) => entry.type);
    expect(published).toContain('CHAT_MESSAGE_PUBLIC');
    expect(published).toContain('CHAT_MESSAGE_PRIVATE');
    expect(published).toContain('CHAT_MESSAGE_SYSTEM');
    expect(published).toContain('CHAT_MESSAGE_GM');
    expect(kinds.filter((kind) => kind === 'CHAT_MESSAGE_PUBLIC')).toHaveLength(0); // до drain в шине нет
    const publicEvent = w.captured.find((entry) => entry.type === 'CHAT_MESSAGE_PUBLIC');
    expect(Object.keys(publicEvent!.payload).sort()).toEqual(['fromPlayerId', 'messageId', 'sessionId', 'turnId']);
  });

  it('history: PUBLIC — вся лента; PRIVATE требует playerId и даёт только свою; GM — только GM; since фильтрует', async () => {
    const w = await world('chat-history');
    const [p0, p1] = w.playerIds as [never, never];
    await w.chat.sendPublicMessage({ sessionId: w.sessionId, playerId: p0, text: 'публичное-1' });
    const since = plusMs(nowIso(), -1000);
    await w.chat.sendPrivateMessage({ sessionId: w.sessionId, fromPlayerId: p0, toPlayerId: p1, text: 'приватное-1' });
    await w.chat.sendGMMessage({ sessionId: w.sessionId, gmPlayerId: w.gmPlayerId, text: 'gm-1' });
    await w.chat.sendSystemMessage({ sessionId: w.sessionId, text: 'системное-1' });

    const publicFeed = await w.chat.history({ sessionId: w.sessionId, visibility: 'PUBLIC' });
    expect(publicFeed.map((message) => message.text)).toEqual(['публичное-1']);

    const privateOfP1 = await w.chat.history({ sessionId: w.sessionId, visibility: 'PRIVATE', playerId: p1 });
    expect(privateOfP1.map((message) => message.text)).toEqual(['приватное-1']);
    const privateOfP0 = await w.chat.history({ sessionId: w.sessionId, visibility: 'PRIVATE', playerId: p0 });
    expect(privateOfP0.map((message) => message.text)).toEqual(['приватное-1']); // отправитель видит своё

    const gmFeed = await w.chat.history({ sessionId: w.sessionId, visibility: 'GM' });
    expect(gmFeed.map((message) => message.text)).toEqual(['gm-1']);

    // PRIVATE без playerId → VALIDATION
    await expect(w.chat.history({ sessionId: w.sessionId, visibility: 'PRIVATE' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });

    const sinceFeed = await w.chat.history({ sessionId: w.sessionId, since });
    expect(sinceFeed.length).toBeGreaterThanOrEqual(3); // сообщения, созданные после since

    const playerFeed = await w.chat.history({ sessionId: w.sessionId, playerId: p1 });
    const texts = playerFeed.map((message) => message.text);
    expect(texts).toContain('публичное-1');
    expect(texts).toContain('приватное-1');
    expect(texts).not.toContain('gm-1');
  });
});

describe('chat · sanitize и лимиты (промпт 1.9, п.2/9)', () => {
  it('trim и нормализация \\r\\n; управляющие символы и пустота → VALIDATION', async () => {
    const w = await world('chat-sanitize');
    const p0 = w.playerIds[0]!;
    const sent = await w.chat.sendPublicMessage({
      sessionId: w.sessionId,
      playerId: p0,
      text: '  строка\r\nвторая\r\n  ',
    });
    const stored = await w.db.boot.uow.repos().chat.findById(sent.messageId);
    expect(stored?.text).toBe('строка\nвторая');

    await expect(
      w.chat.sendPublicMessage({ sessionId: w.sessionId, playerId: p0, text: '   \n  ' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      w.chat.sendPublicMessage({ sessionId: w.sessionId, playerId: p0, text: 'зло\u0000й\u001b[текст' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('длиннее maxMessageLen (limits.yaml=1000) → VALIDATION', async () => {
    const w = await world('chat-limit');
    const p0 = w.playerIds[0]!;
    const long = 'а'.repeat(w.config.limits.maxMessageLen + 1);
    await expect(w.chat.sendPublicMessage({ sessionId: w.sessionId, playerId: p0, text: long })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    const exact = 'б'.repeat(w.config.limits.maxMessageLen);
    await expect(
      w.chat.sendPublicMessage({ sessionId: w.sessionId, playerId: p0, text: exact }),
    ).resolves.toBeDefined();
  });

  it('rate limit: больше chat.publicPerSecond за секунду → RATE_LIMIT', async () => {
    const w = await world('chat-rate');
    const p0 = w.playerIds[0]!;
    const capacity = w.config.limits.chat.publicPerSecond * w.config.limits.chat.burstSeconds;
    for (let i = 0; i < capacity; i++) {
      await w.chat.sendPublicMessage({ sessionId: w.sessionId, playerId: p0, text: `сообщение ${i}` });
    }
    const error = await w.chat
      .sendPublicMessage({ sessionId: w.sessionId, playerId: p0, text: 'перебор' })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('RATE_LIMIT');

    // другой игрок не затронут (ведро на игрока)
    const p1 = w.playerIds[1]!;
    await expect(
      w.chat.sendPublicMessage({ sessionId: w.sessionId, playerId: p1, text: 'я в порядке' }),
    ).resolves.toBeDefined();
  });

  it('чужой/посторонний playerId → CORE_NOT_FOUND; не-GM в GM-канал → AUTH_FORBIDDEN', async () => {
    const w = await world('chat-access');
    await expect(
      w.chat.sendPublicMessage({ sessionId: w.sessionId, playerId: w.gmPlayerId, text: 'норм' }),
    ).resolves.toBeDefined();
    await expect(
      w.chat.sendGMMessage({ sessionId: w.sessionId, gmPlayerId: w.playerIds[0]!, text: 'я не GM' }),
    ).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
  });
});

describe('chat · TURN_COMMITTED: доставка черновика (D238) идемпотентна', () => {
  it('сегменты ALL→SYSTEM, PLAYER→PRIVATE от GM, privateMessages→PRIVATE; повторная доставка без дублей', async () => {
    const w = await world('chat-commit-delivery');
    // Черновик готовим вручную (без AI): LOCKED → PROCESSING → сохранение → REVIEW.
    await w.services.turns.transition({ turnId: w.turnId, trigger: 'startProcessing' });
    const state = await w.services.state.get(w.sessionId);
    const resolution: TurnResolution = TurnResolutionSchema.parse({
      turnId: w.turnId,
      sessionId: w.sessionId,
      source: 'GM_MANUAL',
      aiResponseHash: null,
      baseVersion: state.version,
      resolutionHash: null,
      segments: [
        {
          segmentId: '11111111-1111-4111-8111-111111111111',
          text: 'Публичный нарратив хода',
          audience: { kind: 'ALL' },
          status: 'PROPOSED',
          editedByGM: false,
        },
        {
          segmentId: '22222222-2222-4222-8222-222222222222',
          text: 'Сегмент для ведущего',
          audience: { kind: 'GM' },
          status: 'PROPOSED',
          editedByGM: false,
        },
        {
          segmentId: '33333333-3333-4333-8333-333333333333',
          text: 'Личный сегмент игрока',
          audience: { kind: 'PLAYER', playerId: w.playerIds[0] },
          status: 'PROPOSED',
          editedByGM: false,
        },
      ],
      privateMessages: [{ playerId: w.playerIds[1], text: 'Приватное знание', status: 'PROPOSED', editedByGM: false }],
      proposedEvents: [],
      proposedObjectChanges: [],
      proposedWorldStatePatch: {},
      visualScene: null,
      diagnostics: { providerId: 'gm', model: null, attempts: 0, usage: null, costUsd: null, durationMs: null },
      createdAt: '2026-10-14T00:00:00.000Z',
      editedAt: null,
    });
    const turn = await w.services.turns.getTurn(w.turnId);
    await w.db.boot.uow.repos().turns.update({ ...turn, resolution });
    await w.services.turns.transition({ turnId: w.turnId, trigger: 'draftReady' });

    // approve: PROPOSED→APPROVED → commit → APPLIED; TURN_COMMITTED в outbox
    const commit = await w.gmReview.approve({
      turnId: w.turnId,
      gmPlayerId: w.gmPlayerId,
      idempotencyKey: testKey('approve-chat'),
    });
    expect(commit.version).toBe(state.version + 1);
    await w.drain(); // outbox → bus → chat.onTurnCommitted

    const systemFeed = await w.chat.history({ sessionId: w.sessionId, visibility: 'SYSTEM' });
    expect(systemFeed.some((message) => message.text === 'Публичный нарратив хода')).toBe(true);

    const gmFeed = await w.chat.history({ sessionId: w.sessionId, visibility: 'GM' });
    expect(gmFeed.some((message) => message.text === 'Сегмент для ведущего')).toBe(true);

    const p0Private = await w.chat.history({
      sessionId: w.sessionId,
      visibility: 'PRIVATE',
      playerId: w.playerIds[0]!,
    });
    expect(p0Private.some((message) => message.text === 'Личный сегмент игрока')).toBe(true);
    expect(p0Private.every((message) => message.fromPlayerId === w.gmPlayerId)).toBe(true); // от GM/Директора

    const p1Private = await w.chat.history({
      sessionId: w.sessionId,
      visibility: 'PRIVATE',
      playerId: w.playerIds[1]!,
    });
    expect(p1Private.some((message) => message.text === 'Приватное знание')).toBe(true);
    // третий игрок не видит чужой приватки
    const p2Feed = await visibleTo(w, w.playerIds[2]!);
    expect(p2Feed.map((message) => message.text)).not.toContain('Приватное знание');
    expect(p2Feed.map((message) => message.text)).not.toContain('Личный сегмент игрока');

    // Повторная доставка того же TURN_COMMITTED (at-least-once) — без дублей
    const countsBefore = (await w.chat.history({ sessionId: w.sessionId, limit: 500 })).length;
    await w.redeliver({
      type: 'TURN_COMMITTED',
      payload: { sessionId: w.sessionId, turnId: w.turnId, version: commit.version },
      emittedAt: nowIso(),
      traceId: 'trace-redelivery',
    });
    const countsAfter = (await w.chat.history({ sessionId: w.sessionId, limit: 500 })).length;
    expect(countsAfter).toBe(countsBefore);
  });
});

describe('chat · системные сообщения ленты (PLAYER_JOINED / SESSION_STATUS_CHANGED)', () => {
  it('PLAYER_JOINED → SYSTEM-сообщение; повторная доставка — без дубля', async () => {
    const w = await world('chat-lifecycle');
    const before = (await w.chat.history({ sessionId: w.sessionId, visibility: 'SYSTEM' })).length;
    const event = {
      type: 'PLAYER_JOINED',
      payload: {
        sessionId: w.sessionId,
        playerId: '99999999-9999-4999-8999-999999999999',
        displayName: 'Новичок',
        characterName: 'Новичок',
      },
      emittedAt: '2026-10-14T10:00:00.000Z',
      traceId: 'trace-join-fixed',
    } as const;
    await w.redeliver(event as never);
    const after = await w.chat.history({ sessionId: w.sessionId, visibility: 'SYSTEM' });
    expect(after.length).toBe(before + 1);
    expect(after[0]!.text).toContain('Новичок');

    await w.redeliver(event as never); // та же доставка повторно
    expect((await w.chat.history({ sessionId: w.sessionId, visibility: 'SYSTEM' })).length).toBe(before + 1);
  });
});
