import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { WS_PRIVACY_POLICY, WSServerMessageSchema, type WSServerType } from '@mnemosin/contracts';
import { findForbiddenKey } from '@mnemosin/gateway-ws';

import { bootWsWorld, waitForTurnStatusWs, type TestWsClient, type WsWorld } from './ws-helpers.js';

/**
 * WS-гейтвей (промпт 1.11): handshake-авторизация (D123/D267), reconnect-
 * контракт (A1.9), router (дедуп по requestId F-6.7, rate limit, GM-гейт),
 * приватность доставки (A1.7/A1.8, WS_PRIVACY_POLICY + FORBIDDEN_IN_BROADCAST),
 * heartbeat, presence, лимиты соединений.
 */

const ROOT = process.cwd();
const idem = (): string => `idem-${randomUUID()}`;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function authed(world: WsWorld, token: string, label: string): Promise<TestWsClient> {
  const client = await world.connect(token, { label });
  await client.waitFor('AUTH_OK', 8000);
  return client;
}

/** Инвариант 16: каждое полученное сообщение валидно по WSServerMessageSchema (A1.3, WS-часть). */
function expectAllEnvelopesValid(client: TestWsClient): void {
  for (const message of client.messages) {
    const parsed = WSServerMessageSchema.safeParse({
      type: message.type,
      payload: message.payload,
      ts: message.ts,
      ...(message.requestId === undefined ? {} : { requestId: message.requestId }),
      ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }),
    });
    if (!parsed.success) {
      throw new Error(
        `${client.label}: невалидный server-envelope ${message.type}: ${parsed.error.message.slice(0, 300)}`,
      );
    }
  }
}

function expectNoGmOnlyLeaks(client: TestWsClient): void {
  const leaked = client.messages.filter((m) => WS_PRIVACY_POLICY[m.type as WSServerType] === 'GM_ONLY');
  expect(leaked.map((m) => m.type)).toEqual([]);
}

function expectNoForbiddenInBroadcasts(client: TestWsClient): void {
  for (const message of client.messages) {
    const policy = WS_PRIVACY_POLICY[message.type as WSServerType];
    if (policy === 'BROADCAST') {
      expect(findForbiddenKey(message.payload), `${client.label}: ${message.type} содержит приватное поле`).toBeNull();
    }
  }
}

// ============================================================ handshake/auth

describe('WS: handshake и авторизация (D123, D267, B-12)', () => {
  let world: WsWorld;
  let session: Awaited<ReturnType<WsWorld['seedSession']>>;
  const clients: TestWsClient[] = [];

  beforeAll(async () => {
    world = await bootWsWorld('auth', { limits: { wsAuthTimeoutMs: 500 } });
    session = await world.seedSession(2);
  }, 60_000);

  afterAll(async () => {
    await world.close();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.terminate();
    await sleep(60);
  });

  const track = (client: TestWsClient): TestWsClient => {
    clients.push(client);
    return client;
  };

  it('subprotocol mnemosin.v1.<jwt>: HELLO → AUTH_OK{playerId, sessionId, isGM}', async () => {
    const client = track(await world.connect(session.players[0]!.token, { label: 'p1-sub' }));
    const hello = await client.waitFor('HELLO');
    expect(hello.payload['serverVersion']).toBe('0.0.0-wstest');
    expect(hello.payload['contractsVersion']).toBeTypeOf('string');
    expect(Array.isArray(hello.payload['capabilities'])).toBe(true);
    const auth = await client.waitFor('AUTH_OK');
    expect(auth.payload).toMatchObject({
      playerId: session.players[0]!.playerId,
      sessionId: session.sessionId,
      isGM: false,
    });
    expectAllEnvelopesValid(client);
  }, 20_000);

  it('query ?token= тоже работает (совместимость, D123)', async () => {
    const client = track(await world.connect(session.players[1]!.token, { label: 'p2-query', mode: 'query' }));
    const auth = await client.waitFor('AUTH_OK');
    expect(auth.payload['playerId']).toBe(session.players[1]!.playerId);
    expect(auth.payload['isGM']).toBe(false);
  }, 20_000);

  it('GM-токен: AUTH_OK.isGM=true (F-10.6)', async () => {
    const client = track(await world.connect(session.gm.token, { label: 'gm' }));
    const auth = await client.waitFor('AUTH_OK');
    expect(auth.payload['isGM']).toBe(true);
  }, 20_000);

  it('приоритет D123: валидный subprotocol важнее мусорного ?token=', async () => {
    const client = track(
      await world.connect(session.players[0]!.token, { label: 'prio-ok', queryToken: 'garbage-token-value-000' }),
    );
    await client.waitFor('AUTH_OK');
  }, 20_000);

  it('приоритет D123 (строго): мусорный subprotocol НЕ спасает валидный ?token= → 4401', async () => {
    const url = `${world.wsUrl}?token=${encodeURIComponent(session.players[0]!.token)}`;
    const { WebSocket } = await import('ws');
    const raw = new WebSocket(url, ['mnemosin.v1.broken-jwt-token-value']);
    const close = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      raw.on('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
      raw.on('error', reject);
    });
    expect(close.code).toBe(4401);
    expect(JSON.parse(close.reason)).toMatchObject({ code: 'AUTH_INVALID' });
  }, 20_000);

  it('невалидный токен в handshake → close 4401 {code:AUTH_INVALID}', async () => {
    const client = track(await world.connect('totally-invalid-token-000000', { label: 'bad-token' }));
    const closed = await client.waitForClose(8000);
    expect(closed.code).toBe(4401);
    expect(JSON.parse(closed.reason)).toMatchObject({ code: 'AUTH_INVALID' });
  }, 20_000);

  it('истёкший токен → close 4401 {code:AUTH_EXPIRED}', async () => {
    const expired = await world.jwt.signAccessToken(
      { playerId: session.players[0]!.playerId as never, sessionId: session.sessionId as never, isGM: false },
      -60,
    );
    const client = track(await world.connect(expired, { label: 'expired' }));
    const closed = await client.waitForClose(8000);
    expect(closed.code).toBe(4401);
    expect(JSON.parse(closed.reason)).toMatchObject({ code: 'AUTH_EXPIRED' });
  }, 20_000);

  it('токена нет, AUTH не прислан → close 4408 после окна wsAuthTimeoutMs (D267)', async () => {
    const client = track(await world.connect(undefined, { label: 'no-token', mode: 'none' }));
    const closed = await client.waitForClose(8000);
    expect(closed.code).toBe(4408);
    expect(JSON.parse(closed.reason)).toMatchObject({ code: 'AUTH_TIMEOUT' });
  }, 20_000);

  it('окно AUTH: токен сообщением AUTH{token} → HELLO+AUTH_OK; мусор → 4401', async () => {
    const ok = track(await world.connect(undefined, { label: 'auth-msg-ok', mode: 'none' }));
    ok.send('AUTH', { token: session.players[1]!.token });
    await ok.waitFor('HELLO');
    const authOk = await ok.waitFor('AUTH_OK');
    expect(authOk.payload['playerId']).toBe(session.players[1]!.playerId);

    const bad = track(await world.connect(undefined, { label: 'auth-msg-bad', mode: 'none' }));
    bad.send('AUTH', { token: 'broken-token-value-0000000000' });
    const closed = await bad.waitForClose(8000);
    expect(closed.code).toBe(4401);
    expect(JSON.parse(closed.reason)).toMatchObject({ code: 'AUTH_INVALID' });
  }, 20_000);

  it('до AUTH любая команда кроме AUTH → ERROR AUTH_INVALID (без разрыва)', async () => {
    const client = track(await world.connect(undefined, { label: 'pre-auth', mode: 'none' }));
    client.send('PING', {});
    const error = await client.waitFor('ERROR');
    expect(error.payload['code']).toBe('AUTH_INVALID');
    expect(client.closedEvent).toBeNull();
  }, 20_000);

  it('лимит соединений на игрока (4): пятое → close 4429 RATE_LIMIT', async () => {
    const token = session.players[0]!.token;
    const opened: TestWsClient[] = [];
    for (let i = 0; i < 4; i += 1) {
      opened.push(track(await authed(world, token, `tab-${i}`)));
    }
    const fifth = track(await world.connect(token, { label: 'tab-4' }));
    const closed = await fifth.waitForClose(8000);
    expect(closed.code).toBe(4429);
    expect(JSON.parse(closed.reason)).toMatchObject({ code: 'RATE_LIMIT' });
    // Первые четыре живы.
    for (const client of opened) expect(client.closedEvent).toBeNull();
  }, 30_000);
}, 120_000);

// ====================================================== reconnect-контракт

describe('WS: reconnect-контракт (A1.9, п.7)', () => {
  let world: WsWorld;
  let session: Awaited<ReturnType<WsWorld['seedSession']>>;
  const clients: TestWsClient[] = [];

  beforeAll(async () => {
    world = await bootWsWorld('recon');
    session = await world.seedSession(2);
  }, 60_000);

  afterAll(async () => {
    await world.close();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.terminate();
    await sleep(60);
  });

  const track = (client: TestWsClient): TestWsClient => {
    clients.push(client);
    return client;
  };

  it('после AUTH_OK фиксированный порядок: STATE_PROJECTION → STATE_PROJECTION_PRIVATE → TURN_UPDATE → SESSION_STATUS → PLAYER_PRESENCE', async () => {
    const client = track(await world.connect(session.players[0]!.token, { label: 'seq' }));
    await client.waitFor('PLAYER_PRESENCE', 8000);
    const types = client.messages.map((m) => m.type).slice(0, 7);
    expect(types).toEqual([
      'HELLO',
      'AUTH_OK',
      'STATE_PROJECTION',
      'STATE_PROJECTION_PRIVATE',
      'TURN_UPDATE',
      'SESSION_STATUS',
      'PLAYER_PRESENCE',
    ]);
    const projection = client.messages[2]!;
    expect(projection.payload['sessionId']).toBe(session.sessionId);
    const privateView = client.messages[3]!;
    expect(privateView.payload['playerId']).toBe(session.players[0]!.playerId);
    const turnUpdate = client.messages[4]!;
    expect(turnUpdate.payload['turnId']).toBe(session.turnId);
    const status = client.messages[5]!;
    expect(status.payload).toMatchObject({ sessionId: session.sessionId, from: 'ACTIVE', to: 'ACTIVE' });
    expectAllEnvelopesValid(client);
  }, 30_000);

  it('kill сервера → реконнект: полный набор + неacked-действие переотправляется ровно один раз', async () => {
    const token = session.players[0]!.token;
    const before = track(await authed(world, token, 'recon-before'));
    const requestId = `req-${randomUUID()}`;
    const key = idem();
    before.send(
      'ACTION_SUBMIT',
      { turnId: session.turnId, rawText: 'Проверить затвор шлюза', idempotencyKey: key, requestId },
      { requestId },
    );
    const firstAck = await before.waitForRequestId('ACTION_ACK', requestId);

    // «kill -9»: рвём сокет и поднимаем новый сервер на той же БД.
    before.terminate();
    await world.restart();

    const after = track(await world.connect(token, { label: 'recon-after' }));
    await after.waitFor('PLAYER_PRESENCE', 8000);
    expect(after.messages.map((m) => m.type).slice(0, 7)).toEqual([
      'HELLO',
      'AUTH_OK',
      'STATE_PROJECTION',
      'STATE_PROJECTION_PRIVATE',
      'TURN_UPDATE',
      'SESSION_STATUS',
      'PLAYER_PRESENCE',
    ]);
    // TURN_UPDATE реконнекта содержит СВОИ действия адресата (D268) — клиент
    // сверяет optimistic-очередь (A1.9).
    const turnUpdate = after.messages[4]!;
    const myActions = turnUpdate.payload['myActions'] as Array<{ actionId: string }>;
    expect(myActions.map((a) => a.actionId)).toContain(firstAck.payload['actionId']);

    // Offline-queue клиента: то же действие (тот же requestId) без ack'а —
    // переотправляется; сервер применяет его РОВНО один раз (F-6.7/D272).
    after.send(
      'ACTION_SUBMIT',
      { turnId: session.turnId, rawText: 'Проверить затвор шлюза', idempotencyKey: key, requestId },
      { requestId },
    );
    const replayAck = await after.waitForRequestId('ACTION_ACK', requestId);
    expect(replayAck.payload['actionId']).toBe(firstAck.payload['actionId']);
    expect(replayAck.payload['sequenceId']).toBe(firstAck.payload['sequenceId']);

    // Новое действие — второй sequenceId; всего в ходе ровно 2 действия.
    const secondReq = `req-${randomUUID()}`;
    after.send(
      'ACTION_SUBMIT',
      {
        turnId: session.turnId,
        rawText: 'Осмотреть вентиляционную решётку',
        idempotencyKey: idem(),
        requestId: secondReq,
      },
      { requestId: secondReq },
    );
    await after.waitForRequestId('ACTION_ACK', secondReq);
    const view = await world.services.turns.getTurnView(session.turnId as never, null);
    expect(view.actionCount).toBe(2);
    expectAllEnvelopesValid(after);
  }, 60_000);
}, 120_000);

// ============================================================== router/ack

describe('WS: router — команды, дедуп, rate limit, ошибки', () => {
  let world: WsWorld;
  let session: Awaited<ReturnType<WsWorld['seedSession']>>;
  /** Временные клиенты тестов (afterEach закрывает); gm/alice/bob живут весь describe. */
  const temp: TestWsClient[] = [];
  let gm: TestWsClient;
  let alice: TestWsClient;
  let bob: TestWsClient;

  beforeAll(async () => {
    world = await bootWsWorld('router');
    session = await world.seedSession(3);
    gm = await authed(world, session.gm.token, 'gm');
    alice = await authed(world, session.players[0]!.token, 'alice');
    bob = await authed(world, session.players[1]!.token, 'bob');
  }, 60_000);

  afterAll(async () => {
    gm?.terminate();
    alice?.terminate();
    bob?.terminate();
    await world.close();
  });

  afterEach(async () => {
    for (const client of temp.splice(0)) client.terminate();
    await sleep(60);
  });

  const track = (client: TestWsClient): TestWsClient => {
    temp.push(client);
    return client;
  };

  it('неизвестный type и битый JSON → ERROR VALIDATION, соединение живо', async () => {
    alice.send('TOTALLY_UNKNOWN_TYPE', { foo: 1 });
    const error = await alice.waitFor((m) => m.type === 'ERROR' && m.payload['code'] === 'VALIDATION');
    expect(error.payload['requestId']).toBeNull();
    const before = alice.messages.length;
    alice.send('PING', {});
    await alice.waitFor('PONG');
    expect(alice.closedEvent).toBeNull();
    expect(alice.messages.length).toBeGreaterThan(before);
  }, 20_000);

  it('ACTION_SUBMIT без idempotencyKey → VALIDATION (B-08)', async () => {
    const requestId = `req-${randomUUID()}`;
    alice.send('ACTION_SUBMIT', { turnId: session.turnId, rawText: 'без ключа', requestId }, { requestId });
    const error = await alice.waitForRequestId('ERROR', requestId);
    expect(error.payload['code']).toBe('VALIDATION');
  }, 20_000);

  it('игрок шлёт GM_LOCK_TURN → ERROR AUTH_FORBIDDEN', async () => {
    const requestId = `req-${randomUUID()}`;
    alice.send('GM_LOCK_TURN', { turnId: session.turnId, idempotencyKey: idem(), requestId }, { requestId });
    const error = await alice.waitForRequestId('ERROR', requestId);
    expect(error.payload['code']).toBe('AUTH_FORBIDDEN');
  }, 20_000);

  it('SUBSCRIBE: своя сессия → SUBSCRIBED; чужая → AUTH_FORBIDDEN', async () => {
    const own = `req-${randomUUID()}`;
    alice.send('SUBSCRIBE', { sessionId: session.sessionId, requestId: own }, { requestId: own });
    await alice.waitForRequestId('SUBSCRIBED', own);

    const foreign = `req-${randomUUID()}`;
    alice.send('SUBSCRIBE', { sessionId: randomUUID(), requestId: foreign }, { requestId: foreign });
    const error = await alice.waitForRequestId('ERROR', foreign);
    expect(error.payload['code']).toBe('AUTH_FORBIDDEN');
  }, 20_000);

  it('дедуп по requestId (F-6.7): 3× один ACTION_SUBMIT → одно действие, идентичные ack', async () => {
    const requestId = `req-${randomUUID()}`;
    const key = idem();
    const payload = { turnId: session.turnId, rawText: 'Трогать панель рукой', idempotencyKey: key, requestId };
    alice.send('ACTION_SUBMIT', payload, { requestId });
    alice.send('ACTION_SUBMIT', payload, { requestId });
    alice.send('ACTION_SUBMIT', payload, { requestId });
    // Три ack'а (первый + два из кэша/in-flight), все идентичны.
    const deadline = Date.now() + 8000;
    while (
      alice.messages.filter((m) => m.type === 'ACTION_ACK' && m.requestId === requestId).length < 3 &&
      Date.now() < deadline
    ) {
      await sleep(25);
    }
    const acks = alice.messages.filter((m) => m.type === 'ACTION_ACK' && m.requestId === requestId);
    expect(acks.length).toBe(3);
    const payloads = acks.map((m) => JSON.stringify(m.payload));
    expect(new Set(payloads).size).toBe(1);
    const view = await world.services.turns.getTurnView(session.turnId as never, session.players[0]!.playerId as never);
    expect(view.actionCount).toBe(1);
    expect(view.myActions[0]!.rawText).toBe('Трогать панель рукой');
  }, 30_000);

  it('rate limit: 50 ACTION_SUBMIT залпом → часть RATE_LIMIT, соединение живо', async () => {
    const marker = Date.now();
    for (let i = 0; i < 50; i += 1) {
      const requestId = `req-${randomUUID()}`;
      bob.send(
        'ACTION_SUBMIT',
        { turnId: session.turnId, rawText: `залп ${i}`, idempotencyKey: idem(), requestId },
        { requestId },
      );
    }
    const deadline = Date.now() + 10_000;
    while (
      bob.messages.filter((m) => m.at >= marker && (m.type === 'ACTION_ACK' || m.type === 'ERROR')).length < 50 &&
      Date.now() < deadline
    ) {
      await sleep(25);
    }
    const responses = bob.messages.filter((m) => m.at >= marker && (m.type === 'ACTION_ACK' || m.type === 'ERROR'));
    expect(responses.length).toBe(50);
    const rateLimited = responses.filter((m) => m.type === 'ERROR' && m.payload['code'] === 'RATE_LIMIT');
    expect(rateLimited.length).toBeGreaterThanOrEqual(20);
    // Bucket ACTION_SUBMIT (5/с) не затрагивает DEFAULT: PING → PONG.
    bob.send('PING', {});
    await bob.waitFor('PONG');
    expect(bob.closedEvent).toBeNull();
  }, 30_000);

  it('CHAT_PUBLIC: CHAT_ACK отправителю, сообщение — всем (после drain)', async () => {
    const requestId = `req-${randomUUID()}`;
    const marker = `ПУБЛИЧНЫЙ-МАРКЕР-${randomUUID()}`;
    alice.send('CHAT_PUBLIC', { text: marker, requestId }, { requestId, sessionId: session.sessionId });
    const ack = await alice.waitForRequestId('CHAT_ACK', requestId);
    expect(ack.payload['messageId']).toBeTruthy();

    await world.drain();
    for (const client of [alice, bob, gm]) {
      const message = await client.waitFor((m) => m.type === 'CHAT_PUBLIC' && m.payload['text'] === marker, 8000);
      expect(message.payload['fromPlayerId']).toBe(session.players[0]!.playerId);
      expect(message.payload['visibility']).toBe('PUBLIC');
    }
  }, 30_000);

  it('CHAT_PRIVATE: TARGETED — получает ТОЛЬКО адресат; отправитель — CHAT_ACK', async () => {
    const requestId = `req-${randomUUID()}`;
    const marker = `ЛИЧНЫЙ-МАРКЕР-${randomUUID()}`;
    alice.send(
      'CHAT_PRIVATE',
      { toPlayerId: session.players[1]!.playerId, text: marker, requestId },
      { requestId, sessionId: session.sessionId },
    );
    await alice.waitForRequestId('CHAT_ACK', requestId);
    await world.drain();

    const received = await bob.waitFor((m) => m.type === 'CHAT_PRIVATE' && m.payload['text'] === marker, 8000);
    expect(received.payload['toPlayerId']).toBe(session.players[1]!.playerId);
    // Ни GM, ни кто-либо ещё личное не получают (строго TARGETED).
    expect(gm.messages.some((m) => JSON.stringify(m.payload).includes(marker))).toBe(false);
    // Отправитель своё сообщение назад не получает (только ack).
    expect(alice.messages.filter((m) => m.type === 'CHAT_PRIVATE' && m.payload['text'] === marker).length).toBe(0);
  }, 30_000);

  it('HISTORY: лента с учётом адресата (свои личные + публичные, чужие личные — нет)', async () => {
    const third = track(await authed(world, session.players[2]!.token, 'carol'));
    const secret = `ЧУЖОЙ-СЕКРЕТ-${randomUUID()}`;
    const requestId = `req-${randomUUID()}`;
    // Bob → Carol (личное, мимо Alice).
    const bobReq = `req-${randomUUID()}`;
    bob.send(
      'CHAT_PRIVATE',
      { toPlayerId: session.players[2]!.playerId, text: secret, requestId: bobReq },
      { requestId: bobReq, sessionId: session.sessionId },
    );
    await bob.waitForRequestId('CHAT_ACK', bobReq);

    third.send('HISTORY', { sessionId: session.sessionId, limit: 200, requestId }, { requestId });
    const carolHistory = await third.waitForRequestId('HISTORY_RESULT', requestId);
    const carolTexts = (carolHistory.payload['messages'] as Array<{ text: string }>).map((m) => m.text);
    expect(carolTexts).toContain(secret);

    const aliceReq = `req-${randomUUID()}`;
    alice.send('HISTORY', { sessionId: session.sessionId, limit: 200, requestId: aliceReq }, { requestId: aliceReq });
    const aliceHistory = await alice.waitForRequestId('HISTORY_RESULT', aliceReq);
    const aliceTexts = (aliceHistory.payload['messages'] as Array<{ text: string }>).map((m) => m.text);
    expect(aliceTexts).not.toContain(secret);
  }, 30_000);

  it('presence: подключение и обрыв соединения видны остальным (PLAYER_PRESENCE)', async () => {
    const marker = Date.now();
    const dave = track(await world.connect(session.players[2]!.token, { label: 'dave-presence' }));
    await dave.waitFor('AUTH_OK');
    const joined = await gm.waitFor(
      (m) => m.type === 'PLAYER_PRESENCE' && m.payload['playerId'] === session.players[2]!.playerId && m.at >= marker,
      8000,
    );
    expect(joined.payload).toMatchObject({ status: 'ACTIVE', connections: 1 });

    const beforeDrop = gm.messages.length;
    dave.terminate();
    const dropped = await gm.waitFor(
      (m) =>
        m.type === 'PLAYER_PRESENCE' &&
        m.payload['playerId'] === session.players[2]!.playerId &&
        m.payload['status'] === 'DISCONNECTED' &&
        m.at >= beforeDrop,
      8000,
    );
    expect(dropped.payload['connections']).toBe(0);
  }, 30_000);

  it('GM_SYSTEM_MESSAGE → ack + CHAT_SYSTEM всем; GM_ADD_NOTE(GM_ONLY) не утекает', async () => {
    const secretNote = `СЕКРЕТНАЯ-ЗМЕТКА-${randomUUID()}`;
    const noteReq = `req-${randomUUID()}`;
    gm.send(
      'GM_ADD_NOTE',
      { sessionId: session.sessionId, visibility: 'GM_ONLY', text: secretNote, requestId: noteReq },
      { requestId: noteReq },
    );
    const noteAck = await gm.waitForRequestId('GM_NOTE_ACK', noteReq);
    expect(noteAck.payload['noteId']).toBeTruthy();

    const marker = `СИСТЕМНОЕ-СООБЩЕНИЕ-${randomUUID()}`;
    const sysReq = `req-${randomUUID()}`;
    gm.send(
      'GM_SYSTEM_MESSAGE',
      { sessionId: session.sessionId, text: marker, requestId: sysReq },
      { requestId: sysReq },
    );
    const ack = await gm.waitForRequestId('GM_ACTION_ACK', sysReq);
    expect(ack.payload).toMatchObject({ action: 'systemMessage', ok: true });

    await world.drain();
    for (const client of [alice, bob, gm]) {
      await client.waitFor((m) => m.type === 'CHAT_SYSTEM' && m.payload['text'] === marker, 8000);
    }
    // GM_ONLY-заметка игрокам не видна ни в каком сообщении.
    for (const client of [alice, bob]) {
      expect(client.messages.some((m) => JSON.stringify(m.payload).includes(secretNote))).toBe(false);
    }
  }, 30_000);

  it('LEAVE: close 1000, PLAYER_LEFT-presence, токен отозван (B-12.3)', async () => {
    const eve = track(await authed(world, session.players[2]!.token, 'eve'));
    eve.send('LEAVE', {});
    const closed = await eve.waitForClose(8000);
    expect(closed.code).toBe(1000);
    await world.drain();
    const presence = await gm.waitFor(
      (m) =>
        m.type === 'PLAYER_PRESENCE' &&
        m.payload['playerId'] === session.players[2]!.playerId &&
        m.payload['status'] === 'LEFT',
      8000,
    );
    expect(presence.payload['connections']).toBe(0);
    // Токен отозван: реконнект → 4401.
    const retry = track(await world.connect(session.players[2]!.token, { label: 'eve-retry' }));
    const denied = await retry.waitForClose(8000);
    expect(denied.code).toBe(4401);
  }, 30_000);

  it('GM_KICK_PLAYER: ack GM, исключённый — close 4403, токен отозван (D275)', async () => {
    const frank = track(await authed(world, session.players[1]!.token, 'frank'));
    // Боб уже использован в rate-limit; кикаем players[1] через ВТОРОЕ соединение.
    const kickReq = `req-${randomUUID()}`;
    gm.send(
      'GM_KICK_PLAYER',
      { sessionId: session.sessionId, playerId: session.players[1]!.playerId, requestId: kickReq },
      { requestId: kickReq },
    );
    const ack = await gm.waitForRequestId('GM_ACTION_ACK', kickReq);
    expect(ack.payload).toMatchObject({ action: 'kick', ok: true });
    const closed = await frank.waitForClose(8000);
    expect(closed.code).toBe(4403);
    expect(bob.closedEvent?.code).toBe(4403);
    const retry = track(await world.connect(session.players[1]!.token, { label: 'bob-retry' }));
    const denied = await retry.waitForClose(8000);
    expect(denied.code).toBe(4401);
  }, 30_000);
}, 240_000);

// ================================================================== heartbeat

describe('WS: heartbeat (п.3)', () => {
  it('сервер шлёт protocol-PING; клиентский PING → PONG', async () => {
    const world = await bootWsWorld('hb', { limits: { heartbeat: { intervalMs: 80, idleTimeoutMs: 30_000 } } });
    try {
      const session = await world.seedSession(1);
      const client = await world.connect(session.players[0]!.token, { label: 'hb' });
      await client.waitFor('AUTH_OK');
      const deadline = Date.now() + 4000;
      while (client.pingCount === 0 && Date.now() < deadline) await sleep(30);
      expect(client.pingCount).toBeGreaterThan(0);
      client.send('PING', {});
      await client.waitFor('PONG');
      client.terminate();
    } finally {
      await world.close();
    }
  }, 60_000);
});

// ================================================== цикл хода и приватность

describe('WS: цикл хода и приватность (A1.7, A1.8, п.5–6)', () => {
  let world: WsWorld;
  let session: Awaited<ReturnType<WsWorld['seedSession']>>;
  let gm: TestWsClient;
  const players: TestWsClient[] = [];

  beforeAll(async () => {
    world = await bootWsWorld('cycle');
    session = await world.seedSession(3);
  }, 60_000);

  afterAll(async () => {
    for (const client of players) client.terminate();
    gm?.terminate();
    await world.close();
  });

  it('полный цикл: действия → lock → draft (GM_ONLY) → commit → broadcast + targeted private', async () => {
    gm = await authed(world, session.gm.token, 'gm-cycle');
    for (let i = 0; i < session.players.length; i += 1) {
      players.push(await authed(world, session.players[i]!.token, `player-${i}`));
    }

    // 1. Каждый игрок — по действию.
    for (let i = 0; i < players.length; i += 1) {
      const client = players[i]!;
      const requestId = `req-${randomUUID()}`;
      client.send(
        'ACTION_SUBMIT',
        { turnId: session.turnId, rawText: `Действие игрока ${i + 1}`, idempotencyKey: idem(), requestId },
        { requestId },
      );
      await client.waitForRequestId('ACTION_ACK', requestId);
    }

    // 2. GM锁 → auto-resolve (D253) → REVIEW; события — через drain.
    const lockReq = `req-${randomUUID()}`;
    gm.send(
      'GM_LOCK_TURN',
      { turnId: session.turnId, idempotencyKey: idem(), requestId: lockReq },
      { requestId: lockReq },
    );
    await gm.waitForRequestId('GM_ACTION_ACK', lockReq);
    await waitForTurnStatusWs(world, session.turnId, ['REVIEW'], 15_000);
    await world.drain();

    // 3. GM получает TURN_DRAFT_READY{summary} + TURN_RESOLUTION_GM; игроки — НЕТ (A1.8).
    const draft = await gm.waitFor('TURN_DRAFT_READY', 8000);
    const summary = draft.payload['summary'] as Record<string, unknown>;
    expect(summary['turnId']).toBe(session.turnId);
    expect(summary['providerId']).toBeTruthy();
    await gm.waitFor('TURN_RESOLUTION_GM', 8000);
    for (const client of players) {
      expect(client.messages.some((m) => m.type === 'TURN_DRAFT_READY' || m.type === 'TURN_RESOLUTION_GM')).toBe(false);
    }

    // 4. Commit → публичный TURN_COMMITTED{turnId,version,publicSegments} всем;
    //    приватное — TARGETED; полный resolution — снова GM_ONLY.
    const commitReq = `req-${randomUUID()}`;
    gm.send(
      'GM_COMMIT_TURN',
      { turnId: session.turnId, idempotencyKey: idem(), requestId: commitReq },
      { requestId: commitReq },
    );
    const commitAck = await gm.waitForRequestId('GM_ACTION_ACK', commitReq);
    expect((commitAck.payload['meta'] as Record<string, unknown>)['version']).toBeTypeOf('number');
    await world.drain();

    // Ожидаемые приватные тексты: фикстура ScriptedAI, маппинг из AI-контекста.
    const fixture = JSON.parse(readFileSync(resolvePath(ROOT, 'tools/fixtures/resolution.ok.json'), 'utf8')) as {
      privateMessages: Array<{ text: string }>;
    };
    const context = await world.gm.inspectAIContext({ turnId: session.turnId as never });
    const names = context.characterNames;
    const expectedPrivate = new Map<string, string[]>();
    fixture.privateMessages.forEach((message, index) => {
      const target = names[index % names.length];
      if (target === undefined) return;
      const list = expectedPrivate.get(target.playerId) ?? [];
      list.push(message.text);
      expectedPrivate.set(target.playerId, list);
    });

    for (let i = 0; i < players.length; i += 1) {
      const client = players[i]!;
      const playerId = session.players[i]!.playerId;

      const committed = await client.waitFor('TURN_COMMITTED', 8000);
      expect(committed.payload['turnId']).toBe(session.turnId);
      expect(committed.payload['version']).toBeTypeOf('number');
      const segments = committed.payload['publicSegments'] as Array<{ segmentId: string; text: string }>;
      expect(segments.length).toBeGreaterThan(0);
      // Публичный сегмент = нарратив фикстуры (с подставленным actionCount).
      expect(segments[0]!.text).toContain('шлюз');
      expect(segments[0]!.text).not.toContain('{actionCount}');

      // STATE_PROJECTION (BROADCAST) обновлён.
      await client.waitFor('STATE_PROJECTION', 8000);

      // Нарратив в системной ленте чата (D238).
      await client.waitFor((m) => m.type === 'CHAT_SYSTEM' && (m.payload['text'] as string).includes('шлюз'), 8000);

      // Приватная часть хода — только адресату (TARGETED).
      const expected = expectedPrivate.get(playerId) ?? [];
      const privates = client.messages.filter((m) => m.type === 'TURN_PRIVATE_RESOLUTION');
      if (expected.length > 0) {
        expect(privates.length).toBe(1);
        expect(privates[0]!.payload['turnId']).toBe(session.turnId);
        expect(privates[0]!.payload['text']).toBe(expected.join('\n\n').slice(0, 1500));
      } else {
        expect(privates.length).toBe(0);
      }

      // A1.7/A1.8: приватное не ушло другим игрокам.
      for (let j = 0; j < players.length; j += 1) {
        if (j === i) continue;
        const other = players[j]!;
        for (const text of expected) {
          expect(
            other.messages.some(
              (m) => m.type !== 'TURN_PRIVATE_RESOLUTION' && JSON.stringify(m.payload).includes(text.slice(0, 40)),
            ),
            `игрок ${j} увидел чужое приватное`,
          ).toBe(false);
        }
      }

      expectNoGmOnlyLeaks(client);
      expectNoForbiddenInBroadcasts(client);
      expectAllEnvelopesValid(client);
    }

    // GM: полный resolution закоммиченного хода (GM_ONLY).
    const gmResolutions = gm.messages.filter((m) => m.type === 'TURN_RESOLUTION_GM');
    expect(gmResolutions.length).toBeGreaterThanOrEqual(2); // draft + commit
    expectNoForbiddenInBroadcasts(gm);
    expectAllEnvelopesValid(gm);
  }, 120_000);
}, 240_000);
