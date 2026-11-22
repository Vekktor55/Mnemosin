import { describe, expect, it } from 'vitest';

import { loadConfig } from '@mnemosin/config';
import { realtimeNetworkConfig } from '@mnemosin/gateway-ws';
import { prototypeRealtimeLimits } from '@mnemosin/server';

describe('P05-A application → WS config wiring', () => {
  it('пробрасывает configured auth/IP/payload/rate/heartbeat и не связывает recovery с heartbeat', () => {
    const config = loadConfig({
      cwd: process.cwd(),
      ignoreDotenv: true,
      version: '0.0.0-test',
      env: {
        NODE_ENV: 'test',
        DATABASE_URL: 'file:./data/unit-test.sqlite',
        JWT_SECRET: 'app-test-secret-0123456789abcdef0123456789abcdef',
        LOG_LEVEL: 'silent',
      },
    });
    const mapped = prototypeRealtimeLimits({
      ...config.limits,
      wsAuthTimeoutMs: 1_234,
      wsMaxConnectionsPerIp: 7,
      wsMaxPayloadBytes: 9_999,
      wsRatePerConnection: { ...config.limits.wsRatePerConnection, DEFAULT: 33 },
      heartbeat: { intervalMs: 20_000, idleTimeoutMs: 45_000 },
    });
    const resolved = realtimeNetworkConfig(mapped);

    expect(resolved).toMatchObject({
      wsAuthTimeoutMs: 1_234,
      wsMaxConnectionsPerIp: 7,
      wsMaxPayloadBytes: 9_999,
      inputRatePerSecond: 33,
      heartbeat: { intervalMs: 20_000, idleTimeoutMs: 45_000 },
      schedulerRecoveryIntervalMs: 50,
      // NET-03 prototype single-controller не наследует старое YAML=4.
      wsMaxConnectionsPerPlayer: 1,
    });
  });
});
