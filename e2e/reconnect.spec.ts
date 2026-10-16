import { test, expect } from '@playwright/test';

import {
  createSession,
  getTurn,
  joinSession,
  pickPort,
  startServer,
  startSessionTurn,
  type TestServer,
} from './helpers.js';

/**
 * Реконнект (промпт 1.12, п.8; A1.9, F-6.10): kill -9 сервера → клиент
 * RECONNECTING (экспоненциальный backoff) → действие, отправленное офлайн,
 * ставится в offline-очередь (localStorage mnemosin:pending:<playerId>) →
 * сервер поднимается → CONNECTED → очередь переотправлена и применена РОВНО
 * один раз (серверная дедупликация по requestId/idempotencyKey, D272).
 */

const PORT = pickPort();
const DB = `e2e-reconnect-${Date.now()}-${PORT}.sqlite`;
let server: TestServer;
let sessionId: string;
let gmToken: string;
let turnId: string;
let playerToken: string;

test.beforeAll(async () => {
  server = await startServer(PORT, DB);
  const session = await createSession(server.base);
  sessionId = session.sessionId;
  gmToken = session.token;
  // join до start (LOBBY); Ирма логинится через UI в тесте — тоже до start.
  const joined = await joinSession(server.base, sessionId, 'Наблюдатель');
  playerToken = joined.token;
});

test.afterAll(async () => {
  // Сервер может быть уже перезапущен тестом — останавливаем текущий.
  await server.stop().catch(() => undefined);
});

test('kill -9 → RECONNECTING → offline-очередь → CONNECTED → действие применено один раз', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PORT}/player/?session=${sessionId}`);
  await page.getByTestId('login-display-name').fill('Ирма');
  await page.getByTestId('login-character-name').fill('Ирма');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('connection-bar')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 30_000 });

  // Старт сессии и первого хода — после всех join.
  const started = await startSessionTurn(server.base, sessionId, gmToken);
  turnId = started.turnId;
  await expect(page.getByTestId('turn-status')).toContainText('Ход #1', { timeout: 15_000 });

  // Действие до обрыва — ACKED.
  await page.getByTestId('action-input').fill('Первое действие до обрыва');
  await page.getByTestId('action-submit').click();
  await expect(page.getByTestId('my-actions').locator('.my-action[data-action-status="ACKED"]')).toHaveCount(1, {
    timeout: 15_000,
  });

  // kill -9 (A1.9).
  server.kill9();

  // Клиент обнаруживает разрыв и уходит в RECONNECTING c попыткой 1/8.
  const bar = page.getByTestId('connection-bar');
  await expect(bar).toHaveAttribute('data-status', 'RECONNECTING', { timeout: 60_000 });
  await expect(bar).toContainText('переподключение');
  await expect(bar).toContainText('попытка');

  // Действие, отправленное офлайн, — в очередь (PENDING, не потеряно).
  await page.getByTestId('action-input').fill('Второе действие в офлайн-очереди');
  await expect(page.getByTestId('action-submit')).toBeEnabled();
  await page.getByTestId('action-submit').click();
  await expect(
    page.getByTestId('my-actions').locator('.my-action.pending', { hasText: 'Второе действие' }),
  ).toBeVisible();

  // Очередь персистентна: в localStorage есть mnemosin:pending:<playerId>.
  const pendingKeys = await page.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.startsWith('mnemosin:pending:')),
  );
  expect(pendingKeys.length).toBe(1);

  // Поднимаем новый процесс на том же порту и БД (cleanDb: false — данные
  // переживают kill -9, как в A1.9/A1.11).
  server = await startServer(PORT, DB, { cleanDb: false });

  // Backoff досчитывает до успешной попытки → CONNECTED (A1.9).
  await expect(bar).toHaveAttribute('data-status', 'CONNECTED', { timeout: 90_000 });

  // Offline-очередь переотправлена: второе действие ACKED…
  await expect(page.getByTestId('my-actions').locator('.my-action', { hasText: 'Второе действие' })).toHaveAttribute(
    'data-action-status',
    'ACKED',
    { timeout: 30_000 },
  );
  // …и очищена из localStorage.
  await expect
    .poll(
      async () =>
        page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('mnemosin:pending:')).length),
      {
        timeout: 15_000,
      },
    )
    .toBe(0);

  // РОВНО один раз: на сервере 2 действия (до обрыва + из очереди), не 3.
  const turn = await getTurn(server.base, turnId, playerToken);
  expect(turn.actionCount).toBe(2);
});
