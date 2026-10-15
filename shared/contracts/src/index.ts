/**
 * @mnemosin/contracts — единственный источник истины о типах, сообщениях и ошибках
 * (D112). Ни один другой пакет не объявляет доменные схемы у себя.
 *
 * Версия повышается при любом изменении схем (docs/CONTRACTS_CHANGELOG.md):
 *   0.1.0 — каркас (промпт 1.1)
 *   0.2.0 — промпт 1.2: полный набор схем + поправки K1–K16 по данным мира v1
 *   0.2.1 — 14-й ключ narrative_guidance (conditionNote, D191); env-идентификаторы
 *           провайдеров как строки вместо enum (D192, критерий A1.14)
 *   0.5.0 — промпт 1.8: JournalKind += 'ending_reached' (D237);
 *           промпт 1.9: CommandName += sendPublicMessage/sendPrivateMessage/
 *           sendSystemMessage/sendGMMessage/addNote/grantKnowledge (D246),
 *           EVENT_SUBSCRIBERS.TURN_COMMITTED += 'gm' (D245, F-3.8)
 */
export const CONTRACTS_VERSION = '0.5.0';

// --- базовые
export * from './ids.js';
export * from './time.js';
export * from './errors.js';
export * from './capability.js';
export * from './module.js';

// --- домен
export * from './domain/session.js';
export * from './domain/player.js';
export * from './domain/turn.js';
export * from './domain/action.js';
export * from './domain/state.js';
export * from './domain/location.js';
export * from './domain/visual.js';
export * from './domain/guidance.js';
export * from './domain/resolution.js';
export * from './domain/gm.js';
export * from './domain/jobs.js';
export * from './domain/journal.js';
export * from './domain/chat.js';
export * from './domain/snapshot.js';

// --- DSL
export * from './dsl/state-path.js';
export * from './dsl/conditions.js';
export * from './dsl/triggers.js';
export * from './dsl/effects.js';
export * from './dsl/events.js';
export * from './dsl/rules.js';

// --- события
export * from './events/payloads.js';
export * from './events/subscribers.js';

// --- AI / транспорт
export * from './ai.js';
export * from './transport/views.js';
export * from './transport/ws.js';
export * from './transport/http.js';

// --- конфигурация (D162): доменные понятия CapabilitySchema и ProviderPolicySchema
//     определены в ./capability.js; env-схема и limits.yaml остаются в
//     @mnemosin/config, который ИМПОРТИРУЕТ их отсюда (contracts — leaf).
