import { test, expect } from '@playwright/test';

import {
  createSession,
  getTurn,
  joinSession,
  lockTurn,
  pickPort,
  startServer,
  startSessionTurn,
  submitActionHttp,
  apiGet,
  apiPost,
  type TestServer,
} from './helpers.js';

/**
 * Restart-recovery (промпт 1.13, п.4; A1.9/A1.11, D127):
 * SIGKILL сервера ВО ВРЕМЯ PROCESSING (failing(timeout) держит ход в PROCESSING
 * ~15 c) → перезапуск на той же БД → reconcileOnBoot переводит ход в
 * FAILED{RECONCILE_INTERRUPTED} (D127: фиксация default SPEC §13), журнал
 * получает 'reconciled_on_boot'; состояние и чат целы; клиент переподключился
 * сам и получил полную проекцию (reconnect-последовательность §6.1).
 */

const PORT = pickPort();
const FAILING_CONFIG = './tools/verify/fixtures/config-failing';
const DB = `e2e-restart-${Date.now()}-${PORT}.sqlite`;
const CHAT_BEFORE_CRASH = 'сообщение до краха сервера';

let server: TestServer;
let sessionId: string;
let gmToken: string;
let turnId: string;
let playerToken: string;

test.beforeAll(async () => {
  server = await startServer(PORT, DB, { aiProvider: 'failing', aiFailingMode: 'timeout', configDir: FAILING_CONFIG });
  const session = await createSession(server.base);
  sessionId = session.sessionId;
  gmToken = session.token;
  const player = await joinSession(server.base, sessionId, 'Ирма');
  playerToken = player.token;
  const started = await startSessionTurn(server.base, sessionId, gmToken);
  turnId = started.turnId;
  await submitActionHttp(server.base, turnId, playerToken, 'Жду у внутренней двери');
});

test.afterAll(async () => {
  await server.stop().catch(() => undefined);
});

test('SIGKILL во время PROCESSING → reconcileOnBoot (D127) → клиент догнал состояние', async ({ page }) => {
  test.setTimeout(300_000);

  // Игрок подключается и шлёт чат-сообщение (проверка целостности чата).
  await page.goto(`http://127.0.0.1:${PORT}/player/?session=${sessionId}`);
  await page.getByTestId('login-display-name').fill('Ирма');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('connection-bar')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 30_000 });
  await page.getByTestId('public-chat-input').fill(CHAT_BEFORE_CRASH);
  await page.getByTestId('public-chat-send').click();
  await expect(page.getByTestId('public-chat')).toContainText(CHAT_BEFORE_CRASH, { timeout: 15_000 });

  // Lock → ход в PROCESSING (failing(timeout): ~5 c на попытку, 3 попытки).
  await lockTurn(server.base, turnId, gmToken);
  await expect
    .poll(async () => (await getTurn(server.base, turnId, gmToken)).status, { timeout: 30_000 })
    .toBe('PROCESSING');

  // SIGKILL посреди PROCESSING.
  server.kill9();

  // Перезапуск на той же БД с scripted AI (смена провайдера — только env, A1.12).
  server = await startServer(PORT, DB, { aiProvider: 'scripted', cleanDb: false });

  // reconcileOnBoot: ход FAILED{RECONCILE_INTERRUPTED} (D127).
  await expect
    .poll(async () => (await getTurn(server.base, turnId, gmToken)).status, { timeout: 30_000 })
    .toBe('FAILED');
  const failedTurn = await getTurn(server.base, turnId, gmToken);
  expect(failedTurn.status).toBe('FAILED');
  const turnFull = await apiGet<{ failed: { code: string } | null }>(server.base, `/turns/${turnId}`, gmToken);
  expect(turnFull.failed?.code).toBe('RECONCILE_INTERRUPTED');

  // Журнал: запись reconciled_on_boot (kind зарезервирован под этот промпт).
  const journal = await apiPost<Array<{ kind: string }>>(server.base, '/gm/inspect/journal', { turnId }, gmToken);
  expect(journal.some((entry) => entry.kind === 'reconciled_on_boot')).toBe(true);

  // Клиент переподключился сам (backoff) и получил полную проекцию (A1.9/A1.11).
  await expect(page.getByTestId('connection-bar')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 90_000 });
  await expect(page.getByTestId('turn-status')).toContainText('FAILED', { timeout: 30_000 });
  await expect(page.getByTestId('system-feed')).toContainText('RECONCILE_INTERRUPTED', { timeout: 30_000 });

  // Чат цел: сообщение до краха вернулось через HISTORY{since} после реконнекта.
  await expect(page.getByTestId('public-chat')).toContainText(CHAT_BEFORE_CRASH, { timeout: 30_000 });

  // Состояние цело: публичная проекция (локация/игроки) на месте.
  await expect(page.getByTestId('player-list')).toContainText('Ирма', { timeout: 15_000 });

  // GM retry из FAILED создаёт новый ход (D118) — игра продолжается.
  const gmPage = await (await page.context().browser()!.newContext()).newPage();
  await gmPage.goto(`http://127.0.0.1:${PORT}/gm/`);
  await gmPage.getByTestId('mode-token').click();
  await gmPage.getByTestId('gm-token').fill(gmToken);
  await gmPage.getByTestId('gm-token-submit').click();
  await expect(gmPage.getByTestId('connection-bar')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 30_000 });
  await gmPage.getByTestId('tab-turn').click();
  await gmPage.getByTestId('gm-open-turn').click();
  await expect(gmPage.getByTestId('gm-turn-card')).toContainText('Ход #2', { timeout: 30_000 });
});
