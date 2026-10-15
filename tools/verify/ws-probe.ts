import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

import { WebSocket } from 'ws';

import { FORBIDDEN_IN_BROADCAST, WS_PRIVACY_POLICY, type WSServerType } from '@mnemosin/contracts';
import { loadConfig } from '@mnemosin/config';
import { createLogger } from '@mnemosin/logging';
import { bootstrapDatabase, loadLocationFixtures, OutboxPublisher } from '@mnemosin/database';
import { InMemoryMetricsSink, InProcessEventBus, createCoreServices, type CoreServices } from '@mnemosin/core';
import {
  attachModulesRegistry,
  buildAIStack,
  buildApp,
  buildModules,
  buildProjectionProvider,
  validateModulesRegistry,
} from '@mnemosin/server';
import { JwtService } from '@mnemosin/gateway-http';
import { findForbiddenKey } from '@mnemosin/gateway-ws';

/**
 * tools/verify/ws-probe.ts — проба WS-транспорта для A1.7 (приватность
 * broadcast на живом WS-сервере) и WS-части A1.3 (Zod-валидация входящих,
 * неизвестный тип → VALIDATION без разрыва).
 *
 * Поднимает in-process сервер (HTTP+WS на случайном порту), создаёт партию
 * (GM + 3 игрока), прогоняет полный цикл хода через WS-команды и проверяет
 * КАЖДЫЙ перехваченный envelope по WS_PRIVACY_POLICY:
 *  - BROADCAST не содержит ключей FORBIDDEN_IN_BROADCAST (B-10);
 *  - GM_ONLY не доходит до игроков (A1.8);
 *  - TARGETED — получатель совпадает с адресатом;
 *  - приватные маркеры (чат, GM-заметки) видны только положенным адресатам.
 *
 * Печатает одну JSON-строку отчёта — verify:stage1 разбирает её и ставит PASS/FAIL.
 * Запуск: npx tsx --conditions=development tools/verify/ws-probe.ts
 */

const ROOT = resolve(process.cwd());
const dir = mkdtempSync(join(tmpdir(), 'mnemosin-ws-probe-'));
const SECRET = 'ws-probe-secret-0123456789abcdef-0123456789';

interface Report {
  checks: Record<string, boolean>;
  details: Record<string, unknown>;
}

const report: Report = { checks: {}, details: {} };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const idem = (): string => `idem-${randomUUID()}`;

interface ProbeClient {
  readonly label: string;
  readonly playerId: string;
  readonly isGM: boolean;
  readonly messages: Array<{ type: string; payload: Record<string, unknown>; requestId?: string; at: number }>;
  readonly ws: WebSocket;
  closed: { code: number; reason: string } | null;
  send(type: string, payload: Record<string, unknown>, extra?: { requestId?: string; sessionId?: string }): void;
  waitFor(
    pred: (m: { type: string; payload: Record<string, unknown>; requestId?: string }) => boolean,
    timeoutMs?: number,
  ): Promise<void>;
}

async function main(): Promise<void> {
  const config = loadConfig({
    cwd: ROOT,
    ignoreDotenv: true,
    version: '0.0.0-wsprobe',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: `file:${join(dir, 'ws-probe.sqlite')}`,
      JWT_SECRET: SECRET,
      LOG_LEVEL: 'silent',
      AI_PROVIDER: 'scripted',
      AI_SCRIPTED_FIXTURE: resolve(ROOT, 'tools/fixtures/resolution.ok.json'),
      CONFIG_DIR: './config',
    },
  });
  const logger = createLogger({ config, name: 'ws-probe' });
  const boot = await bootstrapDatabase({ url: config.env.DATABASE_URL, seed: false });
  const services: CoreServices = createCoreServices({
    uow: boot.uow,
    guard: boot.idempotency,
    pack: loadLocationFixtures(),
    limits: {
      maxPlayersPerSession: config.limits.maxPlayersPerSession,
      actionsPerPlayerPerTurn: config.limits.actionsPerPlayerPerTurn,
    },
  });
  const bus = new InProcessEventBus();
  const metrics = new InMemoryMetricsSink();
  const ai = buildAIStack({ config, uow: boot.uow, bus, metrics, logger, root: ROOT });
  const modules = buildModules({ config, persistence: boot, services, ai, logger });
  validateModulesRegistry(modules.registrations);
  const detach = attachModulesRegistry(modules.registrations, bus, logger);
  const publisher = new OutboxPublisher({ uow: boot.uow, bus, metrics });
  // Аналог scheduler'а из main.ts: проба живёт без джобов — outbox поллим сами.
  const outboxTimer = setInterval(() => {
    publisher.pollOnce().catch(() => undefined);
  }, 100);
  const jwt = new JwtService({ secret: SECRET, accessTtlSeconds: 3600, refreshTtlSeconds: 86_400 });

  const app = await buildApp({
    config,
    logger,
    cwd: join(dir, 'no-client'),
    persistence: boot,
    getCapabilities: () => ai.registry.snapshot(),
    httpGateway: {
      jwt,
      players: boot.uow.repos().players,
      isProduction: false,
      sessions: services.sessions,
      turns: services.turns,
      chat: modules.chat,
      gm: modules.gm,
      gmReview: modules.gmReview,
      projections: buildProjectionProvider(boot.uow),
      getMetricsText: () => '',
      mediaDir: join(dir, 'media'),
      limits: {
        authPerIpPerMin: 1000,
        tokenPerMinute: 3000,
        mutatingTurnPerMinute: 1000,
      },
    },
    wsGateway: {
      jwt,
      players: boot.uow.repos().players,
      bus,
      serverVersion: config.version,
      getCapabilities: () => Object.values(ai.registry.snapshot().capabilities),
      sessions: services.sessions,
      turns: services.turns,
      chat: modules.chat,
      gm: modules.gm,
      gmReview: modules.gmReview,
      story: modules.story,
      projections: buildProjectionProvider(boot.uow),
      limits: {
        wsAuthTimeoutMs: config.limits.wsAuthTimeoutMs,
        wsMaxConnectionsPerIp: config.limits.wsMaxConnectionsPerIp,
        wsMaxConnectionsPerPlayer: config.limits.wsMaxConnectionsPerPlayer,
        wsMaxPayloadBytes: config.limits.wsMaxPayloadBytes,
        heartbeat: { intervalMs: 20_000, idleTimeoutMs: 45_000 },
        wsRatePerConnection: {
          ACTION_SUBMIT: config.limits.wsRatePerConnection.ACTION_SUBMIT,
          CHAT_PUBLIC: config.limits.wsRatePerConnection.CHAT_PUBLIC,
          DEFAULT: config.limits.wsRatePerConnection.DEFAULT,
        },
        dedupeTtlMs: config.limits.dedupeTtlMs,
      },
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.addresses()[0];
  if (address === undefined) throw new Error('нет адреса');
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;

  const clients: ProbeClient[] = [];
  const connect = (token: string, label: string, playerId: string, isGM: boolean): Promise<ProbeClient> =>
    new Promise((resolveConn, rejectConn) => {
      const ws = new WebSocket(wsUrl, [`mnemosin.v1.${token}`]);
      const client: ProbeClient = {
        label,
        playerId,
        isGM,
        messages: [],
        ws,
        closed: null,
        send(type, payload, extra = {}) {
          ws.send(JSON.stringify({ type, payload, ts: new Date().toISOString(), ...extra }));
        },
        async waitFor(pred, timeoutMs = 15_000) {
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            if (client.messages.some((m) => pred(m))) return;
            if (Date.now() > deadline) {
              throw new Error(`${label}: timeout ожидания (${client.messages.map((m) => m.type).join(',')})`);
            }
            await sleep(25);
          }
        },
      };
      ws.on('message', (data) => {
        try {
          const parsed = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
          client.messages.push({
            type: String(parsed['type'] ?? ''),
            payload: (parsed['payload'] ?? {}) as Record<string, unknown>,
            ...(typeof parsed['requestId'] === 'string' ? { requestId: parsed['requestId'] } : {}),
            at: Date.now(),
          });
        } catch {
          /* игнор */
        }
      });
      ws.on('close', (code, reason) => {
        client.closed = { code, reason: reason.toString('utf8') };
      });
      ws.on('open', () => resolveConn(client));
      ws.on('error', rejectConn);
      clients.push(client);
    });

  try {
    // --- партия: GM + 3 игрока, start → ход №1 --------------------------------
    const post = async (url: string, body: unknown, token?: string) => {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
        payload: body as Record<string, unknown>,
      });
      return { status: res.statusCode, body: res.json() as Record<string, unknown> };
    };
    const get = async (url: string, token?: string) => {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      });
      return { status: res.statusCode, body: res.json() as Record<string, unknown> };
    };

    const created = await post('/auth/session', {
      displayName: 'Ведущий пробы',
      characterName: 'Ведущий',
      title: 'WS-проба A1.7',
    });
    const sessionId = String(created.body['sessionId']);
    const gmToken = String(created.body['token']);
    const gmPlayerId = String(created.body['playerId']);
    const players: Array<{ playerId: string; token: string }> = [];
    for (let i = 1; i <= 3; i += 1) {
      const joined = await post(`/sessions/${sessionId}/join`, {
        displayName: `Игрок ${i}`,
        characterName: `Игрок ${i}`,
      });
      players.push({ playerId: String(joined.body['playerId']), token: String(joined.body['token']) });
    }
    const started = await post(`/sessions/${sessionId}/start`, { idempotencyKey: idem() }, gmToken);
    const turnId = String(started.body['turnId']);

    const gm = await connect(gmToken, 'gm', gmPlayerId, true);
    const pcs = [] as ProbeClient[];
    for (let i = 0; i < players.length; i += 1) {
      pcs.push(await connect(players[i]!.token, `p${i}`, players[i]!.playerId, false));
    }
    for (const client of [gm, ...pcs]) {
      await client.waitFor((m) => m.type === 'AUTH_OK');
    }
    report.checks['auth_ok_all'] = true;

    // --- A1.3 (WS-часть): неизвестный тип → ERROR VALIDATION, соединение живо --
    pcs[0]!.send('NO_SUCH_TYPE', { x: 1 });
    await pcs[0]!.waitFor((m) => m.type === 'ERROR' && m.payload['code'] === 'VALIDATION');
    pcs[0]!.send('PING', {});
    await pcs[0]!.waitFor((m) => m.type === 'PONG');
    report.checks['a13_ws_unknown_type_validation_alive'] =
      pcs[0]!.closed === null && pcs[0]!.messages.some((m) => m.type === 'PONG');

    // --- действия, приватный чат, GM-заметка ----------------------------------
    for (let i = 0; i < pcs.length; i += 1) {
      const requestId = `req-${randomUUID()}`;
      pcs[i]!.send(
        'ACTION_SUBMIT',
        { turnId, rawText: `Действие игрока ${i}`, idempotencyKey: idem(), requestId },
        { requestId },
      );
      await pcs[i]!.waitFor((m) => m.type === 'ACTION_ACK' && m.requestId === requestId);
    }
    report.checks['action_acks'] = true;

    const privateMarker = `PRIV-MARKER-${randomUUID()}`;
    const privReq = `req-${randomUUID()}`;
    pcs[0]!.send(
      'CHAT_PRIVATE',
      { toPlayerId: players[1]!.playerId, text: privateMarker, requestId: privReq },
      { requestId: privReq },
    );
    await pcs[0]!.waitFor((m) => m.type === 'CHAT_ACK' && m.requestId === privReq);

    const noteMarker = `GM-SECRET-NOTE-${randomUUID()}`;
    const noteReq = `req-${randomUUID()}`;
    gm.send(
      'GM_ADD_NOTE',
      { sessionId, visibility: 'GM_ONLY', text: noteMarker, requestId: noteReq },
      { requestId: noteReq },
    );
    await gm.waitFor((m) => m.type === 'GM_NOTE_ACK' && m.requestId === noteReq);

    // --- цикл хода: lock → draft (GM_ONLY) → commit ----------------------------
    const lockReq = `req-${randomUUID()}`;
    gm.send('GM_LOCK_TURN', { turnId, idempotencyKey: idem(), requestId: lockReq }, { requestId: lockReq });
    await gm.waitFor((m) => m.type === 'GM_ACTION_ACK' && m.requestId === lockReq, 20_000);
    await gm.waitFor((m) => m.type === 'TURN_DRAFT_READY', 30_000);
    report.checks['gm_got_draft_ready'] = true;

    const commitReq = `req-${randomUUID()}`;
    gm.send('GM_COMMIT_TURN', { turnId, idempotencyKey: idem(), requestId: commitReq }, { requestId: commitReq });
    await gm.waitFor((m) => m.type === 'GM_ACTION_ACK' && m.requestId === commitReq, 20_000);
    for (const client of pcs) {
      await client.waitFor((m) => m.type === 'TURN_COMMITTED', 30_000);
    }
    await sleep(1200); // outbox poll 250мс: CHAT_*/STATE-доставка успевает разлететься

    // --- инварианты приватности по всем перехваченным envelope ------------------
    let broadcastClean = true;
    let gmOnlyLeak = false;
    let targetedOk = true;
    let privateMarkerLeak = false;
    let noteMarkerLeak = false;
    for (const client of pcs) {
      for (const message of client.messages) {
        const policy = WS_PRIVACY_POLICY[message.type as WSServerType];
        if (policy === 'BROADCAST' && findForbiddenKey(message.payload) !== null) broadcastClean = false;
        if (policy === 'GM_ONLY') gmOnlyLeak = true;
        if (policy === 'TARGETED') {
          if (message.type === 'STATE_PROJECTION_PRIVATE' && message.payload['playerId'] !== client.playerId)
            targetedOk = false;
          if (message.type === 'CHAT_PRIVATE' && message.payload['toPlayerId'] !== client.playerId) targetedOk = false;
        }
        const json = JSON.stringify(message.payload);
        if (json.includes(privateMarker) && client.playerId !== players[1]!.playerId) privateMarkerLeak = true;
        if (json.includes(noteMarker)) noteMarkerLeak = true;
      }
    }
    report.checks['broadcast_no_forbidden_fields'] = broadcastClean;
    report.checks['no_gm_only_to_players'] = !gmOnlyLeak;
    report.checks['targeted_matches_addressee'] = targetedOk;
    report.checks['private_chat_only_to_addressee'] = !privateMarkerLeak;
    report.checks['gm_note_not_leaked'] = !noteMarkerLeak;

    // Адресат получил личное; GM получил полный resolution (GM_ONLY).
    report.checks['addressee_got_private'] = pcs[1]!.messages.some(
      (m) => m.type === 'CHAT_PRIVATE' && JSON.stringify(m.payload).includes(privateMarker),
    );
    report.checks['gm_got_full_resolution'] = gm.messages.some((m) => m.type === 'TURN_RESOLUTION_GM');
    // Публичный TURN_COMMITTED — только публичные поля.
    const committed = pcs[0]!.messages.find((m) => m.type === 'TURN_COMMITTED');
    report.checks['turn_committed_shape'] =
      committed !== undefined &&
      Array.isArray(committed.payload['publicSegments']) &&
      (committed.payload['publicSegments'] as unknown[]).length > 0 &&
      findForbiddenKey(committed.payload) === null;
    // Приватная часть хода — TARGETED адресатам фикстуры.
    report.checks['turn_private_resolution_targeted'] = pcs.every((client) =>
      client.messages
        .filter((m) => m.type === 'TURN_PRIVATE_RESOLUTION')
        .every((m) => typeof m.payload['text'] === 'string' && m.payload['turnId'] === turnId),
    );

    // GM-просмотр хода: actionCount = 3 (по одному на игрока).
    const turnView = await get(`/turns/${turnId}`, gmToken);
    report.checks['gm_sees_action_count_3'] = turnView.status === 200 && turnView.body['actionCount'] === 3;

    report.details = {
      forbiddenKeys: FORBIDDEN_IN_BROADCAST.length,
      gmMessages: gm.messages.length,
      playerMessages: pcs.map((c) => c.messages.length),
    };
  } finally {
    clearInterval(outboxTimer);
    for (const client of clients) {
      try {
        client.ws.terminate();
      } catch {
        /* игнор */
      }
    }
    for (const off of detach) off();
    await app.close();
    await boot.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (cause) {
  report.details['fatal'] = cause instanceof Error ? cause.message : String(cause);
  process.exitCode = 1;
}
process.stdout.write(`${JSON.stringify(report)}\n`);
