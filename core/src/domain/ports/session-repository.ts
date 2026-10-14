import type { Session, SessionStatus } from '@mnemosin/contracts';
import type { SessionId, TurnId } from '@mnemosin/contracts';

export interface SessionPhasePatch {
  readonly status?: SessionStatus;
  readonly currentTurnId?: TurnId | null;
  readonly updatedAt?: string;
}

export interface SessionRepository {
  insert(session: Session): Promise<void>;
  findById(sessionId: SessionId): Promise<Session | null>;
  /** D108: на сервере одна активная сессия — нужен быстрый поиск без полного скана. */
  findActive(): Promise<Session | null>;
  update(session: Session): Promise<void>;
  /** Частичный патч фазы (статус/текущий ход) — отдельный метод, чтобы не перезаписывать весь агрегат. */
  patchPhase(sessionId: SessionId, patch: SessionPhasePatch): Promise<void>;
  // Примечание: текущая локация живёт в GameState.worldState.currentLocationId (контракты),
  // а состав игроков — в Session.playerIds; оба меняются через StateRepository.updateWithVersion
  // и SessionRepository.update соответственно. Отдельных методов-«полузаписей» нет сознательно:
  // они создали бы второй путь записи в обход body_json (D199).
  listAll(): Promise<Session[]>;
}
