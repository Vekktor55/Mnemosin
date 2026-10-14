/**
 * Внутренний barrel для dsl/ — позволяет rules.ts импортировать id-схемы
 * одной строкой и не создаёт цикла (dsl/index.ts не импортирует rules.ts).
 */
export { ObjectId, PlayerId, SessionId, Slug, FlagKey, LocationId, EventId, TurnId, ActionId, Scalar } from '../ids.js';
export { StatePathSchema, type StatePath } from './state-path.js';
