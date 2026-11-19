import { CoreError, SESSION_TRANSITIONS, type SessionStatus } from '@mnemosin/contracts';

/**
 * Проверка перехода статуса сессии (промпт 1.6; v4).
 *
 * Источник истины — `SESSION_TRANSITIONS` из `@mnemosin/contracts` (D112).
 * Turn transitions удалены вместе с Turn Engine (REUSE_AUDIT_v4 §5.7): в v4
 * машина состояний хода отсутствует, остаётся lifecycle сессии/матча.
 *
 * Нарушение → `CoreError('CORE_INVALID_STATE_TRANSITION', meta:{entity:'session', from, to})`.
 */

export function allowedTransitions(from: SessionStatus): readonly SessionStatus[] {
  return SESSION_TRANSITIONS[from] ?? [];
}

export function assertTransition(from: SessionStatus, to: SessionStatus): void {
  const allowed = allowedTransitions(from);
  if (!allowed.includes(to)) {
    throw new CoreError(
      'CORE_INVALID_STATE_TRANSITION',
      `session: переход ${from} → ${to} запрещён (разрешены: ${allowed.join(', ') || '—'})`,
      { entity: 'session', from, to, allowed },
    );
  }
}
