import { defineConfig } from '@playwright/test';

/**
 * Playwright (промпт 1.12, п.8): компонентные сценарии «Стола».
 *
 * Сервер поднимается ВНУТРИ спецификаций (helpers.startServer) — каждому spec
 * свой порт и своя БД (D108: одна активная сессия на сервер). workers=1 и
 * fullyParallel=false — спецификации последовательны, порты не пересекаются.
 * Клиент отдаёт сам сервер из client/dist (prod-режим, same-origin): сборка —
 * в global-setup.ts.
 *
 * Запуск: npm run test:e2e            (все)
 *        npm run test:e2e -- e2e/player.spec.ts  (один файл)
 */
export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    // html-отчёт — артефакт CI (промпт 1.13, п.6).
    ['html', { open: 'never' }],
  ],
  outputDir: '../test-results',
  use: {
    headless: true,
    // Трассировки жрут память воркера; включаются по требованию (E2E_TRACE=1).
    trace: process.env.E2E_TRACE === '1' ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure',
    launchOptions: {
      // Песочницы/CI: маленький /dev/shm, root, ~1 ГБ RAM (V8 CodeRange OOM
      // при нехватке памяти). Рендереры одного origin шерингуются, zygote
      // отключён — минимальный footprint для 7 контекстов сценария «Стол».
      args: [
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-gpu',
        '--no-zygote',
        '--renderer-process-limit=2',
        // Песочницы без swap и с overcommit=0: V8 не может зарезервировать
        // дефолтный CodeRange (V8 process OOM) — jitless отключает JIT и
        // огромное VA-резервирование; на производительность e2e не влияет.
        '--js-flags=--jitless',
      ],
    },
  },
  globalSetup: './global-setup.ts',
});
