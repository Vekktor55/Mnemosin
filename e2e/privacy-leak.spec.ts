import { test, expect, type Page } from '@playwright/test';

import {
  createSession,
  joinSession,
  pickPort,
  startServer,
  startSessionTurn,
  submitActionHttp,
  lockTurn,
  waitTurnStatus,
  commitTurn,
  gmAddNoteHttp,
  type TestServer,
} from './helpers.js';

/**
 * A1.7 (промпт 1.13, п.2): сниффер WS-трафика — перехват ВСЕХ сообщений сервера
 * во время сценария (page.on('websocket') → framereceived) и утверждения матрицы
 * приватности (патч аудита §8.4, FORBIDDEN_IN_BROADCAST):
 *  - в BROADCAST-сообщениях нет privateMessages / gmSecret / чужого knowledge /
 *    заметок GM / diagnostics / proposedEvents;
 *  - TURN_RESOLUTION_GM и TURN_DRAFT_READY приходят ТОЛЬКО GM;
 *  - текст приватного чата не приходит никому, кроме адресата;
 *  - STATE_PROJECTION_PRIVATE содержит knowledge только своего игрока;
 *  - текст GM-заметки GM_ONLY не приходит игрокам.
 */

const PORT = pickPort();
const DB = `e2e-privacy-${Date.now()}-${PORT}.sqlite`;
const PRIVATE_TEXT = 'только тебе: у ключницы есть вторая тетрадь';
const GM_NOTE_TEXT = 'gm-only заметка: подозреваемый — регистратор';

interface Sniffed {
  readonly label: string;
  readonly frames: Array<{ type: string; raw: string }>;
}

let server: TestServer;
let sessionId: string;
let gmToken: string;
let turnId: string;
let tokens: { a: string; b: string };

test.beforeAll(async () => {
  server = await startServer(PORT, DB);
  const session = await createSession(server.base);
  sessionId = session.sessionId;
  gmToken = session.token;
  const a = await joinSession(server.base, sessionId, 'Ирма');
  const b = await joinSession(server.base, sessionId, 'Каймен');
  tokens = { a: a.token, b: b.token };
  const started = await startSessionTurn(server.base, sessionId, gmToken);
  turnId = started.turnId;
});

test.afterAll(async () => {
  await server.stop();
});

/** Подключить сниффер WS к странице: все входящие кадры сервера. */
function attachSniffer(page: Page, label: string, sink: Sniffed[]): void {
  const entry: Sniffed = { label, frames: [] };
  sink.push(entry);
  page.on('websocket', (ws) => {
    ws.on('framereceived', (event) => {
      const raw = String(event.payload);
      try {
        const parsed = JSON.parse(raw) as { type?: string };
        entry.frames.push({ type: String(parsed.type ?? ''), raw });
      } catch {
        entry.frames.push({ type: '<non-json>', raw });
      }
    });
  });
}

test('сниффер WS: приватное не уходит не адресатам (матрица §8.4)', async ({ browser }) => {
  test.setTimeout(240_000);
  const sink: Sniffed[] = [];

  // Три слушателя: GM + два игрока (логины через UI, сниффер — до goto).
  const gmPage = await (await browser.newContext()).newPage();
  attachSniffer(gmPage, 'gm', sink);
  await gmPage.goto(`http://127.0.0.1:${PORT}/gm/`);
  await gmPage.getByTestId('mode-token').click();
  await gmPage.getByTestId('gm-token').fill(gmToken);
  await gmPage.getByTestId('gm-token-submit').click();
  await expect(gmPage.getByTestId('connection-bar')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 30_000 });

  const pageA = await (await browser.newContext()).newPage();
  attachSniffer(pageA, 'playerA', sink);
  await pageA.goto(`http://127.0.0.1:${PORT}/player/?session=${sessionId}`);
  await pageA.getByTestId('login-display-name').fill('Ирма');
  await pageA.getByTestId('login-submit').click();
  await expect(pageA.getByTestId('connection-bar')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 30_000 });

  const pageB = await (await browser.newContext()).newPage();
  attachSniffer(pageB, 'playerB', sink);
  await pageB.goto(`http://127.0.0.1:${PORT}/player/?session=${sessionId}`);
  await pageB.getByTestId('login-display-name').fill('Каймен');
  await pageB.getByTestId('login-submit').click();
  await expect(pageB.getByTestId('connection-bar')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 30_000 });

  // Действия игрока A + приватное сообщение A → B через UI.
  await submitActionHttp(server.base, turnId, tokens.a, 'Осматриваю регистратуру');
  await pageA.getByTestId('private-target').selectOption({ label: 'Каймен' });
  await pageA.getByTestId('private-chat-input').fill(PRIVATE_TEXT);
  await pageA.getByTestId('private-chat-send').click();
  // В UI тред приватных сообщений открывается выбором собеседника
  // (по умолчанию в select первый игрок списка, а не отправитель).
  await pageB.getByTestId('private-target').selectOption({ label: 'Ирма' });
  await expect(pageB.getByTestId('private-chat')).toContainText(PRIVATE_TEXT, { timeout: 20_000 });

  // GM-заметка GM_ONLY (HTTP) — не должна доехать до игроков никак.
  await gmAddNoteHttp(server.base, sessionId, gmToken, 'GM_ONLY', GM_NOTE_TEXT);

  // Ход: lock → REVIEW (черновик только GM) → commit (нарратив всем).
  await lockTurn(server.base, turnId, gmToken);
  await waitTurnStatus(server.base, turnId, gmToken, ['REVIEW']);
  await commitTurn(server.base, turnId, gmToken);
  await expect(pageA.getByTestId('system-feed')).toContainText('Лампа над внутренней дверью мигнула', {
    timeout: 30_000,
  });

  // Даём кадрам дойти до всех снифферов.
  await pageA.waitForTimeout(2000);

  const gm = sink.find((item) => item.label === 'gm');
  const playerA = sink.find((item) => item.label === 'playerA');
  const playerB = sink.find((item) => item.label === 'playerB');
  expect(gm).toBeDefined();
  expect(playerA).toBeDefined();
  expect(playerB).toBeDefined();
  if (gm === undefined || playerA === undefined || playerB === undefined) return;

  // 1) GM_ONLY-типы приходят ТОЛЬКО GM.
  for (const player of [playerA, playerB]) {
    expect(player.frames.filter((f) => f.type === 'TURN_RESOLUTION_GM')).toHaveLength(0);
    expect(player.frames.filter((f) => f.type === 'TURN_DRAFT_READY')).toHaveLength(0);
    expect(player.frames.filter((f) => f.type === 'CHAT_GM')).toHaveLength(0);
    expect(player.frames.filter((f) => f.type === 'GM_STATE')).toHaveLength(0);
  }
  expect(gm.frames.some((f) => f.type === 'TURN_RESOLUTION_GM')).toBe(true);
  expect(gm.frames.some((f) => f.type === 'TURN_DRAFT_READY')).toBe(true);

  // 2) BROADCAST-кадры не содержат запрещённые поля (FORBIDDEN_IN_BROADCAST).
  const BROADCAST_TYPES = new Set([
    'STATE_PROJECTION',
    'TURN_UPDATE',
    'TURN_COMMITTED',
    'CHAT_PUBLIC',
    'CHAT_SYSTEM',
    'SESSION_STATUS',
    'PLAYER_PRESENCE',
    'TURN_FAILED',
    'CAPABILITY_CHANGED',
  ]);
  const forbidden = [
    'privateMessages',
    'gmSecret',
    'knowledge',
    'notes',
    'diagnostics',
    'proposedEvents',
    'proposedObjectChanges',
  ];
  for (const listener of [gm, playerA, playerB]) {
    for (const frame of listener.frames) {
      if (!BROADCAST_TYPES.has(frame.type)) continue;
      for (const word of forbidden) {
        expect(frame.raw, `${listener.label}:${frame.type} содержит ${word}`).not.toContain(word);
      }
    }
  }

  // 3) Приватный чат: текст только у адресата (B получает CHAT_PRIVATE; A — лишь
  //    локальную копию и CHAT_ACK без текста… payload CHAT_ACK = messageId).
  expect(playerB.frames.some((f) => f.type === 'CHAT_PRIVATE' && f.raw.includes(PRIVATE_TEXT))).toBe(true);
  expect(playerA.frames.filter((f) => f.raw.includes(PRIVATE_TEXT) && f.type !== 'CHAT_ACK')).toHaveLength(0);
  expect(gm.frames.filter((f) => f.raw.includes(PRIVATE_TEXT))).toHaveLength(0);

  // 4) STATE_PROJECTION_PRIVATE — knowledge только своего игрока.
  for (const listener of [playerA, playerB]) {
    const privateProjections = listener.frames.filter((f) => f.type === 'STATE_PROJECTION_PRIVATE');
    expect(privateProjections.length).toBeGreaterThanOrEqual(1);
    for (const frame of privateProjections) {
      const parsed = JSON.parse(frame.raw) as { payload: { playerId: string } };
      // Кадр пришёл этому слушателю → playerId в payload = его собственный.
      const myId = await listenerMyId(listener === playerA ? pageA : pageB);
      expect(parsed.payload.playerId).toBe(myId);
    }
  }

  // 5) Текст GM-заметки GM_ONLY не приходил игрокам ни в каком кадре.
  for (const listener of [playerA, playerB]) {
    expect(listener.frames.filter((f) => f.raw.includes(GM_NOTE_TEXT))).toHaveLength(0);
  }
});

async function listenerMyId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const raw = sessionStorage.getItem('mnemosin:identity');
    if (raw === null) throw new Error('identity отсутствует');
    const parsed = JSON.parse(raw) as { playerId: string | null };
    if (parsed.playerId === null) throw new Error('playerId ещё не известен');
    return parsed.playerId;
  });
}
