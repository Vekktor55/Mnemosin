import { describe, expect, it } from 'vitest';

import {
  SceneResyncMessageSchema,
  WsServerEnvelopeSchema,
  type WsClientMessageType,
  type WsServerEnvelope,
  type WsServerMessageType,
} from '@mnemosin/contracts';

import {
  GameWorld,
  type GameWorldCanvasHost,
  type GameWorldConnectionInfo,
  type GameWorldFrameScheduler,
  type GameWorldInputPort,
  type GameWorldRendererPort,
  type GameWorldWsPort,
  type WsClientPayload,
  type WsServerMessage,
} from '@mnemosin/client';

/**
 * Регрессия гонки инициализации P05-B (NETWORK_PROTOCOL.md §4.2, §9.3, §17.4).
 *
 * Первопричина задержки появления игрока: `connection:client-ready` уходил
 * автоматически в обработчике `connection:welcome`, а подписка GameWorld на
 * `scene:keyframe` выполнялась позже (после `await renderer.init()`), из-за
 * чего первый keyframe приходил в пустую подписку и терялся.
 *
 * Здесь проверяется, что:
 *  - keyframe, пришедший ДО завершения `renderer.init()`, не теряется;
 *  - `connection:client-ready` уходит только после готовности renderer;
 *  - delta без keyframe и delta с несовпадением baseSceneSequence приводят к
 *    типизированному `scene:resync` с валидным reason (и cooldown);
 *  - после `destroy()` обработчики снимаются — дублей при remount нет.
 */

const UUID = '00000000-0000-4000-8000-000000000000';
const OWN_ID = '11111111-1111-4111-8111-111111111111';
const REMOTE_ID = '22222222-2222-4222-8222-222222222222';
const OBJECT_ID = '33333333-3333-4333-8333-333333333333';

// ------------------------------------------------------------------ fakes

class FakeWs implements GameWorldWsPort {
  readonly handlers = new Map<WsServerMessageType, Set<(message: WsServerEnvelope) => void>>();
  readonly sent: { readonly type: string; readonly payload: unknown }[] = [];
  readonly resyncRequests: { readonly reason: string; readonly lastAppliedSceneSequence: number | null }[] = [];
  clientReadyCalls = 0;
  ready = true;
  connectionInfo: GameWorldConnectionInfo | null = {
    actorId: OWN_ID,
    inputStreamId: UUID,
    lastRttMs: 12,
    lastSceneSequence: null,
    worldEpoch: 1,
  };

  on<T extends WsServerMessageType>(type: T, handler: (message: WsServerMessage<T>) => void): () => void {
    const set = this.handlers.get(type) ?? new Set<(message: WsServerEnvelope) => void>();
    const wrapped = (message: WsServerEnvelope): void => handler(message as WsServerMessage<T>);
    set.add(wrapped);
    this.handlers.set(type, set);
    return () => {
      set.delete(wrapped);
    };
  }

  send<T extends WsClientMessageType>(type: T, payload: WsClientPayload<T>): void {
    this.sent.push({ type, payload });
  }

  isReady(): boolean {
    return this.ready;
  }

  getConnectionInfo(): GameWorldConnectionInfo | null {
    return this.connectionInfo;
  }

  requestResync(reason: string, options?: { readonly lastAppliedSceneSequence?: number | null }): void {
    this.resyncRequests.push({
      reason,
      lastAppliedSceneSequence: options?.lastAppliedSceneSequence ?? null,
    });
  }

  sendClientReady(): boolean {
    this.clientReadyCalls += 1;
    return true;
  }

  emit(message: WsServerEnvelope): void {
    const set = this.handlers.get(message.type);
    if (set === undefined) return;
    for (const handler of [...set]) handler(message);
  }

  handlerCount(type: WsServerMessageType): number {
    return this.handlers.get(type)?.size ?? 0;
  }
}

class FakeRenderer implements GameWorldRendererPort {
  initCalls = 0;
  destroyed = false;
  readonly sceneObjects: unknown[] = [];
  readonly players = new Map<string, { readonly x: number; readonly y: number; readonly own: boolean }>();
  clearPlayersCalls = 0;

  constructor(private readonly gate: Promise<void> | null = null) {}

  async init(_parent: GameWorldCanvasHost): Promise<void> {
    this.initCalls += 1;
    if (this.gate !== null) await this.gate;
  }

  setSceneObjects(objects: readonly unknown[]): void {
    this.sceneObjects.length = 0;
    this.sceneObjects.push(...objects);
  }

  setPlayer(participantId: string, position: { x: number; y: number }, own: boolean): void {
    this.players.set(participantId, { x: position.x, y: position.y, own });
  }

  removePlayer(participantId: string): void {
    this.players.delete(participantId);
  }

  clearPlayers(): void {
    this.clearPlayersCalls += 1;
    this.players.clear();
  }

  centerOn(): void {}

  render(): void {}

  destroy(): void {
    this.destroyed = true;
  }
}

class FakeInput implements GameWorldInputPort {
  attachCalls = 0;
  detachCalls = 0;

  attach(): void {
    this.attachCalls += 1;
  }

  detach(): void {
    this.detachCalls += 1;
  }

  setOnChange(): void {}

  current(): { directionX: number; directionY: number } {
    return { directionX: 0, directionY: 0 };
  }
}

class FakeScheduler implements GameWorldFrameScheduler {
  private nextHandle = 1;
  private readonly callbacks = new Map<number, (now: number) => void>();

  request(callback: (now: number) => void): number {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.callbacks.set(handle, callback);
    return handle;
  }

  cancel(handle: number): void {
    this.callbacks.delete(handle);
  }

  tick(now: number): void {
    for (const callback of [...this.callbacks.values()]) callback(now);
  }
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// -------------------------------------------------------------- envelopes

function welcomeEnvelope(): WsServerEnvelope {
  return WsServerEnvelopeSchema.parse({
    protocolVersion: 'v1',
    schemaVersion: 1,
    messageId: UUID,
    type: 'connection:welcome',
    payload: {
      protocolVersion: 'v1',
      serverVersion: 'test',
      contractsVersion: 'test',
      matchId: UUID,
      sessionId: UUID,
      connectionId: UUID,
      connectionEpoch: 1,
      actorId: OWN_ID,
      actorType: 'player',
      inputStreamId: UUID,
      projectionKind: 'player',
      permissions: ['scene:input', 'scene:resync'],
      isReconnect: false,
      supportedFeatures: ['scene:keyframe', 'scene:delta'],
    },
  });
}

function keyframeEnvelope(sceneSequence = 1): WsServerEnvelope {
  return WsServerEnvelopeSchema.parse({
    protocolVersion: 'v1',
    schemaVersion: 1,
    messageId: UUID,
    type: 'scene:keyframe',
    payload: {
      matchId: UUID,
      worldEpoch: 1,
      snapshotId: UUID,
      sceneSequence,
      simulationTick: 10,
      serverTimeMs: 1_000,
      projectionRevision: 1,
      worldPackVersion: '1.0.0',
      projection: {
        projectionKind: 'player',
        entities: [
          { participantId: OWN_ID, position: { x: 0.5, y: 0.5 }, velocity: { x: 0, y: 0 } },
          { participantId: REMOTE_ID, position: { x: 2.5, y: 2.5 }, velocity: { x: 0, y: 0 } },
        ],
        objects: [{ objectId: OBJECT_ID, position: { x: 2.5, y: 0.5 }, portalState: 'closed' }],
        environment: { worldId: UUID, floorId: UUID, worldSpaceId: UUID },
      },
    },
  });
}

function deltaEnvelope(overrides: Record<string, unknown> = {}): WsServerEnvelope {
  return WsServerEnvelopeSchema.parse({
    protocolVersion: 'v1',
    schemaVersion: 1,
    messageId: UUID,
    type: 'scene:delta',
    payload: {
      matchId: UUID,
      worldEpoch: 1,
      sceneSequence: 2,
      baseSceneSequence: 1,
      simulationTick: 11,
      serverTimeMs: 1_050,
      projectionRevision: 1,
      projectionKind: 'player',
      entityUpserts: [],
      entityRemovals: [],
      objectUpserts: [],
      objectRemovals: [],
      ...overrides,
    },
  });
}

function buildWorld(
  ws: FakeWs,
  renderer: FakeRenderer,
): { world: GameWorld; scheduler: FakeScheduler; input: FakeInput } {
  const scheduler = new FakeScheduler();
  const input = new FakeInput();
  const world = new GameWorld({
    ws,
    parent: { clientWidth: 800, clientHeight: 600 },
    renderer,
    frameScheduler: scheduler,
    input,
  });
  world.attach();
  return { world, scheduler, input };
}

// ------------------------------------------------------------------ tests

describe('GameWorld: гонка первого scene:keyframe (§4.2, §9.3, §17.4)', () => {
  it('keyframe, пришедший во время renderer.init(), не теряется и применяется сразу', async () => {
    const gate = deferred();
    const ws = new FakeWs();
    const renderer = new FakeRenderer(gate.promise);
    const { world, scheduler } = buildWorld(ws, renderer);

    const started = world.start();

    // Welcome + keyframe приходят, пока renderer ещё инициализируется.
    ws.emit(welcomeEnvelope());
    ws.emit(keyframeEnvelope());

    expect(renderer.sceneObjects).toHaveLength(0);
    expect(ws.clientReadyCalls).toBe(0);

    gate.resolve();
    await started;

    // Keyframe применён сразу после инициализации renderer.
    expect(renderer.sceneObjects).toHaveLength(1);
    expect(renderer.sceneObjects[0]).toMatchObject({ objectId: OBJECT_ID });
    // client-ready ушёл ровно один раз и только после готовности renderer.
    expect(ws.clientReadyCalls).toBe(1);

    // Кадр рисует собственного игрока (prediction построена из keyframe).
    scheduler.tick(1_000);
    expect(renderer.players.get(OWN_ID)?.own).toBe(true);

    world.destroy();
  });

  it('delta без keyframe приводит к типизированному scene:resync с валидным reason', () => {
    const ws = new FakeWs();
    const renderer = new FakeRenderer();
    const { world } = buildWorld(ws, renderer);

    ws.emit(welcomeEnvelope());
    ws.emit(deltaEnvelope());

    expect(ws.resyncRequests).toHaveLength(1);
    expect(ws.resyncRequests[0]?.reason).toBe('client_recovery');
    // Полезная нагрузка должна проходить Zod-схему scene:resync.
    const parsed = SceneResyncMessageSchema.safeParse({
      reason: ws.resyncRequests[0]?.reason,
      lastAppliedSceneSequence: ws.resyncRequests[0]?.lastAppliedSceneSequence ?? undefined,
    });
    expect(parsed.success).toBe(true);

    world.destroy();
  });

  it('несовпадение baseSceneSequence приводит к resync с последней применённой sequence', async () => {
    const ws = new FakeWs();
    const renderer = new FakeRenderer();
    const { world } = buildWorld(ws, renderer);

    const started = world.start();
    ws.emit(welcomeEnvelope());
    ws.emit(keyframeEnvelope(7));
    await started;

    ws.emit(deltaEnvelope({ sceneSequence: 9, baseSceneSequence: 3 }));

    expect(ws.resyncRequests).toHaveLength(1);
    expect(ws.resyncRequests[0]?.reason).toBe('sequence_gap');
    expect(ws.resyncRequests[0]?.lastAppliedSceneSequence).toBe(7);

    world.destroy();
  });

  it('cooldown не даёт спамить scene:resync', () => {
    const ws = new FakeWs();
    const renderer = new FakeRenderer();
    const { world } = buildWorld(ws, renderer);

    ws.emit(welcomeEnvelope());
    ws.emit(deltaEnvelope());
    ws.emit(deltaEnvelope());
    ws.emit(deltaEnvelope());

    expect(ws.resyncRequests).toHaveLength(1);

    world.destroy();
  });

  it('destroy() снимает подписки — после remount нет дублирующих обработчиков', async () => {
    const ws = new FakeWs();
    const renderer = new FakeRenderer();
    const { world } = buildWorld(ws, renderer);

    const started = world.start();
    ws.emit(welcomeEnvelope());
    ws.emit(keyframeEnvelope());
    await started;
    expect(renderer.sceneObjects).toHaveLength(1);
    expect(ws.handlerCount('scene:keyframe')).toBe(1);

    world.destroy();
    expect(ws.handlerCount('scene:keyframe')).toBe(0);
    expect(ws.handlerCount('scene:delta')).toBe(0);
    expect(renderer.destroyed).toBe(true);

    // Поздний keyframe после destroy() не применяется.
    ws.emit(keyframeEnvelope(2));
    expect(renderer.sceneObjects).toHaveLength(1);

    // Remount: новая подписка ровно одна, keyframe применяется один раз.
    const renderer2 = new FakeRenderer();
    const { world: world2 } = buildWorld(ws, renderer2);
    const started2 = world2.start();
    ws.emit(welcomeEnvelope());
    ws.emit(keyframeEnvelope(3));
    await started2;
    expect(ws.handlerCount('scene:keyframe')).toBe(1);
    expect(renderer2.sceneObjects).toHaveLength(1);

    world2.destroy();
  });
});
