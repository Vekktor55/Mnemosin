import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

/**
 * Vite-конфиг клиента (промпт 1.12, п.1; D103 — Svelte 5 + Vite, без UI-библиотек).
 *
 * - dev-порт 5173; proxy /health и /ws на 3000 (ws: true для WebSocket);
 * - две точки входа (MPA): /player/ и /gm/ — общий shell, отдельные страницы;
 *   прод-сборка кладётся в client/dist и отдаётся сервером через @fastify/static
 *   (apps/server/src/app.ts, каркас 1.1), поэтому в prod клиент same-origin;
 * - resolve.conditions=['development'] — @mnemosin/contracts резолвится в
 *   исходники (src/*.ts), как в vitest.config.ts: сборка клиента не зависит от
 *   порядка tsc -b (контракты — единственный источник истины, инвариант 15).
 */
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    // 'development' — @mnemosin/contracts резолвится в исходники (src/*.ts),
    // как в vitest.config.ts: сборка клиента не зависит от порядка tsc -b.
    // ВАЖНО: список ЗАМЕНЯЕТ дефолтные условия vite, поэтому browser/module/
    // import перечислены явно — без 'browser' svelte собралась бы server-
    // сборкой (mount() недоступен, lifecycle_function_unavailable).
    conditions: ['development', 'browser', 'module', 'import'],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/health': { target: 'http://localhost:3000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        player: fileURLToPath(new URL('./player/index.html', import.meta.url)),
        gm: fileURLToPath(new URL('./gm/index.html', import.meta.url)),
      },
    },
  },
});
