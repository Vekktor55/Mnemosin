import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E для P05-B (браузерная верификация realtime).
 * webServer поднимает e2e/server.ts (Fastify + prototype WS) и требует собранный
 * `client/dist` (root-скрипт `test:e2e` делает `npm run build -w client` первым).
 */
export default defineConfig({
  testDir: './',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    viewport: { width: 1024, height: 768 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'tsx --conditions=development server.ts',
    url: 'http://127.0.0.1:4173/health',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
