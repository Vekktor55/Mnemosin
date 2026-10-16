import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import svelteParser from 'svelte-eslint-parser';

/**
 * ESLint (flat config). Промпт 1.3: границы зависимостей продублированы
 * на уровне линтера, чтобы нарушение ловилось в редакторе до CI.
 * Промпт 1.12: .svelte-файлы клиента парсятся svelte-eslint-parser (вложенный
 * <script lang="ts"> — typescript-eslint parser); правило no-restricted-imports
 * продолжает ловить нарушения инварианта 15 и в компонентах.
 *
 * Три уровня контроля границ (v3 §IX.6):
 *   1. eslint no-restricted-imports  — мгновенная обратная связь;
 *   2. dependency-cruiser            — граф по всем пакетам (npm run arch:cruiser);
 *   3. tests/arch/*.test.ts          — исполняемые правила + внешние пакеты + манифест core/.
 */

const VENDORS_TRANSPORT = ['fastify', '@fastify/*'];
const VENDORS_DB = ['drizzle-orm', 'drizzle-orm/*', 'better-sqlite3'];
const VENDORS_LOGGING = ['pino', 'pino-pretty'];
const VENDORS_AUTH = ['jose'];

/** Пакеты, которые нельзя импортировать из ядра (инварианты 1–3). */
const FORBIDDEN_IN_CORE = [
  '@mnemosin/database',
  '@mnemosin/ai',
  '@mnemosin/logging',
  '@mnemosin/config',
  '@mnemosin/gateway-http',
  '@mnemosin/gateway-ws',
  '@mnemosin/server',
  '@mnemosin/client',
  ...VENDORS_TRANSPORT,
  ...VENDORS_DB,
  ...VENDORS_LOGGING,
  ...VENDORS_AUTH,
  'prom-client',
];

function restricted(patterns, message) {
  return ['error', { patterns: [{ group: patterns, message }] }];
}

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/dist-types/**', '**/node_modules/**', '**/coverage/**', 'data/**', 'client/dist/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { process: 'readonly', console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly' },
    },
    rules: {
      // Инвариант: никакого `any` на границе модуля (v3 §I.4).
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // --- границы по слоям (docs/ARCHITECTURE.md §3)
  {
    files: ['shared/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': restricted(
        [...FORBIDDEN_IN_CORE, '@mnemosin/module-*', '@mnemosin/core', '@mnemosin/core/*', 'dotenv', 'yaml'],
        'contracts — leaf-пакет: разрешены только zod и node:crypto (D189, правило contracts-leaf)',
      ),
    },
  },
  {
    files: ['core/**/*.ts'],
    rules: {
      'no-restricted-imports': restricted(
        FORBIDDEN_IN_CORE,
        'core не импортирует инфраструктуру, модули, транспорт и вендоров — только @mnemosin/contracts и zod (инварианты 1–3)',
      ),
    },
  },
  {
    files: ['modules/**/*.ts'],
    rules: {
      'no-restricted-imports': restricted(
        [
          '@mnemosin/module-*',
          '@mnemosin/database',
          '@mnemosin/gateway-http',
          '@mnemosin/gateway-ws',
          '@mnemosin/server',
          ...VENDORS_DB,
          ...VENDORS_TRANSPORT,
        ],
        'модули не импортируют БД, транспорт и другие модули (D161): данные — через порты core, wiring — в apps/server',
      ),
    },
  },
  {
    files: ['infrastructure/**/*.ts'],
    rules: {
      'no-restricted-imports': restricted(
        [
          '@mnemosin/module-*',
          '@mnemosin/gateway-http',
          '@mnemosin/gateway-ws',
          '@mnemosin/server',
          '@mnemosin/client',
          '@mnemosin/core/domain/services',
          '@mnemosin/core/domain/state',
        ],
        'адаптер знает порт, но не модуль и не доменные сервисы ядра',
      ),
    },
  },
  {
    files: ['gateways/**/*.ts'],
    rules: {
      'no-restricted-imports': restricted(
        [
          '@mnemosin/database',
          ...VENDORS_DB,
          '@mnemosin/core/domain/services',
          '@mnemosin/core/domain/state',
          '@mnemosin/client',
        ],
        'транспорт не содержит игровой логики (инвариант 14): только контракты и команды модулей',
      ),
    },
  },
  {
    files: ['client/**/*.ts', 'client/**/*.svelte'],
    rules: {
      'no-restricted-imports': restricted(
        [
          '@mnemosin/core',
          '@mnemosin/core/*',
          '@mnemosin/module-*',
          '@mnemosin/database',
          '@mnemosin/gateway-http',
          '@mnemosin/gateway-ws',
          '@mnemosin/config',
          '@mnemosin/logging',
          '@mnemosin/ai',
          '@mnemosin/server',
          ...VENDORS_DB,
        ],
        'клиент импортирует только @mnemosin/contracts (инвариант 15, v3 §IX.6)',
      ),
    },
  },
  {
    // Промпт 1.12: Svelte-компоненты клиента. Парсер — svelte-eslint-parser
    // (TS внутри <script lang="ts">); no-undef выключен — неопределённые
    // идентификаторы ловят TypeScript и svelte-check (как в остальных *.ts).
    files: ['client/**/*.svelte'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.svelte'],
      },
    },
    rules: {
      'no-undef': 'off',
    },
  },

  // --- тесты и инструменты
  {
    files: ['tools/**/*.mjs', 'tests/**/*.ts', '**/*.test.ts', 'e2e/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.mjs', '**/*.js', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        AbortController: 'readonly',
        module: 'writable',
        require: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: { 'no-console': 'off' },
  },
);
