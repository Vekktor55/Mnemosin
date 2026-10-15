import type { MessageId, SessionId, TurnId } from '@mnemosin/contracts';
import type { CommandRunner, CoreServices, UnitOfWork } from '@mnemosin/core';
/**
 * Зависимости модуля gm (промпт 1.9). Wiring собирает их в apps/server
 * (D161): доменные сервисы core — для команд жизненного цикла, ChatSystemPort —
 * структурный интерфейс chat-модуля (sendSystemMessage), чтобы публиковать
 * заметки PUBLIC_AFTER_COMMIT и системные сообщения GM, не импортируя модуль chat.
 */

/** Consumer-side порт chat (D227-образец): структурно совместим с ChatService. */
export interface ChatSystemPort {
  sendSystemMessage(input: {
    sessionId: SessionId;
    text: string;
    turnId?: TurnId | null;
    messageId?: MessageId;
    traceId?: string;
  }): Promise<{ messageId: MessageId; sequenceId: number; replayed: boolean }>;
}

export interface GmLog {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export interface GmServiceDeps {
  readonly uow: UnitOfWork;
  readonly guard: CommandRunner;
  readonly services: Pick<CoreServices, 'sessions' | 'turns' | 'locations' | 'journal' | 'state'>;
  readonly chat: ChatSystemPort;
  readonly logger?: GmLog;
  /**
   * Хук wiring'а после успешного lockTurn (промпт 1.10, D253): «замок закрыт —
   * запускай обработку хода». Wiring передаёт сюда turn.resolveTurn — вызов
   * КОМАНДОЙ (D115 сохранён: никакой подписки на TURN_LOCKED), fire-and-forget:
   * HTTP-ответ lock не ждёт AI-генерации (долгая операция вне запроса).
   */
  readonly afterLock?: (info: { turnId: TurnId; sessionId: SessionId; traceId: string }) => void;
}
