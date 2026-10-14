import { z } from 'zod';
import { IsoDateTime } from '../time.js';
import { PlayerId, SessionId, TurnId } from '../ids.js';

/**
 * Session (v3 §II.2). Отклонение от v3 (F-1.16): `currentLocationId` удалён —
 * единственный источник истины о положении группы — `worldState.currentLocationId`.
 */

export const SessionStatus = z.enum(['LOBBY', 'ACTIVE', 'PAUSED', 'ENDED']);
export type SessionStatus = z.infer<typeof SessionStatus>;

/**
 * Таблица переходов (docs/SPEC_STAGE1.md §3.3). Заполняет пробел v3: машина
 * состояний сессии там отсутствовала (F-3.5).
 */
export const SESSION_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = Object.freeze({
  LOBBY: ['ACTIVE', 'ENDED'],
  ACTIVE: ['PAUSED', 'ENDED'],
  PAUSED: ['ACTIVE', 'ENDED'],
  ENDED: [],
});

export function isSessionTransitionAllowed(from: SessionStatus, to: SessionStatus): boolean {
  return SESSION_TRANSITIONS[from].includes(to);
}

export const SessionSchema = z.object({
  sessionId: SessionId,
  title: z.string().min(1).max(120),
  status: SessionStatus,
  playerIds: z.array(PlayerId).max(12),
  gmPlayerId: PlayerId,
  currentTurnId: TurnId.nullable(),
  /** Версия world-pack, которым инстанцирована сессия (D164/D175). */
  worldPackId: z.string().max(60).nullable(),
  worldPackVersion: z.string().max(20).nullable(),
  /** D108: одна активная сессия; завершённая уходит в архив, а не удаляется. */
  archivedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Session = z.infer<typeof SessionSchema>;
