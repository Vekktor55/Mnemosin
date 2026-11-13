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
      include: ['core/src/**', 'modules/*/src/**', 'infrastructure/*/src/**', 'gateways/*/src/**'],
      thresholds: {
        'core/src/**': { lines: 90, statements: 90, branches: 90, functions: 90 },
        'modules/*/src/**': { lines: 75, statements: 75, branches: 75, functions: 75 },
        'infrastructure/*/src/**': { lines: 60, statements: 60, branches: 60, functions: 60 },
        'gateways/*/src/**': { lines: 60, statements: 60, branches: 60, functions: 60 },
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
