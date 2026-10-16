import { test, expect } from '@playwright/test';

import {
  createSession,
  getTurn,
  joinSession,
  pickPort,
  startServer,
  startSessionTurn,
  submitActionHttp,
  waitTurnStatus,
  type TestServer,
} from './helpers.js';

/**
 * Деградация AI (промпт 1.13, п.3; A1.12/A1.13): AI_PROVIDER=failing(timeout)
 * + config-failing (chain=[failing]) → ход FAILED{PROVIDER_TIMEOUT}; GM видит
 * ошибку и кнопку Retry; breaker размыкается после 3 провалов (два хода по две
 * попытки) → CAPABILITY_CHANGED{TEXT_AI,false} виден в /health и SystemFeed;
 * смена провайдера на scripted ТОЛЬКО через env (перезапуск на той же БД) →
 * Retry проходит: создаётся новый ход (D118) и доходит до REVIEW.
 */

const PORT = pickPort();
const FAILING_CONFIG = './tools/verify/fixtures/config-failing';
const DB = `e2e-degraded-${Date.now()}-${PORT}.sqlite`;

let failing: TestServer;
let sessionId: string;
let gmToken: string;
let turnId: string;
let playerToken: string;

test.beforeAll(async () => {
  failing = await startServer(PORT, DB, { aiProvider: 'failing', aiFailingMode: 'timeout', configDir: FAILING_CONFIG });
  const session = await createSession(failing.base);
  sessionId = session.sessionId;
  gmToken = session.token;
  const player = await joinSession(failing.base, sessionId, 'Ирма');
  playerToken = player.token;
  const started = await startSessionTurn(failing.base, sessionId, gmToken);
  turnId = started.turnId;
  await submitActionHttp(failing.base, turnId, playerToken, 'Пробую открыть наружную дверь');
});

test.afterAll(async () => {
  await failing.stop().catch(() => undefined);
});

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** /health.capabilities — снапшот регистра: {generatedAt, capabilities:{TEXT_AI:{available}}}. */
async function textAiAvailable(base: string): Promise<boolean | undefined> {
  const health = (await (await fetch(`${base}/health`)).json()) as {
    capabilities?: { capabilities?: Record<string, { available?: boolean }> };
  };
  return health.capabilities?.capabilities?.['TEXT_AI']?.available;
}

test('failing AI → FAILED{PROVIDER_TIMEOUT} + breaker + Retry после смены env', async ({ page }) => {
  test.setTimeout(300_000);

  // GM входит по токену.
  await page.goto(`http://127.0.0.1:${PORT}/gm/`);
  await page.getByTestId('mode-token').click();
  await page.getByTestId('gm-token').fill(gmToken);
  await page.getByTestId('gm-token-submit').click();
  await expect(page.getByTestId('connection-bar')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 30_000 });

  // Ход 1: lock → PROCESSING → провалы провайдера → TURN_FAILED.
  await page.getByTestId('tab-turn').click();
  await page.getByTestId('gm-lock-turn').click();
  await waitTurnStatus(failing.base, turnId, gmToken, ['FAILED'], 90_000);
  await expect(page.getByTestId('gm-turn-card')).toContainText('PROVIDER_TIMEOUT', { timeout: 30_000 });
  await expect(page.getByTestId('system-feed')).toContainText('Ход провалился', { timeout: 15_000 });

  // Retry виден GM в Review даже без черновика (карточка проваленного хода).
  await page.getByTestId('tab-review').click();
  await expect(page.getByTestId('turn-failed-card')).toContainText('PROVIDER_TIMEOUT', { timeout: 15_000 });
  await expect(page.getByTestId('gm-retry-ai')).toBeVisible();

  // Ходы 2..N: добираем провалы до порога breaker (failureThreshold=3,
  // retries=0 в config-failing → один провал на ход) → CAPABILITY_CHANGED{false}.
  let breakerOpen = false;
  let lastTurnId = turnId;
  for (let turnNo = 2; turnNo <= 4 && !breakerOpen; turnNo += 1) {
    await page.getByTestId('tab-turn').click();
    await page.getByTestId('gm-open-turn').click();
    await expect(page.getByTestId('gm-turn-card')).toContainText(`Ход #${turnNo}`, { timeout: 30_000 });
    const match = UUID_RE.exec((await page.getByTestId('gm-turn-card').textContent()) ?? '');
    lastTurnId = match?.[0] ?? '';
    expect(lastTurnId).not.toBe('');
    await submitActionHttp(failing.base, lastTurnId, playerToken, `Попытка ${turnNo}: слушаю дверь`);
    await page.getByTestId('gm-lock-turn').click();
    await waitTurnStatus(failing.base, lastTurnId, gmToken, ['FAILED'], 90_000);
    breakerOpen = (await textAiAvailable(failing.base)) === false;
  }
  expect(breakerOpen, 'breaker OPEN после порога провалов (A1.13)').toBe(true);

  // CAPABILITY_CHANGED{TEXT_AI,false}: SystemFeed и /health.
  await expect(page.getByTestId('system-feed')).toContainText('недоступна', { timeout: 30_000 });
  expect(await textAiAvailable(failing.base)).toBe(false);

  // Смена провайдера ТОЛЬКО через env: перезапуск сервера на той же БД.
  failing.kill9();
  const scripted = await startServer(PORT, DB, { aiProvider: 'scripted', cleanDb: false });
  failing = scripted;

  // Клиент переподключился сам (reconnect-контракт A1.9).
  await expect(page.getByTestId('connection-bar')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 90_000 });

  // Retry из FAILED: создаётся НОВЫЙ ход (D118) → lock → REVIEW (scripted).
  await page.getByTestId('tab-review').click();
  await expect(page.getByTestId('gm-retry-ai')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('gm-retry-ai').click();
  await page.getByTestId('tab-turn').click();
  await expect(page.getByTestId('gm-turn-card')).toContainText('OPEN', { timeout: 30_000 });
  const nextMatch = UUID_RE.exec((await page.getByTestId('gm-turn-card').textContent()) ?? '');
  const nextTurnId = nextMatch?.[0] ?? '';
  expect(nextTurnId).not.toBe('');
  expect(nextTurnId).not.toBe(lastTurnId);
  await submitActionHttp(scripted.base, nextTurnId, playerToken, 'Дверь поддалась: выходим');
  await page.getByTestId('gm-lock-turn').click();
  await waitTurnStatus(scripted.base, nextTurnId, gmToken, ['REVIEW'], 60_000);
  await page.getByTestId('tab-review').click();
  await expect(page.getByTestId('diagnostics')).toContainText('scripted', { timeout: 30_000 });

  // Capability восстановилась: /health TEXT_AI available (probe при старте).
  expect(await textAiAvailable(scripted.base)).toBe(true);
  const tNext = await getTurn(scripted.base, nextTurnId, gmToken);
  expect(tNext.status).toBe('REVIEW');
});
