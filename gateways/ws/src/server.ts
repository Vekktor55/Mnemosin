import { randomUUID } from 'node:crypto';

import { CONTRACTS_VERSION, WS_CLOSE_CODE, nowIso, type ConnectionId, type SessionId } from '@mnemosin/contracts';
import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from '@fastify/websocket';

import {
  WS_SUBPROTOCOL_PREFIX,
  authClosePayloadOf,
  closeWithCode,
  extractHandshakeToken,
  verifyWsToken,
  type WsIdentity,
} from './auth.js';
import { attachWsBroadcast } from './broadcast.js';
import { ConnectionRegistry, type WsConnectionRecord } from './connection-registry.js';
import type { RequestDedupeCache } from './dedupe.js';
import type { WsGatewayDeps } from './deps.js';
import { WsBroadcaster, type ServerEnvelope } from './projections.js';
import { ConnectionRateLimiter } from './rate-limit.js';
import { createWsRouter, type WsConnectionState } from './router.js';

/**
 * WS-сервер (промпт 1.11, п.1–3, 7): @fastify/websocket на /ws.
 *
 * Handshake-авторизация (D123): subprotocol `mnemosin.v1.<jwt>` приоритетнее
 * `?token=`; невалидный/истёкший токен → close 4401 {code:'AUTH_INVALID'|
 * 'AUTH_EXPIRED'}; токена нет → окно wsAuthTimeoutMs на AUTH{token}, иначе
 * close 4408 (D267). Лимиты соединений: wsMaxConnectionsPerIp /
 * wsMaxConnectionsPerPlayer → close 4429 RATE_LIMIT.
 *
 * После авторизации: HELLO{serverVersion, contractsVersion, capabilities} →
 * AUTH_OK{playerId, sessionId, isGM} (F-10.6) → фиксированная reconnect-
 * последовательность (A1.9, v3 §VI.8): STATE_PROJECTION →
 * STATE_PROJECTION_PRIVATE → TURN_UPDATE (текущий ход) → SESSION_STATUS →
 * PLAYER_PRESENCE. HISTORY — только по явному запросу клиента.
 *
 * Heartbeat (D277 — один интервал на gateway): сервер шлёт protocol-PING
 * каждые heartbeat.intervalMs; нет PONG/сообщений idleTimeoutMs → close 4408.
 * Клиентский app-level PING → PONG (router).
 */

export interface WsGatewayHandle {
  readonly registry: ConnectionRegistry;
  readonly broadcaster: WsBroadcaster;
  readonly dedupe: RequestDedupeCache<ServerEnvelope>;
  /** Отписка от шины + остановка heartbeat (вызывается при shutdown). */
  detach(): void;
  /** Закрыть все соединения (graceful shutdown — до outbox drain). */
  closeAll(): void;
  /** presenceSweep-джоб: чистка мёртвых сокетов и истёкшего dedupe-кэша. */
  sweep(): void;
}

export async function registerWsGateway(app: FastifyInstance, deps: WsGatewayDeps): Promise<WsGatewayHandle> {
  const logger = deps.logger;
  const registry = new ConnectionRegistry();
  const broadcaster = new WsBroadcaster(registry, logger);
  // Сборочная правка (промпт 1.12): exactOptionalPropertyTypes не позволяет
  // передавать `logger: WsGatewayLog | undefined` в опциональное свойство —
  // условный spread сохраняет прежнее поведение без изменения типов портов.
  const loggerProp = logger === undefined ? {} : { logger };
  const broadcast = attachWsBroadcast({ deps, registry, broadcaster, ...loggerProp });

  await app.register(websocket, {
    options: {
      maxPayload: deps.limits.wsMaxPayloadBytes,
      // D123: эхо subprotocol только для mnemosin.v1.* (иначе браузер-клиент
      // сам закроет соединение); query-токен и AUTH-окно работают без subprotocol.
      handleProtocols: (protocols: Set<string>) => {
        for (const protocol of protocols) {
          if (protocol.startsWith(WS_SUBPROTOCOL_PREFIX)) return protocol;
        }
        return false;
      },
    },
  });

  /** Таймеры окна авторизации (D267): connectionId → снять таймер. */
  const authTimers = new Map<string, () => void>();

  const router = createWsRouter({
    deps,
    registry,
    broadcaster,
    ...loggerProp,
    hooks: {
      onAuth: async (state, token) => {
        await authenticate(state, token);
      },
      onLeave: (state) => {
        try {
          state.socket.close(1000, 'left');
        } catch {
          state.socket.terminate();
        }
      },
    },
  });

  app.get('/ws', { websocket: true }, (socket, req) => {
    void handleUpgrade(socket, req);
  });

  // ------------------------------------------------------------- соединение

  async function handleUpgrade(socket: WebSocket, req: FastifyRequest): Promise<void> {
    const ip = req.ip;
    if (registry.countByIp(ip) >= deps.limits.wsMaxConnectionsPerIp) {
      closeWithCode(
        socket,
        WS_CLOSE_CODE.RATE_LIMIT,
        { code: 'RATE_LIMIT', message: 'слишком много соединений с адреса' },
        logger,
      );
      return;
    }

    const state: WsConnectionState = {
      connectionId: randomUUID() as ConnectionId,
      ip,
      socket,
      auth: null,
      rate: new ConnectionRateLimiter(deps.limits.wsRatePerConnection),
    };

    let finalized = false;
    const finalize = (): void => {
      if (finalized) return;
      finalized = true;
      authTimers.get(String(state.connectionId))?.();
      authTimers.delete(String(state.connectionId));
      const removed = registry.remove(state.connectionId);
      if (removed !== undefined) {
        // Соединение ≠ игрок (D278): статус DISCONNECTED только когда соединений не осталось.
        publishPresence(removed);
      }
    };

    socket.on('pong', () => registry.touch(state.connectionId, Date.now()));
    socket.on('close', finalize);
    socket.on('error', (cause: unknown) => {
      logger?.debug({ err: cause, event: 'ws_socket_error' }, 'ws_socket_error');
      finalize();
    });
    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      // Любой входящий кадр — признак жизни (heartbeat idle-check).
      registry.touch(state.connectionId, Date.now());
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8');
      void router.handle(state, text).catch((cause: unknown) => {
        logger?.error({ err: cause, event: 'ws_router_failed' }, 'ws_router_failed');
      });
    });

    const handshake = extractHandshakeToken(socket.protocol || undefined, req.url ?? '');
    if (handshake === null) {
      // D267: окно неаутентифицированного соединения — ждём AUTH{token}.
      const authTimer = setTimeout(() => {
        closeWithCode(
          socket,
          WS_CLOSE_CODE.IDLE_TIMEOUT,
          { code: 'AUTH_TIMEOUT', message: 'окно авторизации истекло' },
          logger,
        );
      }, deps.limits.wsAuthTimeoutMs);
      authTimer.unref?.();
      authTimers.set(String(state.connectionId), () => clearTimeout(authTimer));
      return;
    }

    try {
      const identity = await verifyWsToken(deps, handshake.token);
      await onAuthenticated(state, identity);
    } catch (cause) {
      const { closeCode, payload } = authClosePayloadOf(cause);
      closeWithCode(socket, closeCode, payload, logger);
      logger?.debug(
        {
          reason: cause instanceof Error ? cause.message : 'invalid',
          source: handshake.source,
          event: 'ws_auth_failed',
        },
        'ws_auth_failed',
      );
    }
  }

  /** AUTH{token} внутри окна (D267). */
  async function authenticate(state: WsConnectionState, token: string): Promise<void> {
    try {
      const identity = await verifyWsToken(deps, token);
      await onAuthenticated(state, identity);
    } catch (cause) {
      const { closeCode, payload } = authClosePayloadOf(cause);
      closeWithCode(state.socket, closeCode, payload, logger);
    }
  }

  async function onAuthenticated(state: WsConnectionState, identity: WsIdentity): Promise<void> {
    authTimers.get(String(state.connectionId))?.();
    authTimers.delete(String(state.connectionId));
    if (registry.countByPlayer(identity.playerId) >= deps.limits.wsMaxConnectionsPerPlayer) {
      // Multi-tab лимит (детальная обработка — этап 3).
      closeWithCode(
        state.socket,
        WS_CLOSE_CODE.RATE_LIMIT,
        { code: 'RATE_LIMIT', message: 'превышен лимит соединений игрока' },
        logger,
      );
      return;
    }
    if (state.auth !== null) return; // повторный AUTH — идемпотентный no-op
    state.auth = identity;

    const at = nowIso();
    const record: WsConnectionRecord = {
      connectionId: state.connectionId,
      playerId: identity.playerId,
      sessionId: identity.sessionId,
      isGM: identity.isGM,
      ip: state.ip,
      socket: state.socket,
      connectedAt: at,
      subscribedAt: at,
      lastPongAt: Date.now(),
    };
    registry.add(record);
    logger?.info(
      {
        connectionId: state.connectionId,
        sessionId: identity.sessionId,
        isGM: identity.isGM,
        event: 'ws_connected',
      },
      'ws_connected',
    );

    const conn = { kind: 'connection', connectionId: state.connectionId } as const;
    // 1. HELLO → 2. AUTH_OK (F-10.6: isGM — клиент сразу знает роль).
    broadcaster.send(
      'HELLO',
      {
        serverVersion: deps.serverVersion,
        contractsVersion: CONTRACTS_VERSION,
        capabilities: deps.getCapabilities(),
      },
      conn,
    );
    broadcaster.send(
      'AUTH_OK',
      { playerId: identity.playerId, sessionId: identity.sessionId, isGM: identity.isGM },
      conn,
    );
    // 3. Reconnect-контракт (A1.9): фиксированный порядок, покрыт тестом.
    // Presence остальным соединениям — ПОСЛЕ последовательности: собственный
    // поток клиента детерминирован (HELLO → AUTH_OK → 5 сообщений п.7).
    await sendReconnectSequence(state, identity, conn);
    publishPresence(record, record.connectionId);
  }

  /** П.7: STATE_PROJECTION → STATE_PROJECTION_PRIVATE → TURN_UPDATE → SESSION_STATUS → PLAYER_PRESENCE. */
  async function sendReconnectSequence(
    state: WsConnectionState,
    identity: WsIdentity,
    conn: { kind: 'connection'; connectionId: ConnectionId },
  ): Promise<void> {
    const sessionId: SessionId = identity.sessionId;
    try {
      const publicView = await deps.projections.publicGameState(sessionId);
      broadcaster.send('STATE_PROJECTION', publicView, conn, { sessionId });
      const privateView = await deps.projections.playerGameState(sessionId, identity.playerId);
      broadcaster.send('STATE_PROJECTION_PRIVATE', privateView, conn, { sessionId });
      const session = await deps.sessions.getSession(sessionId);
      if (session.currentTurnId !== null) {
        // D268: myActions адресата допустимы — сообщение уходит ОДНОМУ соединению.
        const turnView = await deps.turns.getTurnView(session.currentTurnId, identity.playerId);
        broadcaster.send('TURN_UPDATE', turnView, conn, { sessionId });
      }
      broadcaster.send('SESSION_STATUS', { sessionId, from: session.status, to: session.status }, conn);
      broadcaster.send(
        'PLAYER_PRESENCE',
        {
          sessionId,
          playerId: identity.playerId,
          status: 'ACTIVE',
          connections: registry.countByPlayer(identity.playerId),
        },
        conn,
      );
    } catch (cause) {
      // Best-effort: клиент догонит состояние следующими STATE_PROJECTION.
      logger?.error(
        { err: cause, connectionId: state.connectionId, event: 'ws_reconnect_state_failed' },
        'ws_reconnect_state_failed',
      );
    }
  }

  function publishPresence(record: WsConnectionRecord, excludeConnectionId?: ConnectionId): void {
    const connections = registry.countByPlayer(record.playerId);
    const payload = {
      sessionId: record.sessionId,
      playerId: record.playerId,
      status: (connections > 0 ? 'ACTIVE' : 'DISCONNECTED') as 'ACTIVE' | 'DISCONNECTED',
      connections,
    };
    try {
      for (const peer of registry.listBySession(record.sessionId)) {
        if (peer.connectionId === excludeConnectionId) continue;
        broadcaster.send('PLAYER_PRESENCE', payload, { kind: 'connection', connectionId: peer.connectionId });
      }
    } catch (cause) {
      logger?.warn({ err: cause, event: 'ws_presence_failed' }, 'ws_presence_failed');
    }
  }

  // --------------------------------------------------------------- heartbeat

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const record of registry.listAll()) {
      if (now - record.lastPongAt > deps.limits.heartbeat.idleTimeoutMs) {
        closeWithCode(
          record.socket,
          WS_CLOSE_CODE.IDLE_TIMEOUT,
          { code: 'IDLE_TIMEOUT', message: 'heartbeat: нет ответа' },
          logger,
        );
        continue;
      }
      try {
        record.socket.ping();
      } catch {
        /* закроет sweep/close-обработчик */
      }
    }
  }, deps.limits.heartbeat.intervalMs);
  heartbeat.unref();

  return {
    registry,
    broadcaster,
    dedupe: router.dedupe,
    detach(): void {
      broadcast.detach();
      clearInterval(heartbeat);
    },
    closeAll(): void {
      for (const record of registry.listAll()) {
        try {
          record.socket.close(1001, 'server shutting down');
        } catch {
          record.socket.terminate();
        }
      }
    },
    sweep(): void {
      for (const record of registry.sweepClosed()) publishPresence(record);
      router.dedupe.sweep();
    },
  };
}
