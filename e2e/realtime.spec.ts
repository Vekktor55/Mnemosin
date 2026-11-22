/**
 * P05-B браузерная верификация: два игрока на P03, собственное движение +
 * prediction/reconciliation, удалённая интерполяция под RTT/jitter, стены и
 * закрытая дверь, восстановление после reconnect. Замеры FPS / frame time /
 * input-to-visual публикуются клиентом в window.__MNEMOSIN__.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

interface RemotePosition {
  readonly participantId: string;
  readonly x: number;
  readonly y: number;
}

interface Metrics {
  readonly fps: number;
  readonly frameTimeMs: number;
  readonly inputToVisualMs: number;
  readonly rttMs: number | null;
  readonly ready: boolean;
  readonly myParticipantId: string | null;
  readonly playerCount: number;
  readonly ownX: number;
  readonly ownY: number;
  readonly authoritativeX: number;
  readonly authoritativeY: number;
  readonly doorPortalState: 'open' | 'closed' | 'locked' | null;
  readonly remotes: readonly RemotePosition[];
}

declare global {
  interface Window {
    __MNEMOSIN__?: Metrics;
  }
}

const PLAYER_ONE = '00000000-0000-4000-8000-000000000101';
const PLAYER_TWO = '00000000-0000-4000-8000-000000000102';

function identity(token: string): Record<string, unknown> {
  return {
    role: 'player',
    token,
    refreshToken: null,
    playerId: null,
    sessionId: null,
    displayName: token,
    characterName: token,
  };
}

async function seed(context: BrowserContext, token: string): Promise<void> {
  await context.addInitScript((value) => {
    sessionStorage.setItem('mnemosin:identity', JSON.stringify(value));
  }, identity(token));
}

async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__MNEMOSIN__?.ready === true, undefined, { timeout: 20_000 });
}

async function requireMetrics(page: Page): Promise<Metrics> {
  const metrics = await page.evaluate(() => window.__MNEMOSIN__);
  if (metrics === undefined) throw new Error('window.__MNEMOSIN__ не опубликован');
  return metrics;
}

async function playerCount(page: Page): Promise<number | undefined> {
  return (await page.evaluate(() => window.__MNEMOSIN__?.playerCount)) ?? undefined;
}

test('два игрока подключаются в комнату P03 и видят друг друга', async ({ browser, context, page }) => {
  await seed(context, 'player-one');
  await page.goto('/');
  await waitReady(page);

  const second = await browser.newContext();
  await seed(second, 'player-two');
  const secondPage = await second.newPage();
  await secondPage.goto('/');
  await waitReady(secondPage);

  await expect.poll(() => playerCount(page)).toBe(2);
  await expect.poll(() => playerCount(secondPage)).toBe(2);

  const firstMetrics = await requireMetrics(page);
  expect(firstMetrics.myParticipantId).toBe(PLAYER_ONE);
  expect(firstMetrics.doorPortalState).toBe('closed');

  await second.close();
});

test('собственное движение немедленно, стена блокирует, reconciliation сходится', async ({ context, page }) => {
  await seed(context, 'player-one');
  await page.goto('/');
  await waitReady(page);

  // Спавн (0.5, 2.5). Идём вверх в ряд стены (gy=1), затем вправо в стену (1,1).
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(600);
  await page.keyboard.up('ArrowUp');
  await page.waitForTimeout(200);

  await page.keyboard.down('ArrowRight');
  await expect.poll(async () => (await requireMetrics(page)).authoritativeX).toBeGreaterThan(0.75);
  await page.keyboard.up('ArrowRight');
  await page.waitForTimeout(350);

  const metrics = await requireMetrics(page);
  expect(metrics.authoritativeX).toBeLessThan(1.0); // стена в gx=1 не пройдена
  expect(metrics.inputToVisualMs).toBeGreaterThanOrEqual(0);
  expect(metrics.frameTimeMs).toBeGreaterThan(0);
  expect(metrics.fps).toBeGreaterThan(0);
  // reconciliation: predicted прижат к authoritative после settle.
  expect(Math.abs(metrics.ownX - metrics.authoritativeX)).toBeLessThan(0.2);

  const samples = [metrics];
  for (let i = 0; i < 2; i += 1) {
    await page.waitForTimeout(260);
    samples.push(await requireMetrics(page));
  }
  console.log(
    '[metrics][movement]',
    JSON.stringify(
      samples.map((sample) => ({
        fps: sample.fps,
        frameTimeMs: sample.frameTimeMs,
        inputToVisualMs: sample.inputToVisualMs,
      })),
    ),
  );
});

test('удалённая сущность сглаживается при искусственном RTT/jitter', async ({ browser, context, page }) => {
  await seed(context, 'player-one');
  await page.goto('/?netProfile=rtt=150,jitter=40,loss=0');
  await waitReady(page);

  const second = await browser.newContext();
  await seed(second, 'player-two');
  const secondPage = await second.newPage();
  await secondPage.goto('/?netProfile=rtt=150,jitter=40,loss=0');
  await waitReady(secondPage);

  // Игрок 2 (спавн (3.5, 0.5)) движется вниз.
  await secondPage.keyboard.down('ArrowDown');
  await secondPage.waitForTimeout(1200);
  await secondPage.keyboard.up('ArrowDown');
  await secondPage.waitForTimeout(400);

  const first = await requireMetrics(page);
  await expect.poll(async () => (await requireMetrics(page)).rttMs).toBeGreaterThan(0);
  expect(first.fps).toBeGreaterThan(0);
  const remote = first.remotes.find((entry) => entry.participantId === PLAYER_TWO);
  expect(remote).toBeDefined();
  if (remote !== undefined) expect(remote.y).toBeGreaterThan(0.5);

  console.log('[metrics][rtt]', JSON.stringify({ rttMs: first.rttMs, fps: first.fps, frameTimeMs: first.frameTimeMs }));

  await second.close();
});

test('восстановление состояния после reconnect', async ({ context, page }) => {
  await seed(context, 'player-one');
  await page.goto('/');
  await waitReady(page);

  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(600);
  await page.keyboard.up('ArrowUp');
  await expect.poll(async () => (await requireMetrics(page)).authoritativeY).toBeLessThan(2.0);
  // Ждём settle сервера (input 0) + обновления throttled-метрик (250 мс).
  await page.waitForTimeout(800);
  const before = (await requireMetrics(page)).authoritativeY;

  // Перезагрузка вкладки = новый WebSocket + свежий keyframe (reconnect path).
  await page.reload();
  await waitReady(page);
  const after = (await requireMetrics(page)).authoritativeY;
  // Reconnect доставил свежий keyframe с сохранённой позицией (не сброшен к спавну 2.5).
  expect(after).toBeLessThan(2.0);
  expect(Math.abs(after - before)).toBeLessThan(0.5);
});
