import { defineConfig } from 'vitest/config';

/**
 * Vitest (v3 §IX.5–IX.6): unit — unit tests, integration — integration tests,
 * arch — architecture tests, contract — contract tests.
 *
 * resolve.conditions=['development'] · vitest @mnemosin/*
 * РІ src/*.ts, dist — dist.
 */
export default defineConfig({
  resolve: { conditions: ['development'] },
  test: {
    environment: 'node',
    include: [],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Переходный этап v4: строгий порог остаётся на активном ядре (core),
      // замороженные/немигрированные пакеты без тестов исключены из расчёта
      // до их подключения в P04–P09 (modules/*, gateways/*, database CLI).
      include: ['core/src/**', 'infrastructure/*/src/**'],
      exclude: ['modules/*/src/**', 'gateways/*/src/**', 'infrastructure/*/src/cli/**'],
      thresholds: {
        'core/src/**': { lines: 90, statements: 90, branches: 90, functions: 90 },
        'infrastructure/*/src/**': { lines: 60, statements: 60, branches: 60, functions: 60 },
      },
    },
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      { extends: true, test: { name: 'integration', include: ['tests/integration/**/*.test.ts'] } },
      { extends: true, test: { name: 'arch', include: ['tests/arch/**/*.test.ts'] } },
      { extends: true, test: { name: 'contract', include: ['tests/contract/**/*.test.ts'] } },
    ],
  },
});
