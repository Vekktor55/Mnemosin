/**
 * @mnemosin/module-session — декларативный контракт модуля сессии (промпт 1.9, п.8).
 *
 * Реализация команд этапа 1 — core/SessionService (промпт 1.6, D224): лобби и
 * партия — домен. Контракт нужен modules-registry (F-8.3: 9 модулей) и
 * транспорту 1.10 (поверхность команд и событий).
 */
export {
  sessionContract,
  CreateSessionInputSchema,
  CreateSessionOutputSchema,
  JoinSessionInputSchema,
  JoinSessionOutputSchema,
  LeaveSessionInputSchema,
  StartSessionInputSchema,
  StartSessionOutputSchema,
  CreateCharacterInputSchema,
  type CreateSessionInput,
  type CreateSessionOutput,
  type JoinSessionInput,
  type JoinSessionOutput,
  type LeaveSessionInput,
  type StartSessionInput,
  type StartSessionOutput,
  type CreateCharacterInput,
} from './contract.js';

export const PACKAGE_ID = '@mnemosin/module-session';
export const IMPLEMENTED_IN_PROMPT = '1.6 (сервис в core) / 1.9 (контракт для реестра)';
