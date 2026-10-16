/**
 * dependency-cruiser: автоматический контроль архитектурных границ.
 * Основание: v3 §I.3 (инварианты 1–5, 14–15), §I.4 (антипаттерны), §IX.6.
 * Матрица зависимостей — docs/ARCHITECTURE.md §3; дублирующий контроль —
 * tests/arch/boundaries.test.ts (он же проверяет ВНЕШНИЕ пакеты: cruiser
 * их не видит из-за includeOnly).
 *
 * Запуск: npm run arch:cruiser
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'contracts-leaf',
      comment: 'contracts не зависит ни от кого (D189: даже config импортирует схемы отсюда)',
      severity: 'error',
      from: { path: '^shared/contracts/src' },
      to: { path: '^(core|modules|infrastructure|gateways|apps|client)/' },
    },
    {
      name: 'core-no-infra',
      comment: 'инварианты 1–3: core не знает инфраструктуру, модули, транспорт и клиент',
      severity: 'error',
      from: { path: '^core/src' },
      to: { path: '^(infrastructure|modules|gateways|apps|client)/' },
    },
    {
      name: 'modules-no-infra',
      comment: 'модули работают через порты core, а не через БД/транспорт (D161, инвариант 8)',
      severity: 'error',
      from: { path: '^modules/' },
      to: { path: '^(infrastructure|gateways|apps|client)/' },
    },
    {
      name: 'modules-no-each-other',
      comment: 'модуль не импортирует другой модуль: wiring только в apps/server (D161)',
      severity: 'error',
      // Промпт 1.7: добавлен to.path '^modules/' — без него pathNot '^$1/' запрещал
      // ЛЮБЫЕ внешние зависимости модулей (включая разрешённые contracts/core из
      // матрицы §3). До 1.7 все модули были заглушками без импортов — дефект не проявлялся.
      from: { path: '^(modules/[^/]+)/' },
      to: { path: '^modules/', pathNot: '^$1/' },
    },
    {
      name: 'infrastructure-no-modules',
      comment: 'адаптер знает порт, но не модуль и не транспорт',
      severity: 'error',
      from: { path: '^infrastructure/' },
      to: { path: '^(modules|gateways|apps|client)/' },
    },
    {
      name: 'gateways-no-domain',
      comment:
        'инвариант 14: транспорт не содержит игровой логики и не ходит в core/БД. ' +
        'Исключение (промпт 1.10, D254): core/src/domain/ports — type-only интерфейсы DI ' +
        "(инъекции wiring'а), согласовано с LAYER_RULES (tests/arch/helpers.ts)",
      severity: 'error',
      from: { path: '^gateways/' },
      to: { path: '^(core/src|infrastructure/database|client)/', pathNot: '^core/src/domain/ports/' },
    },
    {
      name: 'client-contracts-only',
      comment: 'инвариант 15: клиент импортирует только @mnemosin/contracts',
      severity: 'error',
      from: { path: '^client/src' },
      to: { path: '^(core|modules|infrastructure|gateways|apps)/' },
    },
    {
      name: 'no-circular',
      comment: 'циклические зависимости запрещены во всех пакетах',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans-in-core',
      comment: 'в core/ не должно быть неиспользуемых модулей-одиночек (кроме index.ts)',
      severity: 'warn',
      from: { path: '^core/src/(?!index\\.ts)', orphan: true },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|dist-types|node_modules|coverage|data)(/|$)|\\.svelte$' },
    // Промпт 1.12: клиент содержит .svelte-компоненты — dependency-cruiser не
    // умеет их парсить (svelte-синтаксис $store). Границы .svelte контролируют
    // eslint (svelte-eslint-parser + no-restricted-imports) и arch-тест
    // «клиент импортирует только контракты»; cruiser остаётся на TS/JS:
    // .svelte исключены из графа (импорты на них — вне правил cruiser).
    // exclude: { path: ... } ниже расширен на \.svelte$.
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      // 'development' — первое условие в exports: резолвит @mnemosin/* в src/*.ts,
      // поэтому правила работают по исходникам, а не по собранному dist.
      conditionNames: ['development', 'import', 'node', 'default'],
      extensions: ['.ts', '.js', '.mjs', '.json'],
    },
    includeOnly: '^(shared|core|modules|infrastructure|gateways|apps|client)/',
    reporterOptions: { dot: { collapsePattern: '^(shared|core|modules|infrastructure|gateways|apps|client)/[^/]+' } },
  },
};
