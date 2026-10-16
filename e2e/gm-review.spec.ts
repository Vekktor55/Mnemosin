import { test, expect } from '@playwright/test';

import {
  createSession,
  getTurn,
  joinSession,
  pickPort,
  startServer,
  startSessionTurn,
  submitActionHttp,
  type TestServer,
} from './helpers.js';

/**
 * GM-ревью цикл (промпт 1.12, п.8; A1.8): вход по токену → Lock → черновик
 * (TURN_DRAFT_READY + TURN_RESOLUTION_GM, GM_ONLY) → diagnostics (scripted) →
 * правка сегмента → Edit&Approve (baseResolutionHash) → COMMITTED с правкой
 * в нарративе → запись в gm_audit.
 */

const PORT = pickPort();
const DB = `e2e-gm-review-${Date.now()}-${PORT}.sqlite`;
let server: TestServer;
let sessionId: string;
let gmToken: string;
let turnId: string;

test.beforeAll(async () => {
  server = await startServer(PORT, DB);
  const session = await createSession(server.base, 'Ведущий Ревью');
  sessionId = session.sessionId;
  gmToken = session.token;
  const player = await joinSession(server.base, sessionId, 'Ирма');
  const started = await startSessionTurn(server.base, sessionId, gmToken);
  turnId = started.turnId;
  await submitActionHttp(server.base, turnId, player.token, 'Трогаю холодную панель шлюза');
});

test.afterAll(async () => {
  await server.stop();
});

test('GM: вход по токену → Lock → Review → Edit&Approve → COMMITTED + audit', async ({ page }) => {
  // 1. Вход GM по токену (sessionId придёт в AUTH_OK).
  await page.goto(`http://127.0.0.1:${PORT}/gm/`);
  await page.getByTestId('mode-token').click();
  await page.getByTestId('gm-token').fill(gmToken);
  await page.getByTestId('gm-token-submit').click();
  await expect(page.getByTestId('connection-bar')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 30_000 });
  await expect(page.getByTestId('game-shell')).toHaveAttribute('data-role', 'gm');
  await expect(page.getByTestId('session-id')).toHaveValue(sessionId, { timeout: 15_000 });

  // 2. Turn-вкладка: Lock (WS GM_LOCK_TURN, без оптимизма — ждём TURN_UPDATE).
  await page.getByTestId('tab-turn').click();
  await expect(page.getByTestId('gm-turn-card')).toContainText('OPEN');
  await page.getByTestId('gm-lock-turn').click();
  // LOCKED → PROCESSING → REVIEW происходят почти мгновенно (scripted AI):
  // ждём конечный статус обзора, а не транзитный LOCKED.
  await expect(page.getByTestId('gm-turn-card')).toContainText('REVIEW', { timeout: 30_000 });

  // 3. Review: черновик от scripted AI (TURN_DRAFT_READY + TURN_RESOLUTION_GM).
  await page.getByTestId('tab-review').click();
  await expect(page.getByTestId('diagnostics')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('diagnostics')).toContainText('scripted');
  await expect(page.getByTestId('segment-0')).toBeVisible();
  await expect(page.getByTestId('segment-text-0')).toHaveValue(/Лампа над внутренней дверью мигнула/);

  // 4. Правка сегмента + Edit&Approve (baseResolutionHash из черновика).
  const segment = page.getByTestId('segment-text-0');
  await segment.fill('Лампа над внутренней дверью мигнула — ПРАВКА ВЕДУЩЕГО');
  await page.getByTestId('gm-edit-approve').click();
  await expect(page.getByTestId('op-status-editAndApprove')).toContainText('OK', { timeout: 30_000 });

  // 5. Ход COMMITTED; публичный нарратив содержит правку (TURN_COMMITTED).
  const turn = await getTurn(server.base, turnId, gmToken);
  expect(turn.status).toBe('COMMITTED');
  await expect(page.getByTestId('system-feed')).toContainText('ПРАВКА ВЕДУЩЕГО', { timeout: 15_000 });

  // 6. Audit: gm_audit содержит editAndApprove и lockTurn (append-only).
  await page.getByTestId('tab-audit').click();
  await expect(page.getByTestId('audit-table')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('audit-table')).toContainText('editAndApprove');
  await expect(page.getByTestId('audit-table')).toContainText('lockTurn');
});
