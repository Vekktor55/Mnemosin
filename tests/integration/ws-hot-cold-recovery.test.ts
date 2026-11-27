import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CONTRACTS_VERSION,
  MatchId,
  ParticipantId,
  ProjectionRevision,
  type HotGameplayEventEnvelope,
} from '@mnemosin/contracts';
import { loadConfig } from '@mnemosin/config';
import { CrashRestartHarness, parseWorldPack } from '@mnemosin/core';
import { createLogger } from '@mnemosin/logging';
import { buildApp, createPrototypeWsGateway, prototypeStaticScene } from '@mnemosin/server';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openColdTestDb, type ColdTestDb } from '../unit/cold-test-setup.js';
import {
  createEventProcessor,
  createRecovery,
  createRecoveryRuntime,
  insertRuntimeSnapshot,
  makeRecoveryCommand,
  makeRecoveryEvent,
} from '../unit/cold-recovery-fixtures.js';
import { TestWsClient, waitUntil, type ServerMessage } from './ws-test-client.js';

const pack = parseWorldPack(readFileSync(resolve(process.cwd(), 'tests/fixtures/worldpack.v4.test.json'), 'utf8'));
const secondPlayer = ParticipantId.parse('00000000-0000-4000-8000-000000000102');
const gatewayMatchId = MatchId.parse(pack.manifest.floorId);
const itemId = '00000000-0000-4000-8000-000000000101' as const;

describe('P06 real WS + SQLite HOT/COLD recovery', () => {
  let db: ColdTestDb;
  let app: FastifyInstance;
  let gateway: ReturnType<typeof createPrototypeWsGateway>;
  let clients: TestWsClient[];
  let url: string;
  let backpressured: boolean;

  beforeEach(async () => {
    db = await openColdTestDb('ws-p06');
    clients = [];
    backpressured = false;
    const config = loadConfig({
      cwd: process.cwd(),
      ignoreDotenv: true,
      version: '0.0.0-test',
      env: {
        NODE_ENV: 'test',
        DATABASE_URL: 'file:./data/ws-p06-not-opened.sqlite',
        JWT_SECRET: 'ws-p06-secret-0123456789abcdef0123456789abcdef',
        LOG_LEVEL: 'silent',
      },
    });
    gateway = createPrototypeWsGateway({
      pack,
      players: [
        { participantId: db.playerId, spawnPointId: 'player-1' },
        { participantId: secondPlayer, spawnPointId: 'player-2' },
      ],
      matchId: gatewayMatchId,
      serverVersion: config.version,
      contractsVersion: CONTRACTS_VERSION,
      isBackpressured: () => backpressured,
      loadColdScene: async () => {
        // Свежий committed COLD read выполняется только на keyframe/reconnect.
        const state = await db.uow.repos().state.findBySession(db.sessionId);
        const item = state?.objectStates[itemId];
        return {
          projectionRevision: ProjectionRevision.parse((state?.version ?? 0) + 1),
          objects: [
            ...prototypeStaticScene(pack).objects,
            { objectId: itemId, position: { x: 0.5, y: 2.5 }, taken: item?.taken ?? false },
          ],
        };
      },
      async authenticate(token) {
        const actorId = token === 'player-one' ? db.playerId : token === 'player-two' ? secondPlayer : null;
        if (actorId === null) return { ok: false, code: 'AUTH_INVALID' };
        return {
          ok: true,
          actor: {
            actorId,
            actorType: 'player',
            matchId: gatewayMatchId,
            sessionId: db.sessionId,
            projectionKind: 'player',
            permissions: ['scene:input', 'scene:resync'],
          },
        };
      },
    });
    app = await buildApp({
      config,
      logger: createLogger({ config, name: 'ws-p06-integration' }),
      cwd: process.cwd(),
      wsGateway: gateway,
    });
    url = `${(await app.listen({ host: '127.0.0.1', port: 0 })).replace('http:', 'ws:')}/ws`;
  });

  afterEach(async () => {
    backpressured = false;
    for (const client of clients) await client.close();
    await app.close();
    await db.close();
  });

  async function connect(token = 'player-one'): Promise<TestWsClient> {
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

  it('применяет COLD revision на границе тика и детерминированно отклоняет stale/duplicate', () => {
    const first = { ...makeRecoveryCommand(db, 1), matchId: gatewayMatchId };
    expect(gateway.hot.runtime.receiveColdCommand(first).accepted).toBe(true);
    expect(gateway.hot.runtime.getColdBoundaryState().coldRevision).toBe(0);
    const tick = gateway.hot.runtime.tick();
    expect(tick.diagnostics.coldRevisionsApplied).toBe(1);
    expect(gateway.hot.runtime.getColdBoundaryState().coldRevision).toBe(1);

    const duplicate = gateway.hot.runtime.receiveColdCommand(first);
    expect(duplicate).toEqual({ accepted: false, reason: 'duplicate' });
  });

  it('не теряет и не коалесцирует strict durable events между scene:delta под backpressure', async () => {
    const client = await connect();
    await finishReady(client);
    const record = app.wsGateway?.registry.all().find((candidate) => candidate.context.actorId === db.playerId);
    expect(record).toBeDefined();
    if (record === undefined) throw new Error('Missing WS record');

    backpressured = true;
    await waitUntil(() => record.delivery.deltaCount >= 1);
    const receivedAtBlock = client.messageCount;
    const first: HotGameplayEventEnvelope = { ...makeRecoveryEvent(db, 201, 1, 1), matchId: gatewayMatchId };
    const second: HotGameplayEventEnvelope = { ...makeRecoveryEvent(db, 202, 2, 2), matchId: gatewayMatchId };
    expect(app.wsGateway?.replication.publishDurableEvent(record, first)).toBe(true);
    expect(app.wsGateway?.replication.publishDurableEvent(record, second)).toBe(true);
    await waitUntil(() => record.delivery.reliableCount >= 2);
    await new Promise((resolveWait) => setTimeout(resolveWait, 120));
    expect(record.delivery.reliableCount).toBe(2);
    expect(record.delivery.deltaCount).toBeGreaterThanOrEqual(1);

    backpressured = false;
    record.delivery.flush();
    await client.waitFor('scene:durable-event', (message) => message.payload.eventId === first.eventId);
    await client.waitFor('scene:durable-event', (message) => message.payload.eventId === second.eventId);
    const delivered = client.messages.slice(receivedAtBlock);
    const durable = delivered.filter((message) => message.type === 'scene:durable-event');
    expect(durable.map((message) => message.payload.eventId)).toEqual([first.eventId, second.eventId]);
    expect(durable[0]?.payload).toEqual(first);
    expect(delivered.some((message) => message.type === 'scene:delta')).toBe(true);
  }, 10_000);

  it('после COLD commit reconnect выдаёт новый stream/epoch и keyframe из актуального GameState', async () => {
    const original = await connect();
    const oldWelcome = await original.waitFor('connection:welcome');
    const initial = await finishReady(original);
    expect(initial.payload.projection.objects.find((object) => object.objectId === itemId)?.taken).toBe(false);

    const event = makeRecoveryEvent(db, 203, 1, 10);
    const committed = await createEventProcessor(db).process({ event, sessionId: db.sessionId });
    expect(committed.ack.outcome).toBe('committed');
    expect((await db.services.state.get(db.sessionId)).objectStates[itemId]?.taken).toBe(true);

    const reconnected = await connect();
    const newWelcome = await reconnected.waitFor('connection:welcome');
    expect(newWelcome.payload.connectionEpoch).toBe(oldWelcome.payload.connectionEpoch + 1);
    expect(newWelcome.payload.inputStreamId).not.toBe(oldWelcome.payload.inputStreamId);
    expect(await original.waitForClose()).toBe(4409);
    const keyframe = await finishReady(reconnected);

    const item = keyframe.payload.projection.objects.find((object) => object.objectId === itemId);
    expect(item?.taken).toBe(true);
    expect(keyframe.payload.projectionRevision).toBe(committed.ack.coldStateVersion + 1);
    expect(keyframe.payload.inputStreamId).toBe(newWelcome.payload.inputStreamId);
    expect(keyframe.payload.lastProcessedInputSequence).toBeUndefined();
    expect(JSON.stringify(keyframe.payload)).not.toMatch(/hiddenRole|infected/);
  }, 10_000);

  it('matchId и sessionId остаются разными идентификаторами: match приходит из wiring, сессия — из COLD', async () => {
    // Wiring задаёт match явно (одна сессия = один match в P06-прототипе),
    // а COLD-состояние живёт в sessionId — это разные идентификаторы.
    expect(gateway.hot.matchId).toBe(gatewayMatchId);
    expect(gateway.hot.runtime.getState().players).toHaveLength(2);

    // Durable event с match-контекстом применяется к COLD-сессии даже когда
    // matchId и sessionId не совпадают по значению: процессор привязан к
    // match сессии (из wiring), а мутирует GameState по sessionId.
    const event: HotGameplayEventEnvelope = {
      ...makeRecoveryEvent(db, 205, 1, 12),
      matchId: gatewayMatchId,
    };
    expect(String(event.matchId)).not.toBe(String(db.sessionId));

    const committed = await createEventProcessor(db, gatewayMatchId).process({ event, sessionId: db.sessionId });
    expect(committed.ack.outcome).toBe('committed');
    expect(committed.ack.matchId).toBe(gatewayMatchId);

    // Повтор того же eventId после «рестарта» не дублирует эффект.
    const replayed = await createEventProcessor(db, gatewayMatchId).process({ event, sessionId: db.sessionId });
    expect(replayed.ack.outcome).toBe('replayed');
    expect((await db.services.state.get(db.sessionId)).version).toBe(1);

    // Событие чужого match (не match этой сессии) отклоняется до commit.
    const foreign: HotGameplayEventEnvelope = {
      ...makeRecoveryEvent(db, 208, 2, 13),
      matchId: MatchId.parse('00000000-0000-4000-8000-000000000996'),
    };
    await expect(
      createEventProcessor(db, gatewayMatchId).process({ event: foreign, sessionId: db.sessionId }),
    ).rejects.toMatchObject({ code: 'CORE_INVALID_STATE_TRANSITION' });
    expect((await db.services.state.get(db.sessionId)).version).toBe(1);
  }, 10_000);

  it('durable event чужого match не публикуется в сцену соединения', async () => {
    const client = await connect();
    await finishReady(client);
    const record = app.wsGateway?.registry.all().find((candidate) => candidate.context.actorId === db.playerId);
    expect(record).not.toBeUndefined();
    if (record === undefined) throw new Error('Missing WS record');

    const before = client.messageCount;
    const foreign: HotGameplayEventEnvelope = {
      ...makeRecoveryEvent(db, 206, 1, 13),
      matchId: MatchId.parse('00000000-0000-4000-8000-000000000997'),
    };

    expect(app.wsGateway?.replication.publishDurableEvent(record, foreign)).toBe(false);
    await new Promise((resolveWait) => setTimeout(resolveWait, 60));
    expect(client.messages.slice(before).some((message) => message.type === 'scene:durable-event')).toBe(false);

    // Событие своего match публикуется.
    const own: HotGameplayEventEnvelope = {
      ...makeRecoveryEvent(db, 207, 1, 14),
      matchId: gatewayMatchId,
    };
    expect(app.wsGateway?.replication.publishDurableEvent(record, own)).toBe(true);
    await client.waitFor('scene:durable-event', (message) => message.payload.eventId === own.eventId);
  }, 10_000);

  it('restart после COLD commit до ACK: recovery делает idempotent replay на реальной P03 geometry', async () => {
    const snapshot = await insertRuntimeSnapshot(db, createRecoveryRuntime(db), 700);
    const event = makeRecoveryEvent(db, 204, 1, 41);
    const harness = new CrashRestartHarness({
      processor: createEventProcessor(db),
      recovery: createRecovery(db, createRecoveryRuntime(db), createEventProcessor(db)),
      snapshotRepo: db.uow.repos().snapshots,
      journal: db.services.journal,
    });
    harness.recordSnapshotWritten(snapshot);
    harness.recordEventCreated(event);

    const result = await harness.simulateCrashAndRestart(db.sessionId, MatchId.parse(db.sessionId), {
      afterEventCreated: true,
      afterColdCommit: true,
      afterAckSent: false,
      afterSnapshotWritten: true,
    });

    expect(result.committedBeforeCrash).toBe(1);
    expect(result.acknowledgedBeforeCrash).toBe(0);
    expect(result.deduplicatedEvents).toBe(1);
    expect(result.committedEvents).toBe(0);
    expect(result.pendingEventsAfterRecovery).toBe(0);
    expect(result.transientTicksLost).toBe(41);
    expect(await db.uow.repos().outbox.countAll()).toBe(1);
    expect((await db.services.state.get(db.sessionId)).version).toBe(1);
  });
});
