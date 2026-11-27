import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CONTRACTS_VERSION,
  MatchId,
  ParticipantId,
  SessionId,
  WsClientEnvelopeSchema,
  WsServerEnvelopeSchema,
  type WsClientEnvelope,
  type WsServerEnvelope,
} from '@mnemosin/contracts';
import { loadConfig } from '@mnemosin/config';
import { parseWorldPack } from '@mnemosin/core';
import { createLogger } from '@mnemosin/logging';
import { buildApp, createPrototypeWsGateway } from '@mnemosin/server';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const playerOne = ParticipantId.parse('00000000-0000-4000-8000-000000000101');
const playerTwo = ParticipantId.parse('00000000-0000-4000-8000-000000000102');
const matchId = MatchId.parse('00000000-0000-4000-8000-000000000103');
const sessionId = SessionId.parse(matchId);
const pack = parseWorldPack(readFileSync(resolve(process.cwd(), 'tests/fixtures/worldpack.v4.test.json'), 'utf8'));

type ServerMessage<T extends WsServerEnvelope['type']> = Extract<WsServerEnvelope, { type: T }>;

class TestWsClient {
  readonly messages: WsServerEnvelope[] = [];
  private readonly waiters = new Set<() => void>();
  private protocolError: unknown = null;
  private readonly closed: Promise<number>;

  private constructor(readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      try {
        this.messages.push(WsServerEnvelopeSchema.parse(JSON.parse(raw.toString())));
      } catch (error) {
        this.protocolError = error;
      }
      this.notify();
    });
    this.closed = new Promise((resolveClose) => socket.once('close', (code) => resolveClose(code)));
  }

  static async connect(url: string, token: string): Promise<TestWsClient> {
    const socket = new WebSocket(url, `mnemosin.v1.${token}`);
    const client = new TestWsClient(socket);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error('WS open timeout')), 3_000);
      socket.once('open', () => {
        clearTimeout(timer);
        resolveOpen();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        rejectOpen(error);
      });
    });
    return client;
  }

  get messageCount(): number {
    return this.messages.length;
  }

  send<T extends WsClientEnvelope['type']>(type: T, payload: Extract<WsClientEnvelope, { type: T }>['payload']): void {
    const message = WsClientEnvelopeSchema.parse({
      protocolVersion: 'v1',
      schemaVersion: 1,
      messageId: randomUUID(),
      type,
      payload,
    });
    this.socket.send(JSON.stringify(message));
  }

  async waitFor<T extends WsServerEnvelope['type']>(
    type: T,
    predicate: (message: ServerMessage<T>) => boolean = () => true,
    timeoutMs = 4_000,
  ): Promise<ServerMessage<T>> {
    const existing = this.messages.find(
      (message): message is ServerMessage<T> => message.type === type && predicate(message as ServerMessage<T>),
    );
    if (existing !== undefined) return existing;
    return new Promise<ServerMessage<T>>((resolveMessage, rejectMessage) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        rejectMessage(
          new Error(`WS message timeout: ${type}; received ${this.messages.map((message) => message.type).join(', ')}`),
        );
      }, timeoutMs);
      const check = (): void => {
        if (this.protocolError !== null) {
          clearTimeout(timer);
          this.waiters.delete(check);
          rejectMessage(this.protocolError);
          return;
        }
        const found = this.messages.find(
          (message): message is ServerMessage<T> => message.type === type && predicate(message as ServerMessage<T>),
        );
        if (found === undefined) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolveMessage(found);
      };
      this.waiters.add(check);
    });
  }

  async waitForClose(): Promise<number> {
    return this.closed;
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    this.socket.close();
    await Promise.race([
      this.closed,
      new Promise<void>((resolveClose) =>
        setTimeout(() => {
          this.socket.terminate();
          resolveClose();
        }, 500),
      ),
    ]);
  }

  private notify(): void {
    for (const check of [...this.waiters]) check();
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Condition timeout');
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
}

describe('P05-A real WebSocket + HotTickScheduler', () => {
  let app: FastifyInstance;
  let gateway: ReturnType<typeof createPrototypeWsGateway>;
  let url: string;
  let clients: TestWsClient[];
  let backpressured: boolean;

  beforeEach(async () => {
    backpressured = false;
    clients = [];
    const config = loadConfig({
      cwd: process.cwd(),
      ignoreDotenv: true,
      version: '0.0.0-test',
      env: {
        NODE_ENV: 'test',
        DATABASE_URL: 'file:./data/ws-integration-not-opened.sqlite',
        JWT_SECRET: 'ws-integration-secret-0123456789abcdef0123456789abcdef',
        LOG_LEVEL: 'silent',
      },
    });
    gateway = createPrototypeWsGateway({
      pack,
      players: [
        { participantId: playerOne, spawnPointId: 'player-1' },
        { participantId: playerTwo, spawnPointId: 'player-2' },
      ],
      serverVersion: config.version,
      contractsVersion: CONTRACTS_VERSION,
      isBackpressured: () => backpressured,
      async authenticate(token) {
        const actorId = token === 'player-one' ? playerOne : token === 'player-two' ? playerTwo : null;
        if (actorId === null) return { ok: false, code: 'AUTH_INVALID' };
        return {
          ok: true,
          actor: {
            actorId,
            actorType: 'player',
            matchId,
            sessionId,
            projectionKind: 'player',
            permissions: ['scene:input', 'scene:resync'],
          },
        };
      },
    });
    app = await buildApp({
      config,
      logger: createLogger({ config, name: 'ws-integration' }),
      cwd: process.cwd(),
      wsGateway: gateway,
    });
    url = `${(await app.listen({ host: '127.0.0.1', port: 0 })).replace('http:', 'ws:')}/ws`;
  });

  afterEach(async () => {
    backpressured = false;
    for (const client of clients) await client.close();
    await app.close();
  });

  async function connect(token: string): Promise<TestWsClient> {
    const client = await TestWsClient.connect(url, token);
    clients.push(client);
    return client;
  }

  async function finishReady(client: TestWsClient): Promise<ServerMessage<'scene:keyframe'>> {
    client.send('connection:client-ready', {});
    const keyframe = await client.waitFor('scene:keyframe');
    await client.waitFor('connection:ready');
    return keyframe;
  }

  it('routes held direction for two players, targets ACK and replicates continuous keyframe/delta chains', async () => {
    const first = await connect('player-one');
    const firstWelcome = await first.waitFor('connection:welcome');
    first.send('scene:input', {
      inputStreamId: firstWelcome.payload.inputStreamId,
      inputSequence: 1,
      input: { directionX: 1, directionY: 0 },
    });
    const earlyError = await first.waitFor(
      'connection:error',
      (message) => message.payload.code === 'CONNECTION_NOT_READY',
    );
    expect(earlyError.payload.retryable).toBe(false);
    const firstKeyframe = await finishReady(first);

    const second = await connect('player-two');
    const secondWelcome = await second.waitFor('connection:welcome');
    const secondKeyframe = await finishReady(second);
    expect(firstKeyframe.payload.projection.entities).toHaveLength(2);
    expect(secondKeyframe.payload.projection.entities).toHaveLength(2);
    expect(JSON.stringify(firstKeyframe.payload)).not.toMatch(/hiddenRole|infected/);
    expect(gateway.hot.scheduler.status().started).toBe(true);

    first.send('scene:input', {
      inputStreamId: firstWelcome.payload.inputStreamId,
      inputSequence: 1,
      input: { directionX: 1, directionY: 0 },
    });
    second.send('scene:input', {
      inputStreamId: secondWelcome.payload.inputStreamId,
      inputSequence: 1,
      input: { directionX: 0, directionY: 1 },
    });
    const firstAck = await first.waitFor(
      'scene:input-ack',
      (message) => message.payload.lastProcessedInputSequence === 1,
    );
    const secondAck = await second.waitFor(
      'scene:input-ack',
      (message) => message.payload.lastProcessedInputSequence === 1,
    );
    expect(firstAck.payload.authoritativePosition.x).toBeGreaterThan(0.5);
    expect(firstAck.payload.authoritativePosition.y).toBe(2.5);
    expect(secondAck.payload.authoritativePosition.y).toBeGreaterThan(0.5);
    expect(secondAck.payload.authoritativePosition.x).toBe(3.5);
    expect(
      first.messages
        .filter((message) => message.type === 'scene:input-ack')
        .every((message) => message.payload.inputStreamId === firstWelcome.payload.inputStreamId),
    ).toBe(true);
    expect(
      second.messages
        .filter((message) => message.type === 'scene:input-ack')
        .every((message) => message.payload.inputStreamId === secondWelcome.payload.inputStreamId),
    ).toBe(true);

    const firstDelta = await first.waitFor(
      'scene:delta',
      (message) => message.payload.baseSceneSequence === firstKeyframe.payload.sceneSequence,
    );
    const secondDelta = await second.waitFor(
      'scene:delta',
      (message) => message.payload.baseSceneSequence === secondKeyframe.payload.sceneSequence,
    );
    expect(firstDelta.payload.sceneSequence).toBe(firstKeyframe.payload.sceneSequence + 1);
    expect(secondDelta.payload.sceneSequence).toBe(secondKeyframe.payload.sceneSequence + 1);
    expect(firstDelta.payload.simulationTick).toBeGreaterThan(firstKeyframe.payload.simulationTick);
    expect(firstDelta.payload.worldEpoch).toBe(firstKeyframe.payload.worldEpoch);
    expect(firstDelta.payload.projectionRevision).toBe(firstKeyframe.payload.projectionRevision);
  }, 10_000);

  it('resets held input on reconnect, changes epoch/stream and never replays the old stream', async () => {
    const original = await connect('player-one');
    const oldWelcome = await original.waitFor('connection:welcome');
    await finishReady(original);
    original.send('scene:input', {
      inputStreamId: oldWelcome.payload.inputStreamId,
      inputSequence: 1,
      input: { directionX: 1, directionY: 0 },
    });
    await original.waitFor('scene:input-ack');
    original.send('scene:input', {
      inputStreamId: oldWelcome.payload.inputStreamId,
      inputSequence: 2,
      input: { directionX: 1, directionY: 0 },
    });

    const reconnected = await connect('player-one');
    const newWelcome = await reconnected.waitFor('connection:welcome');
    expect(newWelcome.payload.connectionEpoch).toBe(oldWelcome.payload.connectionEpoch + 1);
    expect(newWelcome.payload.inputStreamId).not.toBe(oldWelcome.payload.inputStreamId);
    expect(newWelcome.payload.isReconnect).toBe(true);
    expect(await original.waitForClose()).toBe(4409);
    const keyframe = await finishReady(reconnected);
    expect(keyframe.payload.inputStreamId).toBe(newWelcome.payload.inputStreamId);
    expect(keyframe.payload.lastProcessedInputSequence).toBeUndefined();
    const resetPosition = keyframe.payload.ownActorState?.position;
    expect(resetPosition).toBeDefined();

    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 140));
    expect(
      gateway.hot.runtime.getState().players.find((player) => player.participantId === playerOne)?.position,
    ).toEqual(resetPosition);
    reconnected.send('scene:input', {
      inputStreamId: oldWelcome.payload.inputStreamId,
      inputSequence: 3,
      input: { directionX: 1, directionY: 0 },
    });
    await reconnected.waitFor('connection:error', (message) => message.payload.code === 'INPUT_INACTIVE_STREAM');
    reconnected.send('scene:input', {
      inputStreamId: newWelcome.payload.inputStreamId,
      inputSequence: 1,
      input: { directionX: 0, directionY: 0 },
    });
    const stopped = await reconnected.waitFor(
      'scene:input-ack',
      (message) => message.payload.inputStreamId === newWelcome.payload.inputStreamId,
    );
    expect(stopped.payload.authoritativePosition).toEqual(resetPosition);
    expect(stopped.payload.authoritativeVelocity).toEqual({ x: 0, y: 0 });
  }, 10_000);

  it('answers a scene sequence gap with resync-required and a fresh keyframe', async () => {
    const client = await connect('player-one');
    const initial = await finishReady(client);
    const delta = await client.waitFor(
      'scene:delta',
      (message) => message.payload.baseSceneSequence === initial.payload.sceneSequence,
    );
    client.send('scene:resync', {
      lastAppliedSceneSequence: initial.payload.sceneSequence,
      worldEpoch: initial.payload.worldEpoch,
      reason: 'sequence_gap',
      snapshotId: initial.payload.snapshotId,
    });
    await client.waitFor('scene:resync-required', (message) => message.payload.reason === 'client_recovery');
    const fresh = await client.waitFor(
      'scene:keyframe',
      (message) => message.payload.snapshotId !== initial.payload.snapshotId,
    );
    expect(fresh.payload.sceneSequence).toBeGreaterThan(delta.payload.sceneSequence);
    expect(fresh.payload.simulationTick).toBeGreaterThanOrEqual(delta.payload.simulationTick);
    const next = await client.waitFor(
      'scene:delta',
      (message) => message.payload.baseSceneSequence === fresh.payload.sceneSequence,
    );
    expect(next.payload.sceneSequence).toBe(fresh.payload.sceneSequence + 1);
  }, 10_000);

  it('coalesces deltas under backpressure without dropping reliable messages or breaking base chains', async () => {
    const client = await connect('player-one');
    await finishReady(client);
    const record = app.wsGateway?.registry.all().find((candidate) => candidate.context.actorId === playerOne);
    expect(record).toBeDefined();
    if (record === undefined) throw new Error('Missing connection record');

    backpressured = true;
    const baseAtBlock = record.lastGeneratedSceneSequence;
    const receivedAtBlock = client.messageCount;
    await waitUntil(() => record.lastGeneratedSceneSequence >= baseAtBlock + 3);
    expect(record.delivery.deltaCount).toBe(1);
    expect(record.delivery.reliableCount).toBe(0);

    client.send('connection:ping', { pingId: 'ping-backpressure', clientTimeMs: 1 });
    await waitUntil(() => record.delivery.reliableCount === 1);
    expect(record.delivery.deltaCount).toBeGreaterThanOrEqual(1);
    expect(record.delivery.deltaCount).toBeLessThanOrEqual(2);
    backpressured = false;
    record.delivery.flush();

    const pong = await client.waitFor('connection:pong', (message) => message.payload.pingId === 'ping-backpressure');
    expect(pong.payload.simulationTick).toBeGreaterThan(0);
    const delivered = client.messages.slice(receivedAtBlock);
    const deltas = delivered.filter(
      (message): message is ServerMessage<'scene:delta'> => message.type === 'scene:delta',
    );
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    expect(deltas[0]?.payload.baseSceneSequence).toBe(baseAtBlock);
    expect(deltas[0]?.payload.sceneSequence).toBeGreaterThanOrEqual(baseAtBlock + 3);
    for (let index = 1; index < deltas.length; index += 1) {
      expect(deltas[index]?.payload.baseSceneSequence).toBe(deltas[index - 1]?.payload.sceneSequence);
    }
    expect(delivered.some((message) => message.type === 'connection:pong')).toBe(true);
  }, 10_000);

  it('§4.2: на connection:client-ready сервер сразу шлёт scene:keyframe и только затем connection:ready', async () => {
    const client = await connect('player-one');
    await client.waitFor('connection:welcome');
    // До client-ready keyframe не отправляется.
    expect(client.messages.some((message) => message.type === 'scene:keyframe')).toBe(false);

    client.send('connection:client-ready', {});
    await client.waitFor('scene:keyframe');
    await client.waitFor('connection:ready');

    const order = client.messages.map((message) => message.type);
    const keyframeIndex = order.indexOf('scene:keyframe');
    const readyIndex = order.indexOf('connection:ready');
    expect(keyframeIndex).toBeGreaterThanOrEqual(0);
    expect(readyIndex).toBeGreaterThan(keyframeIndex);
  }, 10_000);
});
