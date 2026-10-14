/**
 * @mnemosin/core — доменное ядро.
 *
 * Промпт 1.4: ПОРТЫ (core/domain/ports) — интерфейсы репозиториев и UnitOfWork.
 * Промпт 1.5: СОБЫТИЯ (core/events) — шина, метрики-заглушка, запись в outbox;
 *             ЖУРНАЛ (core/turns) — JournalService.
 * Промпт 1.6: ДОМЕННЫЕ СЕРВИСЫ — машина состояний Turn/Session (domain/transition.ts),
 *             обвязка идемпотентных команд (domain/command.ts + порт CommandRunner),
 *             TurnService, SessionService, StateService, LocationService и фабрика
 *             createCoreServices.
 * Промпт 1.7–1.8: AI-порты, Rules-движок, сборка контекста Директора.
 *
 * Правило слоя (промпт 1.3): core импортирует только @mnemosin/contracts и node:*,
 * реализации портов подключаются снаружи (apps/server) — ядро не знает про SQLite/HTTP/AI.
 *
 * D219 (инвариант 13): StateService — единственный путь мутации GameState —
 * экспортируется ТОЛЬКО отсюда (barrel); потребители вне core ограничены
 * architecture-тестом tests/arch/state-service-access.test.ts.
 */
export const PACKAGE_ID = '@mnemosin/core';
export const IMPLEMENTED_IN_PROMPT = '1.4 (порты) → 1.5 (события, журнал) → 1.6 (доменные сервисы) → 1.7–1.8';

export * from './domain/ports/index.js';
export * from './domain/transition.js';
export * from './domain/command.js';
export * from './events/index.js';
export * from './turns/index.js';
export * from './session/index.js';
export * from './state/index.js';
export * from './locations/index.js';
export * from './services.js';
