import { test, expect } from '@playwright/test';

import {
  commitTurn,
  createSession,
  getTurn,
  joinSession,
  lockTurn,
  pickPort,
  startSessionTurn,
  startServer,
  submitActionHttp,
  waitTurnStatus,
  type TestServer,
} from './helpers.js';

/**
 * E2E игрока (промпт 1.12, п.8): логин, отправка действия, отображение
 * нарратива после commit, восстановление вкладки (D126), ошибки входа
 * с кодом и clientAction из ERROR_TABLE.
 *
 * Порядок сценария учитывает join_requires_lobby: сначала все игроки
 * присоединяются (LOBBY), затем GM открывает сессию (start → ACTIVE).
 */

const PORT = pickPort();
const DB = `e2e-player-${Date.now()}-${PORT}.sqlite`;
let server: TestServer;
let sessionId: string;
let gmToken: string;
let turnId: string;

test.beforeAll(async () => {
  server = await startServer(PORT, DB);
  const session = await createSession(server.base);
  sessionId = session.sessionId;
  gmToken = session.token;
  // Второй игрок — через API (Ирма логинится через UI ниже; старт — после обоих join).
  await joinSession(server.base, sessionId, 'Каймен');
});

test.afterAll(async () => {
  await server.stop();
});

test('логин → действие → ack → commit GM → нарратив; reload восстанавливает сессию', async ({ page }) => {
  // 1. Экран входа: sessionId предзаполнен из ?session=, displayName → join.
  await page.goto(`http://127.0.0.1:${PORT}/player/?session=${sessionId}`);
  await expect(page.getByTestId('login-session')).toHaveValue(sessionId);
  await page.getByTestId('login-display-name').fill('Ирма');
  await page.getByTestId('login-character-name').fill('Ирма Векторова');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('connection-bar')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 30_000 });
  await expect(page.getByTestId('game-shell')).toHaveAttribute('data-role', 'player');
  await expect(page.getByTestId('who-am-i')).toContainText('Ирма');

  // 2. GM открывает сессию и первый ход (start требует ≥1 игрока не-GM).
  const started = await startSessionTurn(server.base, sessionId, gmToken);
  turnId = started.turnId;

  // TURN_OPENED → TURN_UPDATE (BROADCAST): ход виден в TurnStatus.
  await expect(page.getByTestId('turn-status')).toContainText('Ход #1', { timeout: 15_000 });

  // 3. Отправка действия: оптимистично → ACTION_ACK → sequenceId #1.
  await page.getByTestId('action-input').fill('Осматриваю шлюз и слушаю гул вентиляции');
  await page.getByTestId('action-submit').click();
  const row = page.getByTestId('my-actions').locator('.my-action', { hasText: 'Осматриваю шлюз' });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-action-status', 'ACKED', { timeout: 15_000 });
  await expect(row).toContainText('#1');
  await expect(page.getByTestId('actions-left')).toContainText('4');

  // 4. GM-цикл через HTTP: lock → REVIEW (scripted AI) → commit.
  await lockTurn(server.base, turnId, gmToken);
  await waitTurnStatus(server.base, turnId, gmToken, ['REVIEW']);
  const commit = await commitTurn(server.base, turnId, gmToken);
  expect(commit.version).toBeGreaterThan(0);

  // 5. TURN_COMMITTED → SystemFeed: нарратив из фикстуры (маркер {actionCount}
  //    заменён стендом на число действий).
  const feed = page.getByTestId('system-feed');
  await expect(feed.locator('.feed-entry.narrative')).toBeVisible({ timeout: 30_000 });
  await expect(feed).toContainText('Лампа над внутренней дверью мигнула');

  // 6. TURN_PRIVATE_RESOLUTION (TARGETED): фикстура адресует первые
  //    privateMessages игрокам по индексу → «Вам лично».
  await expect(feed.locator('.feed-entry.private')).toContainText('Вам лично:', { timeout: 15_000 });

  // 7. Ход COMMITTED — статус в TurnPanel, ввод действия заблокирован.
  const turn = await getTurn(server.base, turnId, gmToken);
  expect(turn.status).toBe('COMMITTED');
  await expect(page.getByTestId('turn-status')).toContainText('COMMITTED');
  await expect(page.getByTestId('action-submit')).toBeDisabled();

  // 8. Reload той же вкладки: identity из sessionStorage (D126) → авто-вход.
  await page.reload();
  await expect(page.getByTestId('connection-bar')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 30_000 });
  await expect(page.getByTestId('system-feed')).toBeVisible();

  // 9. Действие в COMMITTED-ход через HTTP отклоняется (TURN_NOT_OPEN).
  const rejected = await submitActionHttp(server.base, turnId, gmToken, 'пост-коммит').catch(
    (cause: Error) => cause.message,
  );
  expect(String(rejected)).toContain('TURN_NOT_OPEN');
});

test('ошибка входа показывается кодом и clientAction (NOT_FOUND)', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/player/`);
  await page.getByTestId('login-session').fill('00000000-0000-4000-8000-000000000000');
  await page.getByTestId('login-display-name').fill('Призрак');
  await page.getByTestId('login-submit').click();
  const error = page.getByTestId('login-error');
  await expect(error).toBeVisible({ timeout: 15_000 });
  await expect(error).toContainText('NOT_FOUND');
  // UI показывает действие из ERROR_TABLE, а не только сырой код (SPEC §4).
  await expect(error).toContainText('Действие:');
  await context.close();
});
