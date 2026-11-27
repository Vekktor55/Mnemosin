import { describe, expect, it } from 'vitest';

import { oneWayDelayMs, parseNetworkProfile, shouldDrop } from '@mnemosin/client';

describe('NetworkProfile (искусственный RTT/jitter/loss)', () => {
  it('парсит строку rtt/jitter/loss', () => {
    expect(parseNetworkProfile('rtt=150,jitter=30,loss=5')).toEqual({
      rttMs: 150,
      jitterMs: 30,
      lossRate: 0.05,
    });
  });

  it('пустая строка/null — профиль выключен', () => {
    expect(parseNetworkProfile(null)).toBeNull();
    expect(parseNetworkProfile('')).toBeNull();
    expect(parseNetworkProfile(undefined)).toBeNull();
  });

  it('некорректный loss (>100) отклоняется', () => {
    expect(parseNetworkProfile('rtt=150,loss=140')).toBeNull();
  });

  it('oneWayDelayMs = RTT/2 ± jitter (rng инжектируется)', () => {
    const profile = { rttMs: 150, jitterMs: 30, lossRate: 0 };
    expect(oneWayDelayMs(profile, () => 0.5)).toBeCloseTo(75, 10);
    expect(oneWayDelayMs(profile, () => 0)).toBeCloseTo(45, 10);
    expect(oneWayDelayMs(profile, () => 1)).toBeCloseTo(105, 10);
    // Задержка неотрицательна даже при большом jitter.
    expect(oneWayDelayMs({ rttMs: 10, jitterMs: 100, lossRate: 0 }, () => 0)).toBe(0);
  });

  it('shouldDrop решает по loss rate (rng инжектируется)', () => {
    const profile = { rttMs: 0, jitterMs: 0, lossRate: 0.2 };
    expect(shouldDrop(profile, () => 0.1)).toBe(true);
    expect(shouldDrop(profile, () => 0.9)).toBe(false);
  });
});
