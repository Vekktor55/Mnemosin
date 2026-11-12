import type { SessionId, TurnId } from '@mnemosin/contracts';

/**
 * TurnServicePort — узкий порт зависимостей SessionService от Turn Engine.
 * Определяется в Domain Ports, а не в файле фабрики сервисов.
 *
 * Сессия зависит только от операции openTurn(), остальная функциональность
 * Turn Engine реализована снаружи (в production-адаптере или gateway'ах).
 */
export interface TurnServicePort {
  /** Открывает ход для сессии.
   *  Возвращает turnId и номер хода.
   */
  openTurn(input: { sessionId: SessionId; idempotencyKey: string; traceId: string }): Promise<{
    turnId: TurnId;
    number: number;
  }>;
}
