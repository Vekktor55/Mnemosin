import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import type { WebSocket } from '@fastify/websocket';
import { InputStreamId, WsClientEnvelopeSchema, WS_CLOSE_CODE, type WsErrorCode } from '@mnemosin/contracts';

import { closeWithCode, extractHandshakeToken } from './auth.js';
import { ConnectionRegistry, WsConnectionRecord } from './connection-registry.js';
import type { ConnectionActorContext, WsConnectionState, WsGatewayDeps } from './deps.js';
import { SceneReplicationService } from './replication.js';
import { routeWsMessage } from './router.js';
import { HotSchedulerSupervisor } from './scheduler-supervisor.js';

export interface WsGatewayHandle {
  readonly registry: ConnectionRegistry;
  closeAll(): void;
}

export async function registerWsGateway(app: FastifyInstance, deps: WsGatewayDeps): Promise<WsGatewayHandle> {
  await app.register(websocketPlugin, {
    options: {
      maxPayload: deps.limits.wsMaxPayloadBytes,
      handleProtocols: (protocols: Set<string>) =>
        [...protocols].find((protocol) => protocol.startsWith('mnemosin.v1.')) ?? false,
    },
  });

  const registry = new ConnectionRegistry();
  const connectionsByIp = new Map<string, number>();
  const pendingSockets = new Set<WebSocket>();
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const isBackpressured = deps.isBackpressured ?? ((buffered, limit) => buffered > limit);
  const replication = new SceneReplicationService(deps, registry);
  const envelope = replication.envelope;
  deps.hot.setTickListener((result) => replication.publish(result));

  function sendError(record: WsConnectionRecord, code: WsErrorCode, messageKey: string, retryable: boolean): void {
    replication.sendReliable(record, envelope('connection:error', { code, messageKey, retryable }));
  }

  function handleMessage(record: WsConnectionRecord, raw: Buffer): void {
    record.lastHeartbeatAt = now();
    if (record.state === 'closing' || record.state === 'closed') return;
    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      sendError(record, 'PROTOCOL_INVALID_JSON', 'protocol.invalid_json', false);
      return;
    }
    const parsed = WsClientEnvelopeSchema.safeParse(json);
    if (!parsed.success) {
      sendError(record, 'PROTOCOL_INVALID_MESSAGE', 'protocol.invalid_message', false);
      return;
    }
    routeWsMessage(record, parsed.data, {
      runtime: deps.hot.runtime,
      replication,
      now,
      inputRatePerSecond: deps.limits.inputRatePerSecond,
      sendError,
    });
  }

  async function authenticate(
    socket: WebSocket,
    token: string,
    isActive: () => boolean,
  ): Promise<WsConnectionRecord | undefined> {
    const result = await deps.authenticate(token);
    // Поздний ответ после timeout/close не имеет побочных эффектов на runtime/registry.
    if (!isActive()) return undefined;
    if (!result.ok) {
      const code = result.code === 'AUTH_FORBIDDEN' ? WS_CLOSE_CODE.AUTH_FORBIDDEN : WS_CLOSE_CODE.AUTH_INVALID;
      closeWithCode(socket, code, { code: result.code }, deps.logger);
      return undefined;
    }
    const { actor } = result;
    const context: ConnectionActorContext = {
      ...actor,
      connectionId: newId(),
      connectionEpoch: registry.nextEpoch(actor.actorId),
    };
    const inputStreamId = InputStreamId.parse(newId());
    const previous = registry.controlling(actor.actorId, context.connectionId);
    if (previous !== undefined) {
      previous.state = 'closing';
      closeWithCode(previous.socket, 4409, { code: 'CONNECTION_SUPERSEDED' }, deps.logger);
      registry.remove(previous.context.connectionId);
    }
    if (actor.actorType === 'player') deps.hot.runtime.activateInputStream(actor.actorId, inputStreamId);

    const record = new WsConnectionRecord(socket, context, inputStreamId, deps.limits, isBackpressured);
    record.lastHeartbeatAt = now();
    record.rateWindowStartedAt = now();
    registry.add(record);
    record.delivery.enqueueReliable(
      envelope('connection:welcome', {
        protocolVersion: 'v1',
        serverVersion: deps.serverVersion,
        contractsVersion: deps.contractsVersion,
        matchId: actor.matchId,
        sessionId: actor.sessionId,
        connectionId: context.connectionId,
        connectionEpoch: context.connectionEpoch,
        actorId: actor.actorId,
        actorType: actor.actorType,
        inputStreamId,
        projectionKind: actor.projectionKind,
        permissions: [...actor.permissions],
        isReconnect: context.connectionEpoch > 1,
        supportedFeatures: ['scene:keyframe', 'scene:delta', 'scene:resync', 'scene:input-ack'],
      }),
    );
    return record;
  }

  app.get('/ws', { websocket: true }, (socket: WebSocket, request) => {
    let lifecycleState: WsConnectionState = 'unauthenticated';
    let record: WsConnectionRecord | undefined;
    let released = false;
    const authTimeout: { handle: ReturnType<typeof setTimeout> | undefined } = { handle: undefined };
    // Security budget не доверяет X-Forwarded-For/request.ip: trusted-proxy allowlist
    // не задан. До отдельного deployment-контракта используется только socket peer.
    const remoteIp = normalizeRemoteIp(request.socket.remoteAddress);

    const release = (): void => {
      if (released) return;
      released = true;
      if (authTimeout.handle !== undefined) clearTimeout(authTimeout.handle);
      pendingSockets.delete(socket);
      const count = connectionsByIp.get(remoteIp);
      if (count === undefined || count <= 1) connectionsByIp.delete(remoteIp);
      else connectionsByIp.set(remoteIp, count - 1);
    };
    const removeRecord = (): void => {
      lifecycleState = 'closed';
      if (record !== undefined) registry.remove(record.context.connectionId);
      release();
    };

    socket.once('close', removeRecord);
    socket.once('error', removeRecord);
    socket.on('message', (raw: Buffer) => {
      if (record === undefined) {
        if (lifecycleState === 'closing' || lifecycleState === 'closed' || socket.readyState !== 1) return;
        socket.send(
          JSON.stringify(
            envelope('connection:error', {
              code: 'CONNECTION_NOT_READY',
              messageKey: 'connection.authenticating',
              retryable: true,
            }),
          ),
        );
        return;
      }
      handleMessage(record, raw);
      lifecycleState = record.state;
    });

    // Pending и authenticated sockets занимают один и тот же per-IP бюджет.
    const currentIpConnections = connectionsByIp.get(remoteIp) ?? 0;
    connectionsByIp.set(remoteIp, currentIpConnections + 1);
    pendingSockets.add(socket);
    if (currentIpConnections >= deps.limits.wsMaxConnectionsPerIp) {
      lifecycleState = 'closing';
      closeWithCode(socket, WS_CLOSE_CODE.RATE_LIMIT, { code: 'RATE_LIMIT' }, deps.logger);
      return;
    }

    const handshake = extractHandshakeToken(request.headers['sec-websocket-protocol']);
    if (handshake === null) {
      lifecycleState = 'closing';
      closeWithCode(socket, WS_CLOSE_CODE.AUTH_INVALID, { code: 'AUTH_INVALID' }, deps.logger);
      return;
    }
    lifecycleState = 'authenticating';
    authTimeout.handle = setTimeout(() => {
      if (lifecycleState !== 'authenticating') return;
      lifecycleState = 'closing';
      closeWithCode(socket, WS_CLOSE_CODE.IDLE_TIMEOUT, { code: 'AUTH_TIMEOUT' }, deps.logger);
    }, deps.limits.wsAuthTimeoutMs);
    authTimeout.handle.unref();

    void authenticate(socket, handshake.token, () => lifecycleState === 'authenticating' && socket.readyState === 1)
      .then((authenticated) => {
        if (authenticated === undefined) return;
        if (lifecycleState !== 'authenticating' || socket.readyState !== 1) {
          authenticated.state = 'closed';
          registry.remove(authenticated.context.connectionId);
          return;
        }
        record = authenticated;
        pendingSockets.delete(socket);
        lifecycleState = authenticated.state;
      })
      .catch(() => {
        if (lifecycleState !== 'authenticating') return;
        lifecycleState = 'closing';
        closeWithCode(socket, WS_CLOSE_CODE.INTERNAL, { code: 'INTERNAL' }, deps.logger);
      })
      .finally(() => {
        if (authTimeout.handle !== undefined) clearTimeout(authTimeout.handle);
      });
  });

  const heartbeat = setInterval(() => {
    for (const record of registry.all()) {
      if (now() - record.lastHeartbeatAt > deps.limits.heartbeat.idleTimeoutMs) {
        record.state = 'closing';
        closeWithCode(record.socket, WS_CLOSE_CODE.IDLE_TIMEOUT, { code: 'IDLE_TIMEOUT' }, deps.logger);
        registry.remove(record.context.connectionId);
      } else {
        record.delivery.flush();
      }
    }
  }, deps.limits.heartbeat.intervalMs);
  heartbeat.unref();
  const schedulerSupervisor = new HotSchedulerSupervisor(deps.hot.scheduler, deps.limits.schedulerRecoveryIntervalMs);
  schedulerSupervisor.start();

  return {
    registry,
    closeAll() {
      clearInterval(heartbeat);
      schedulerSupervisor.stop();
      for (const socket of pendingSockets) closeWithCode(socket, 1001, { code: 'SERVER_BUSY' }, deps.logger);
      pendingSockets.clear();
      registry.closeAll();
    },
  };
}

function normalizeRemoteIp(ip: string | undefined): string {
  const normalized = ip?.trim().toLowerCase() ?? '';
  if (normalized.startsWith('::ffff:')) return normalized.slice('::ffff:'.length);
  return normalized || 'unknown';
}
