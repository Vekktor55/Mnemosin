/**
 * Экспоненциальный backoff реконнекта (промпт 1.12, п.2; SPEC §6.4).
 *
 * Значения по умолчанию ЗЕРКАЛЯТ config/limits.yaml (reconnect.*) — серверный
 * конфиг клиенту не отдаётся, поэтому константы продублированы здесь и
 * проверяются unit-тестом tests/unit/client-ws.test.ts. Расхождение с
 * limits.yaml — дефект (единый источник: лимиты этапа 1).
 *
 *   base 500 мс · factor 2 · cap 15000 мс · jitter ±20% · maxAttempts 8
 */

export interface ReconnectLimits {
  readonly baseMs: number;
  readonly factor: number;
  readonly capMs: number;
  readonly jitter: number;
  readonly maxAttempts: number;
}

export const DEFAULT_RECONNECT_LIMITS: ReconnectLimits = Object.freeze({
  baseMs: 500,
  factor: 2,
  capMs: 15_000,
  jitter: 0.2,
  maxAttempts: 8,
});

export interface HeartbeatLimits {
  readonly intervalMs: number;
  readonly idleTimeoutMs: number;
}

/** Зеркало config/limits.yaml heartbeat.* (D277: серверный интервал 20 с). */
export const DEFAULT_HEARTBEAT_LIMITS: HeartbeatLimits = Object.freeze({
  intervalMs: 20_000,
  idleTimeoutMs: 45_000,
});

/**
 * Задержка перед попыткой номер `attempt` (1-based):
 *   min(cap, base * factor^(attempt-1)) ± jitter.
 * Чистая функция (random и now инжектируются) — покрыта unit-тестом.
 */
export function backoffDelayMs(attempt: number, limits: ReconnectLimits = DEFAULT_RECONNECT_LIMITS): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const raw = Math.min(limits.capMs, limits.baseMs * Math.pow(limits.factor, safeAttempt - 1));
  const span = raw * limits.jitter;
  const jitter = span * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(raw + jitter));
}

/**
 * Детерминированный вариант для тестов: те же границы, но `random` задаёт
 * jitter явно (0..1, как Math.random).
 */
export function backoffDelayWith(
  attempt: number,
  random: number,
  limits: ReconnectLimits = DEFAULT_RECONNECT_LIMITS,
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const clamped = Math.min(1, Math.max(0, random));
  const raw = Math.min(limits.capMs, limits.baseMs * Math.pow(limits.factor, safeAttempt - 1));
  const span = raw * limits.jitter;
  return Math.max(0, Math.round(raw + span * (clamped * 2 - 1)));
}
