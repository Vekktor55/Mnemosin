import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  backoffDelayMs,
  backoffDelayWith,
  DEFAULT_HEARTBEAT_LIMITS,
  DEFAULT_RECONNECT_LIMITS,
  IDLE_SNAPSHOT,
  wsSubprotocol,
  WSClient,
} from '@mnemosin/client';

/**
 * Клиентские инварианты P05-B (v4 протокол): backoff-параметры реконнекта и
 * lifecycle WSClient поверх fake WebSocket. Legacy offline-очередь (v3
 * ACTION_SUBMIT/CHAT_*) удалена вместе с legacy-ws.ts: movement inputs после
 * reconnect никогда не replay (новый inputStreamId/connectionEpoch).
 */

const UUID = '00000000-0000-4000-8000-000000000000';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readonly protocols: readonly string[];
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emitMessage(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

interface Envelope {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

function envelope(type: string, payload: Record<string, unknown>): Envelope {
  return { protocolVersion: 'v1', schemaVersion: 1, messageId: UUID, type, payload };
}

function welcome(overrides: Record<string, unknown> = {}): Envelope {
  return envelope('connection:welcome', {
    protocolVersion: 'v1',
    serverVersion: 'test',
    contractsVersion: 'test',
    matchId: UUID,
    sessionId: UUID,
    connectionId: UUID,
    connectionEpoch: 1,
    actorId: UUID,
    actorType: 'player',
    inputStreamId: UUID,
    projectionKind: 'player',
    permissions: ['scene:input', 'scene:resync'],
    isReconnect: false,
    supportedFeatures: ['scene:keyframe', 'scene:delta'],
    ...overrides,
  });
}

function keyframe(overrides: Record<string, unknown> = {}): Envelope {
  return envelope('scene:keyframe', {
    matchId: UUID,
    worldEpoch: 1,
    snapshotId: UUID,
    sceneSequence: 1,
    simulationTick: 1,
    serverTimeMs: 0,
    projectionRevision: 1,
    worldPackVersion: '1.0.0',
    projection: {
      projectionKind: 'player',
      entities: [],
      objects: [],
      environment: { worldId: UUID, floorId: UUID, worldSpaceId: UUID },
    },
    ...overrides,
  });
}

function delta(overrides: Record<string, unknown> = {}): Envelope {
  return envelope('scene:delta', {
    matchId: UUID,
    worldEpoch: 1,
    sceneSequence: 2,
    baseSceneSequence: 1,
    simulationTick: 2,
    serverTimeMs: 50,
    projectionRevision: 1,
    projectionKind: 'player',
    entityUpserts: [],
    entityRemovals: [],
    objectUpserts: [],
    objectRemovals: [],
    ...overrides,
  });
}

function sentTypes(fake: FakeWebSocket): string[] {
  return fake.sent.map((raw) => (JSON.parse(raw) as { type: string }).type);
}

describe('reconnect backoff (P05-B)', () => {
  it('дефолты зеркалируют config/limits.yaml', () => {
    expect(DEFAULT_RECONNECT_LIMITS).toEqual({ baseMs: 500, factor: 2, capMs: 15_000, jitter: 0.2, maxAttempts: 8 });
    expect(DEFAULT_HEARTBEAT_LIMITS).toEqual({ intervalMs: 20_000, idleTimeoutMs: 45_000 });
  });

  it('экспоненциальный рост с cap 15000 и jitter ±20%', () => {
    expect(backoffDelayWith(1, 0.5)).toBe(500);
    expect(backoffDelayWith(2, 0.5)).toBe(1000);
    expect(backoffDelayWith(3, 0.5)).toBe(2000);
    expect(backoffDelayWith(4, 0.5)).toBe(4000);
    expect(backoffDelayWith(5, 0.5)).toBe(8000);
    expect(backoffDelayWith(6, 0.5)).toBe(15_000);
    expect(backoffDelayWith(8, 0.5)).toBe(15_000);
  });

  it('jitter не выходит за ±20% от базовой задержки', () => {
    for (const attempt of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const raw = Math.min(15_000, 500 * Math.pow(2, attempt - 1));
      const low = backoffDelayWith(attempt, 0);
      const high = backoffDelayWith(attempt, 1);
      expect(low).toBe(Math.max(0, Math.round(raw * 0.8)));
      expect(high).toBe(Math.round(raw * 1.2));
      for (let i = 0; i < 30; i += 1) {
        const value = backoffDelayMs(attempt);
        expect(value).toBeGreaterThanOrEqual(low);
        expect(value).toBeLessThanOrEqual(high);
      }
    }
  });

  it('суммарное окно 8 попыток ≥ ~60 с до FAILED', () => {
    const total = [1, 2, 3, 4, 5, 6, 7, 8].reduce((sum, attempt) => sum + backoffDelayWith(attempt, 0.5), 0);
    expect(total).toBeGreaterThanOrEqual(50_000);
  });
});

describe('WSClient v4 lifecycle (fake WebSocket)', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('wsSubprotocol и IDLE_SNAPSHOT', () => {
    expect(wsSubprotocol('jwt-token')).toBe('mnemosin.v1.jwt-token');
    expect(IDLE_SNAPSHOT.status).toBe('IDLE');
    expect(IDLE_SNAPSHOT.attempt).toBe(0);
  });

  it('welcome → client-ready → keyframe → ready; RTT и connectionInfo', () => {
    const client = new WSClient({ url: 'ws://x/ws', token: 't', heartbeat: { intervalMs: 60_000 } });
    client.connect();
    const fake = FakeWebSocket.instances[0];
    expect(fake).toBeDefined();
    expect(fake?.protocols).toEqual(['mnemosin.v1.t']);

    fake?.emitOpen();
    fake?.emitMessage(welcome());
    // §4.2 шаг 7: `connection:client-ready` уходит ЯВНО — только когда клиент
    // зарегистрировал handlers и готов принять keyframe. Авто-отправка в
    // обработчике welcome приводила к потере первого scene:keyframe.
    expect(sentTypes(fake as FakeWebSocket)).not.toContain('connection:client-ready');
    expect(client.sendClientReady()).toBe(true);
    expect(sentTypes(fake as FakeWebSocket)).toContain('connection:client-ready');
    // Повторный вызов на том же lifecycle не дублирует сообщение.
    expect(client.sendClientReady()).toBe(true);
    expect(sentTypes(fake as FakeWebSocket).filter((type) => type === 'connection:client-ready')).toHaveLength(1);

    fake?.emitMessage(keyframe());
    fake?.emitMessage(envelope('connection:ready', {}));
    expect(client.isReady()).toBe(true);
    expect(client.getSnapshot().status).toBe('CONNECTED');
    expect(client.getConnectionInfo()?.inputStreamId).toBe(UUID);
    expect(client.getConnectionInfo()?.lastSceneSequence).toBe(1);
    expect(client.getConnectionInfo()?.worldEpoch).toBe(1);

    client.close();
  });

  it('sequence gap в delta → scene:resync', () => {
    const client = new WSClient({ url: 'ws://x/ws', token: 't', heartbeat: { intervalMs: 60_000 } });
    client.connect();
    const fake = FakeWebSocket.instances[0] as FakeWebSocket;
    fake.emitOpen();
    fake.emitMessage(welcome());
    fake.emitMessage(keyframe());
    fake.emitMessage(envelope('connection:ready', {}));

    fake.emitMessage(delta({ sceneSequence: 5, baseSceneSequence: 3 }));
    const types = sentTypes(fake);
    expect(types).toContain('scene:resync');
    const resync = fake.sent
      .map((raw) => JSON.parse(raw) as { type: string; payload: { reason?: string } })
      .find((m) => m.type === 'scene:resync');
    expect(resync?.payload.reason).toBe('sequence_gap');

    client.close();
  });

  it('смена worldEpoch в delta → scene:resync', () => {
    const client = new WSClient({ url: 'ws://x/ws', token: 't', heartbeat: { intervalMs: 60_000 } });
    client.connect();
    const fake = FakeWebSocket.instances[0] as FakeWebSocket;
    fake.emitOpen();
    fake.emitMessage(welcome());
    fake.emitMessage(keyframe());
    fake.emitMessage(envelope('connection:ready', {}));

    fake.emitMessage(delta({ sceneSequence: 2, baseSceneSequence: 1, worldEpoch: 2 }));
    const resync = fake.sent.map((raw) => JSON.parse(raw) as { type: string }).find((m) => m.type === 'scene:resync');
    expect(resync).toBeDefined();

    client.close();
  });

  it('reconnect: новый connectionEpoch/inputStreamId приходят из welcome', () => {
    const client = new WSClient({ url: 'ws://x/ws', token: 't', heartbeat: { intervalMs: 60_000 } });
    client.connect();
    const fake = FakeWebSocket.instances[0] as FakeWebSocket;
    fake.emitOpen();
    fake.emitMessage(welcome({ connectionEpoch: 1, inputStreamId: '00000000-0000-4000-8000-000000000001' }));
    const firstStream = client.getConnectionInfo()?.inputStreamId;
    expect(firstStream).toBe('00000000-0000-4000-8000-000000000001');

    fake.emitMessage(
      welcome({
        connectionEpoch: 2,
        inputStreamId: '00000000-0000-4000-8000-000000000002',
        isReconnect: true,
      }),
    );
    expect(client.getConnectionInfo()?.connectionEpoch).toBe(2);
    expect(client.getConnectionInfo()?.inputStreamId).toBe('00000000-0000-4000-8000-000000000002');
    expect(client.getConnectionInfo()?.isReconnect).toBe(true);

    client.close();
  });
});
