import { defineConfig } from 'vitest/config';

/**
 * Vitest (промпт 1.1). Проекты соответствуют стратегии тестирования v3 §IX.5–IX.6:
 *   unit        — домен и сервисы (быстрые, без БД и сети)
 *   integration — БД/транспорт (появятся в промптах 1.4, 1.10, 1.11)
 *   arch        — архитектурные границы (промпт 1.3)
 *   contract    — Zod-схемы и порты (промпты 1.2, 1.7)
 *
 * resolve.conditions=['development'] заставляет vitest резолвить @mnemosin/*
 * в исходники (src/*.ts), а не в собранный dist — тесты не требуют предварительной сборки.
 */
export default defineConfig({
  resolve: { conditions: ['development'] },
  test: {
    passWithNoTests: true,
    environment: 'node',
    // include задаётся только в проектах: иначе каждый проект прогоняет все файлы.
    include: [],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['core/src/**', 'modules/*/src/**', 'infrastructure/*/src/**', 'gateways/*/src/**'],
      // Пороги из v3 §IX.5 включаются в промпте 1.13, когда появится код:
      // core >= 90%, modules >= 75%, adapters/gateways >= 60%.
    },
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      { extends: true, test: { name: 'integration', include: ['tests/integration/**/*.test.ts'] } },
      { extends: true, test: { name: 'arch', include: ['tests/arch/**/*.test.ts'] } },
      { extends: true, test: { name: 'contract', include: ['tests/contract/**/*.test.ts'] } },
    ],
  },
});
