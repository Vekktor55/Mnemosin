/**
 * @mnemosin/jobs — фоновые джобы (промпт 1.5).
 *
 * Scheduler — интервальный планировщик без внешних зависимостей:
 * try/catch на каждый запуск, метрика длительности, защита от перекрытия,
 * graceful stop() с ожиданием текущих запусков.
 *
 * registerStandardJobs — словарь стандартных джобов Stage 1
 * (cleanupIdempotency, outboxPublisher, presenceSweep); сами обработчики
 * передаёт wiring (apps/server) — пакет не знает про БД и outbox.
 */
export const PACKAGE_ID = '@mnemosin/jobs';
export const IMPLEMENTED_IN_PROMPT = '1.5';

export * from './scheduler.js';
export * from './standard-jobs.js';
