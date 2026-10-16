import { test, expect, type Page } from '@playwright/test';

import { commitTurnWithKey, createSession, pickPort, startServer, type TestServer } from './helpers.js';

/**
 * A1.16 — сквозной Playwright-сценарий «Стол» (промпт 1.13, п.1):
 * 7 браузерных контекстов (6 игроков + GM).
 *
 * GM создаёт сессию → 6 игроков join (разные displayName) → TURN_OPENED виден
 * всем → каждый отправляет действие (sequenceId 1..6) → GM lock → PROCESSING →
 * REVIEW (scripted AI) → TURN_DRAFT_READY только у GM → GM редактирует сегмент
 * и отклоняет одно изменение объекта → Edit&Approve → TURN_COMMITTED: все видят
 * публичный нарратив, адресат видит приватное сообщение, отклонённый item не
 * применён → GM moveGroup в Холл → проекция обновилась у всех → GM openTurn →
 * ход №2 OPEN. (D287: «Corridor» из ROADMAP отсутствует в world-pack этапа 1 —
 * три локации: Шлюз/Холл/Регистратура; сценарий идёт в Холл, семантика та же.)
 *
 * Дополнительно в этом же тесте: реконнект одного игрока в середине хода
 * (reload вкладки — reconnect-контракт A1.9); повторный commit с тем же
 * idempotencyKey через HTTP → тот же version (A1.4); игрок на GM-маршруте →
 * 403 (A1.7/B-11).
 */

const PORT = pickPort();
const DB = `e2e-table-${Date.now()}-${PORT}.sqlite`;
const PLAYER_NAMES = ['Ирма', 'Каймен', 'Вектор', 'Сумрак', 'Пыльца', 'Грот'] as const;
/** Текст приватного сообщения фикстуры resolution.ok.json (индекс 0). */
const PRIVATE_FIXTURE_TEXT = 'Ты замечаешь, что цифры на брелке выцарапаны не случайно';
/** Ключ патча фикстуры, который GM отклоняет (не должен примениться). */
const REJECTED_PATCH_KEY = 'cycleLight';
/** Правка сегмента, которую вносит GM. */
const GM_EDIT = 'ПРАВКА ВЕДУЩЕГО ПОСЛЕДСТВИЙ';

let server: TestServer;
let sessionId: string;
let gmToken: string;
let turn1Id: string;

test.beforeAll(async () => {
  server = await startServer(PORT, DB);
  const session = await createSession(server.base, 'Мастер Стола');
  sessionId = session.sessionId;
  gmToken = session.token;
});

test.afterAll(async () => {
  await server.stop();
});

async function loginPlayer(page: Page, name: string): Promise<void> {
  await page.goto(`http://127.0.0.1:${PORT}/player/?session=${sessionId}`);
  await page.getByTestId('login-display-name').fill(name);
  await page.getByTestId('login-character-name').fill(`${name} Персонаж`);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('connection-bar')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 30_000 });
}

/** turnId из карточки хода GM (моно-шрифт: uuid). */
async function readTurnId(gmPage: Page): Promise<string> {
  const text = (await gmPage.getByTestId('gm-turn-card').textContent()) ?? '';
  const match = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(text);
  if (match === null) throw new Error(`turnId не найден в карточке: ${text}`);
  return match[0];
}

async function gmJson<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${server.base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${gmToken}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} → ${response.status}`);
  return (await response.json()) as T;
}

test('Стол: 6 игроков + GM, полный цикл хода (A1.16)', async ({ browser }) => {
  test.setTimeout(300_000);

  // ---------------------------------------------------------- GM создаёт сессию
  const gmPage = await (await browser.newContext()).newPage();
  await gmPage.goto(`http://127.0.0.1:${PORT}/gm/`);
  // Сессия создана в beforeAll (D108: одна активная сессия) — вход по токену.
  await gmPage.getByTestId('mode-token').click();
  await gmPage.getByTestId('gm-token').fill(gmToken);
  await gmPage.getByTestId('gm-token-submit').click();
  await expect(gmPage.getByTestId('connection-bar')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 30_000 });
  await expect(gmPage.getByTestId('session-id')).toHaveValue(sessionId);

  // ---------------------------------------------------- 6 игроков join (LOBBY)
  const players: Page[] = [];
  for (const name of PLAYER_NAMES) {
    const page = await (await browser.newContext()).newPage();
    await loginPlayer(page, name);
    players.push(page);
  }

  // --------------- старт сессии: POST /sessions/:id/start ОТКРЫВАЕТ ход №1 —
  // --------------- TURN_OPENED приходит всем подписчикам (BROADCAST).
  await gmPage.getByTestId('gm-start-session').click();
  await expect(gmPage.getByTestId('session-card')).toContainText('ACTIVE', { timeout: 20_000 });
  for (const page of players) {
    await expect(page.getByTestId('turn-status')).toContainText('Ход #1', { timeout: 20_000 });
  }
  await gmPage.getByTestId('tab-turn').click();
  turn1Id = await readTurnId(gmPage);

  // ------------------------- каждый отправляет действие; sequenceId 1..6 все
  for (let i = 0; i < players.length; i += 1) {
    const page = players[i];
    if (page === undefined) continue;
    await page.getByTestId('action-input').fill(`Действие игрока ${PLAYER_NAMES[i]}: осматриваюсь`);
    await page.getByTestId('action-submit').click();
  }
  const sequences: number[] = [];
  for (const page of players) {
    const row = page.getByTestId('my-actions').locator('.my-action[data-action-status="ACKED"]').first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    const text = (await row.locator('.seq').textContent()) ?? '';
    sequences.push(Number(text.replace('#', '')));
  }
  expect([...sequences].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);

  // --------------------------------- реконнект одного игрока в середине хода
  const p3 = players[2];
  if (p3 !== undefined) {
    await p3.reload();
    await expect(p3.getByTestId('connection-bar')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 30_000 });
    await expect(p3.getByTestId('turn-status')).toContainText('Ход #1', { timeout: 15_000 });
    await expect(p3.getByTestId('my-actions').locator('.my-action[data-action-status="ACKED"]')).toBeVisible({
      timeout: 15_000,
    });
  }

  // ------------------------------- GM lock → PROCESSING → REVIEW (scripted AI)
  await gmPage.getByTestId('gm-lock-turn').click();
  await expect(gmPage.getByTestId('gm-turn-card')).toContainText('REVIEW', { timeout: 60_000 });

  // ----------------------------- TURN_DRAFT_READY только у GM: игроки не видят
  await gmPage.getByTestId('tab-review').click();
  await expect(gmPage.getByTestId('diagnostics')).toBeVisible({ timeout: 30_000 });
  for (const page of players) {
    await expect(page.getByTestId('system-feed')).not.toContainText('Черновик хода готов');
  }

  // --------------- GM редактирует сегмент и отклоняет одно изменение объекта
  await gmPage.getByTestId('segment-text-0').fill(`Лампа мигнула. ${GM_EDIT}`);
  await gmPage.getByTestId('object-change-0').locator('.status-toggle label', { hasText: 'REJECTED' }).click();
  await gmPage.getByTestId('gm-edit-approve').click();
  await expect(gmPage.getByTestId('op-status-editAndApprove')).toContainText('OK', { timeout: 60_000 });

  // ------------- TURN_COMMITTED: все видят публичный нарратив (с правкой GM)
  for (const page of [...players, gmPage]) {
    await expect(page.getByTestId('system-feed')).toContainText(GM_EDIT, { timeout: 30_000 });
  }

  // ------------- адресат видит приватное сообщение; остальные — нет (A1.7/A1.10)
  const receiverSet = new Set<Page>();
  for (const page of players) {
    const has = (await page.getByTestId('system-feed').locator('.feed-entry.private').count()) > 0;
    if (has) receiverSet.add(page);
  }
  expect(receiverSet.size).toBeGreaterThanOrEqual(1);
  for (const page of players) {
    if (!receiverSet.has(page)) {
      await expect(page.getByTestId('system-feed')).not.toContainText(PRIVATE_FIXTURE_TEXT);
    }
    // приватный текст не попал в публичный чат ни к кому
    await expect(page.getByTestId('public-chat')).not.toContainText(PRIVATE_FIXTURE_TEXT);
  }

  // ------------- отклонённое изменение объекта НЕ применено (журнал хода, A1.8)
  const journal = await gmJson<Array<{ kind: string; payload: Record<string, unknown> }>>('/gm/inspect/journal', {
    turnId: turn1Id,
  });
  const applied = journal.filter((entry) => entry.kind === 'state_applied' || entry.kind === 'effects_applied');
  expect(applied.length).toBeGreaterThanOrEqual(1);
  for (const entry of applied) {
    expect(JSON.stringify(entry.payload)).not.toContain(REJECTED_PATCH_KEY);
  }

  // -------------------------------------- игрок на GM-маршруте → 403 (A1.7/B-11)
  const p1 = players[0];
  if (p1 !== undefined) {
    const playerToken = await p1.evaluate(() => {
      const raw = sessionStorage.getItem('mnemosin:identity');
      if (raw === null) throw new Error('identity отсутствует');
      return (JSON.parse(raw) as { token: string }).token;
    });
    const asPlayer = await fetch(`${server.base}/gm/inspect/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${playerToken}` },
      body: JSON.stringify({ sessionId }),
    });
    expect(asPlayer.status).toBe(403);
  }

  // ---------------- GM moveGroup в Холл → проекция обновилась у всех (A1.15)
  await gmPage.getByTestId('tab-state').click();
  await gmPage.getByTestId('state-refresh').click();
  for (const name of PLAYER_NAMES) {
    await gmPage.getByTestId(`move-player-${name}`).check();
  }
  await gmPage.getByTestId('move-target').selectOption({ label: 'Холл' });
  await expect(gmPage.getByTestId('move-check')).not.toContainText('заблокирован');
  await gmPage.getByTestId('move-submit').click();
  for (const page of players) {
    await expect(page.getByTestId('location-name')).toContainText('Холл', { timeout: 30_000 });
  }

  // --------------------------------------------------- GM openTurn → ход №2 OPEN
  await gmPage.getByTestId('tab-turn').click();
  await gmPage.getByTestId('gm-open-turn').click();
  for (const page of players) {
    await expect(page.getByTestId('turn-status')).toContainText('Ход #2', { timeout: 20_000 });
  }
  const turn2Id = await readTurnId(gmPage);
  expect(turn2Id).not.toBe(turn1Id);

  // ---- A1.4: повторный commit хода №2 с тем же idempotencyKey → тот же version
  await gmPage.getByTestId('gm-lock-turn').click();
  await expect(gmPage.getByTestId('gm-turn-card')).toContainText('REVIEW', { timeout: 60_000 });
  const commitKey = `e2e-table-recommit-${Date.now()}-abcdef`;
  const c1 = await commitTurnWithKey(server.base, turn2Id, gmToken, commitKey);
  const c2 = await commitTurnWithKey(server.base, turn2Id, gmToken, commitKey);
  expect(c2.version).toBe(c1.version);
});
