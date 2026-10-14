import {
  CoreError,
  SESSION_TRANSITIONS,
  TURN_TRANSITIONS,
  TURN_TRANSITION_TABLE,
  type SessionStatus,
  type TurnStatus,
} from '@mnemosin/contracts';

/**
 * Универсальная проверка перехода статуса (промпт 1.6, критерий A1.6; закрывает B-07, F-3.5).
 *
 * Источник истины — таблицы из `@mnemosin/contracts` (D112):
 *  - `TURN_TRANSITIONS` (v3 §II.5 + отклонение SPEC §3.2: REVIEW→OPEN для retry, F-3.1);
 *  - `SESSION_TRANSITIONS` (SPEC §3.3; в v3 машины состояний сессии не было — F-3.5).
 *
 * Нарушение → `CoreError('CORE_INVALID_STATE_TRANSITION', meta:{entity, from, to})`.
 * Транспорт маппит код в 409 CONFLICT (CORE_TO_PUBLIC), клиент — REFRESH_PROJECTION.
 */

export type TransitionEntity = 'turn' | 'session';

export function allowedTransitions(entity: 'turn', from: TurnStatus): readonly TurnStatus[];
export function allowedTransitions(entity: 'session', from: SessionStatus): readonly SessionStatus[];
export function allowedTransitions(entity: TransitionEntity, from: string): readonly string[] {
  return entity === 'turn'
    ? (TURN_TRANSITIONS[from as TurnStatus] ?? [])
    : (SESSION_TRANSITIONS[from as SessionStatus] ?? []);
}

export function assertTransition(entity: 'turn', from: TurnStatus, to: TurnStatus): void;
export function assertTransition(entity: 'session', from: SessionStatus, to: SessionStatus): void;
export function assertTransition(entity: TransitionEntity, from: string, to: string): void {
  const allowed = allowedTransitions(entity as 'turn', from as TurnStatus) as readonly string[];
  if (!allowed.includes(to)) {
    throw new CoreError(
      'CORE_INVALID_STATE_TRANSITION',
      `${entity}: переход ${from} → ${to} запрещён (разрешены: ${allowed.join(', ') || '—'})`,
      { entity, from, to, allowed },
    );
  }
}

/**
 * Строка таблицы переходов хода по триггеру (данные — `TURN_TRANSITION_TABLE`).
 * `null`, если триггер из статуса `from` не предусмотрен. Используется
 * `TurnService.transition()` — механизмом, которым движок хода (промпт 1.8)
 * и GM-ревью проводят ход по полному пути OPEN→LOCKED→PROCESSING→REVIEW→COMMITTED.
 */
export function turnTransitionRow(
  from: TurnStatus,
  trigger: (typeof TURN_TRANSITION_TABLE)[number]['trigger'],
): (typeof TURN_TRANSITION_TABLE)[number] | null {
  return TURN_TRANSITION_TABLE.find((row) => row.from === from && row.trigger === trigger) ?? null;
}
