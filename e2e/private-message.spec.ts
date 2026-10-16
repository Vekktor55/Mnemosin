import { test, expect, type Page } from '@playwright/test';

import { createSession, pickPort, startServer, startSessionTurn, type TestServer } from './helpers.js';

/**
 * Приватное сообщение видно только адресату (промпт 1.12, п.8; A1.10):
 * два браузера — отправитель и получатель; в публичной ленте сообщения нет.
 * Оба игрока логинятся через UI (join в LOBBY), старт сессии — после.
 */

const PORT = pickPort();
const DB = `e2e-private-${Date.now()}-${PORT}.sqlite`;
let server: TestServer;
let sessionId: string;
let gmToken: string;

test.beforeAll(async () => {
  server = await startServer(PORT, DB);
  const session = await createSession(server.base);
  sessionId = session.sessionId;
  gmToken = session.token;
});

test.afterAll(async () => {
  await server.stop();
});

async function login(page: Page, displayName: string): Promise<void> {
  await page.goto(`http://127.0.0.1:${PORT}/player/?session=${sessionId}`);
  await page.getByTestId('login-display-name').fill(displayName);
  await page.getByTestId('login-character-name').fill(displayName);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('connection-bar')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 30_000 });
}

test('приватное сообщение видно только адресату (два браузера)', async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await login(pageA, 'Ирма');
  await login(pageB, 'Каймен');

  // Сессия стартует после обоих join (join_requires_lobby).
  await startSessionTurn(server.base, sessionId, gmToken);

  // Оба видят друг друга в списке игроков (STATE_PROJECTION + догонка presence).
  await expect(pageA.getByTestId('player-list')).toContainText('Каймен', { timeout: 20_000 });
  await expect(pageB.getByTestId('player-list')).toContainText('Ирма', { timeout: 20_000 });

  const secret = 'секретный шёпот только для Каймена';

  // A → B приватно.
  await pageA.getByTestId('private-target').selectOption({ label: 'Каймен' });
  await pageA.getByTestId('private-chat-input').fill(secret);
  await pageA.getByTestId('private-chat-send').click();

  // Отправитель: сообщение в его приватной ленте (статус delivered после CHAT_ACK).
  const threadA = pageA.getByTestId('private-chat');
  await expect(threadA).toContainText(secret, { timeout: 15_000 });
  await expect(threadA.locator('.chat-message.pending')).toHaveCount(0, { timeout: 15_000 });

  // Адресат: TARGETED-доставка — сообщение видно (B выбирает тред с A:
  // по умолчанию в select первый игрок списка, а не отправитель).
  await pageB.getByTestId('private-target').selectOption({ label: 'Ирма' });
  const threadB = pageB.getByTestId('private-chat');
  await expect(threadB).toContainText(secret, { timeout: 15_000 });

  // Приватность: в публичных лентах сообщения нет (ни у кого).
  await expect(pageA.getByTestId('public-chat')).not.toContainText(secret);
  await expect(pageB.getByTestId('public-chat')).not.toContainText(secret);

  // Публичное сообщение для контроля доходит обоим.
  await pageA.getByTestId('public-chat-input').fill('всем слышно?');
  await pageA.getByTestId('public-chat-send').click();
  await expect(pageB.getByTestId('public-chat')).toContainText('всем слышно?', { timeout: 15_000 });

  await contextA.close();
  await contextB.close();
});
