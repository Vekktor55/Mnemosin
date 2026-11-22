/**
 * Искусственный сетевой профиль (RTT/jitter/loss) для тестового окружения.
 *
 * В production не активен: включается только явно (query-параметр или
 * debug-хук в E2E). Проверять плавность только на идеальном localhost нельзя
 * (IMPLEMENTATION_ROADMAP P05, п.8).
 *
 * Формат строки: `rtt=150,jitter=30,loss=5` (rtt/jitter в мс, loss в %).
 */

export interface NetworkProfile {
  readonly rttMs: number;
  readonly jitterMs: number;
  readonly lossRate: number; // 0..1
}

function findParam(parts: readonly string[], key: string): number | null {
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== key) continue;
    const value = Number.parseFloat(part.slice(eq + 1).trim());
    if (Number.isFinite(value)) return value;
  }
  return null;
}

export function parseNetworkProfile(raw: string | null | undefined): NetworkProfile | null {
  if (raw === null || raw === undefined || raw.length === 0) return null;
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const rttMs = findParam(parts, 'rtt') ?? 0;
  const jitterMs = findParam(parts, 'jitter') ?? 0;
  const lossPercent = findParam(parts, 'loss') ?? 0;
  if (rttMs < 0 || jitterMs < 0 || lossPercent < 0 || lossPercent > 100) return null;
  return { rttMs, jitterMs, lossRate: lossPercent / 100 };
}

/** Односторонняя задержка (RTT/2 ± jitter); неотрицательна. */
export function oneWayDelayMs(profile: NetworkProfile, rng: () => number = Math.random): number {
  const jitter = profile.jitterMs * (rng() * 2 - 1);
  return Math.max(0, profile.rttMs / 2 + jitter);
}

/** Решение об отбрасывании кадра по loss rate. */
export function shouldDrop(profile: NetworkProfile, rng: () => number = Math.random): boolean {
  return rng() < profile.lossRate;
}
