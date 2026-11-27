/**
 * WSClient v4 (P05-B): типизированный клиент поверх WsClientEnvelope/WsServerEnvelope.
 *
 * - handshake: subprotocol `mnemosin.v1.<jwt>` (D123, NET-01 не меняется);
 * - lifecycle: connection:welcome → connection:client-ready → scene:keyframe →
 *   connection:ready → live delta/input-ack;
 * - RTT/server time: connection:ping/pong (pendingPings);
 * - reconnect: новый connectionEpoch/inputStreamId приходит в welcome; старые
 *   pending inputs/deltas/interpolation сбрасываются (scene:input не replay);
 * - sequence gap / смена worldEpoch: scene:resync.
 *
 * Инвариант 15: только @mnemosin/contracts; никакого core/gateways.
 */
import {
  MessageId,
  SceneSequence,
  WorldEpoch,
  WS_CLOSE_CODE,
  WsServerEnvelopeSchema,
  type SceneKeyframePayload,
  type SceneDeltaPayload,
  type SceneResyncMessage,
  type WsClientEnvelope,
  type WsClientMessageType,
  type WsServerEnvelope,
  type WsServerMessageType,
} from '@mnemosin/contracts';

import { backoffDelayMs, DEFAULT_HEARTBEAT_LIMITS, DEFAULT_RECONNECT_LIMITS } from './backoff.js';
import type { HeartbeatLimits, ReconnectLimits } from './backoff.js';
import { newMessageId } from '../lib/ids.js';
import { oneWayDelayMs, shouldDrop, type NetworkProfile } from '../game-world/net/profile.js';

export type ConnectionStatus = 'IDLE' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'FAILED' | 'CLOSED';

export interface ConnectionSnapshot {
  readonly status: ConnectionStatus;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly nextRetryAt: number | null;
  readonly reason: string | null;
  readonly closeCode: number | null;
}

export const IDLE_SNAPSHOT: ConnectionSnapshot = Object.freeze({
  status: 'IDLE',
  attempt: 0,
  maxAttempts: DEFAULT_RECONNECT_LIMITS.maxAttempts,
  nextRetryAt: null,
  reason: null,
  closeCode: null,
});

export interface WSClientOptions {
  readonly url: string;
  readonly token: string;
  readonly onStatus?: (snapshot: ConnectionSnapshot) => void;
  readonly onKeyframe?: (keyframe: SceneKeyframePayload) => void;
  readonly onDelta?: (delta: SceneDeltaPayload) => void;
  readonly onReady?: () => void;
  readonly onResyncRequired?: (reason: string) => void;
  readonly onClose?: (code: number) => void;
  readonly reconnect?: Partial<ReconnectLimits>;
  readonly heartbeat?: Partial<HeartbeatLimits>;
  /** Искусственный сетевой профиль (только тесты/E2E; production не задаёт). */
  readonly networkProfile?: NetworkProfile | null;
  /** Инжектируемый rng для детерминированных тестов impairment. */
  readonly rng?: () => number;
}

export interface ConnectionInfo {
  readonly connectionId: string;
  readonly connectionEpoch: number;
  readonly inputStreamId: string;
  readonly actorId: string;
  readonly actorType: 'player' | 'observer' | 'developer';
  readonly projectionKind: 'player' | 'observer';
  readonly matchId: string;
  readonly isReconnect: boolean;
  readonly lastSceneSequence: number | null;
  readonly worldEpoch: number | null;
  readonly lastRttMs: number | null;
}

type ServerHandler = (message: WsServerEnvelope) => void;

/**
 * Именованные alias'ы типов сообщений.
 *
 * Нужны, чтобы структурный порт `game-world/ports.ts` и сам WSClient
 * использовали ОДИН и тот же тип: при инлайновом `Extract<..., { type: T }>`
 * TypeScript разворачивает отложенный conditional по-разному в source и
 * target-позициях и считает сигнатуры несовместимыми.
 */
export type WsServerMessage<TType extends WsServerMessageType> = Extract<WsServerEnvelope, { type: TType }>;
export type WsClientPayload<TType extends WsClientMessageType> = Extract<WsClientEnvelope, { type: TType }>['payload'];

/** Субпротокол handshake (D123): `mnemosin.v1.<jwt>`; токен никогда не в URL. */
export function wsSubprotocol(token: string): string {
  return `mnemosin.v1.${token}`;
}

export class WSClient {
  private readonly url: string;
  private readonly token: string;
  private readonly limits: ReconnectLimits;
  private readonly heartbeatLimits: HeartbeatLimits;
  private readonly onStatus: ((snapshot: ConnectionSnapshot) => void) | null;
  private readonly onKeyframe: WSClientOptions['onKeyframe'] | null;
  private readonly onDelta: WSClientOptions['onDelta'] | null;
  private readonly onReady: WSClientOptions['onReady'] | null;
  private readonly onResyncRequired: WSClientOptions['onResyncRequired'] | null;
  private readonly onClose: WSClientOptions['onClose'] | null;
  private readonly networkProfile: NetworkProfile | null;
  private readonly rng: () => number;

  private readonly handlers = new Map<WsServerMessageType, Set<ServerHandler>>();
  private socket: WebSocket | null = null;
  private snapshot: ConnectionSnapshot = IDLE_SNAPSHOT;

  private connectionInfo: ConnectionInfo | null = null;
  private ready = false;
  /** §4.2: `connection:client-ready` отправляется один раз на connection lifecycle. */
  private clientReadySent = false;
  private manualClose = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastAliveAt = 0;
  private readonly pendingPings = new Map<string, number>();

  constructor(options: WSClientOptions) {
    this.url = options.url;
    this.token = options.token;
    this.onStatus = options.onStatus ?? null;
    this.onKeyframe = options.onKeyframe ?? null;
    this.onDelta = options.onDelta ?? null;
    this.onReady = options.onReady ?? null;
    this.onResyncRequired = options.onResyncRequired ?? null;
    this.onClose = options.onClose ?? null;
    this.limits = { ...DEFAULT_RECONNECT_LIMITS, ...options.reconnect };
    this.heartbeatLimits = { ...DEFAULT_HEARTBEAT_LIMITS, ...options.heartbeat };
    this.networkProfile = options.networkProfile ?? null;
    this.rng = options.rng ?? Math.random;
    this.snapshot = { ...IDLE_SNAPSHOT, maxAttempts: this.limits.maxAttempts };
  }

  // ------------------------------------------------------------------ public

  connect(): void {
    this.manualClose = false;
    this.setStatus({ ...this.snapshot, status: 'CONNECTING', reason: null, closeCode: null });
    this.openSocket();
  }

  reconnectNow(): void {
    this.clearRetryTimer();
    this.teardownSocket();
    this.setStatus({ ...IDLE_SNAPSHOT, maxAttempts: this.limits.maxAttempts });
    this.connect();
  }

  close(): void {
    this.manualClose = true;
    this.clearRetryTimer();
    this.stopHeartbeat();
    this.ready = false;
    this.teardownSocket();
    this.setStatus({ ...this.snapshot, status: 'CLOSED', nextRetryAt: null });
  }

  on<T extends WsServerMessageType>(type: T, handler: (message: WsServerMessage<T>) => void): () => void {
    const set = this.handlers.get(type) ?? new Set<ServerHandler>();
    const wrapped: ServerHandler = (message) => handler(message as WsServerMessage<T>);
    set.add(wrapped);
    this.handlers.set(type, set);
    return () => {
      set.delete(wrapped);
    };
  }

  send<T extends WsClientMessageType>(type: T, payload: WsClientPayload<T>): void {
    const envelope: WsClientEnvelope = {
      protocolVersion: 'v1',
      schemaVersion: 1,
      messageId: MessageId.parse(newMessageId()),
      type,
      payload,
    } as WsClientEnvelope;
    this.rawSend(envelope);
  }

  isReady(): boolean {
    return this.ready;
  }

  getConnectionInfo(): ConnectionInfo | null {
    return this.connectionInfo;
  }

  getSnapshot(): ConnectionSnapshot {
    return this.snapshot;
  }

  /**
   * §4.2 шаг 7: `connection:client-ready` — клиент зарегистрировал handlers и
   * готов принять `scene:keyframe`.
   *
   * Отправляется ЯВНО, а не автоматически в обработчике `connection:welcome`:
   * сервер отвечает keyframe немедленно, поэтому ранняя отправка приводила к
   * потере первого keyframe (клиент ещё не подписался на события сцены).
   * Возвращает false, если сокет ещё не открыт.
   */
  sendClientReady(): boolean {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
    if (this.clientReadySent) return true;
    this.clientReadySent = true;
    this.send('connection:client-ready', {});
    return true;
  }

  /**
   * §17.4: запрос полного keyframe. `lastAppliedSceneSequence` — последняя
   * ПРИМЕНЁННАЯ клиентом sequence; если не задана, берётся последняя полученная.
   */
  requestResync(
    reason: SceneResyncMessage['reason'],
    options?: { readonly lastAppliedSceneSequence?: number | null },
  ): void {
    const info = this.connectionInfo;
    const explicit = options?.lastAppliedSceneSequence;
    const sequence = explicit !== null && explicit !== undefined ? explicit : (info?.lastSceneSequence ?? null);
    this.send('scene:resync', {
      ...(sequence !== null ? { lastAppliedSceneSequence: SceneSequence.parse(sequence) } : {}),
      ...(info?.worldEpoch !== null && info?.worldEpoch !== undefined
        ? { worldEpoch: WorldEpoch.parse(info.worldEpoch) }
        : {}),
      reason,
    });
  }

  // ----------------------------------------------------------------- socket

  private openSocket(): void {
    this.teardownSocket();
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url, [wsSubprotocol(this.token)]);
    } catch (cause) {
      this.handleFailure(cause instanceof Error ? cause.message : 'не удалось создать WebSocket');
      return;
    }
    this.socket = socket;
    this.lastAliveAt = Date.now();

    socket.onopen = () => {
      this.lastAliveAt = Date.now();
    };
    socket.onmessage = (event: MessageEvent) => {
      this.lastAliveAt = Date.now();
      const raw = typeof event.data === 'string' ? event.data : '';
      this.handleIncoming(raw);
    };
    socket.onerror = () => {
      /* браузер всегда следует onerror → onclose: обработка там */
    };
    socket.onclose = (event: CloseEvent) => {
      this.handleClose(event);
    };
  }

  private teardownSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket === null) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, 'client teardown');
      }
    } catch {
      /* сокет уже мёртв */
    }
  }

  private rawSend(envelope: WsClientEnvelope): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    // Искусственная деградация — движение (scene:input) и RTT-проба (ping);
    // handshake/control сообщения не дропаются, чтобы welcome/keyframe/ready
    // оставались детерминированными.
    const impaired =
      (envelope.type === 'scene:input' || envelope.type === 'connection:ping') && this.networkProfile !== null;
    if (impaired && shouldDrop(this.networkProfile as NetworkProfile, this.rng)) return;
    const delay = impaired ? this.impairmentDelay() : 0;
    const sendNow = (): void => {
      const current = this.socket;
      if (current === null || current.readyState !== WebSocket.OPEN) return;
      current.send(JSON.stringify(envelope));
    };
    if (delay > 0) setTimeout(sendNow, delay);
    else sendNow();
  }

  private handleIncoming(raw: string): void {
    if (raw.length === 0) return;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      console.warn('ws-client: не-JSON кадр игнорирован');
      return;
    }
    const parsed = WsServerEnvelopeSchema.safeParse(json);
    if (!parsed.success) {
      console.warn('ws-client: кадр не прошёл WsServerEnvelopeSchema — игнорирован');
      return;
    }
    const message = parsed.data;
    if (this.isImpairedIncoming(message.type)) {
      if (shouldDrop(this.networkProfile as NetworkProfile, this.rng)) return;
      const delay = this.impairmentDelay();
      if (delay > 0) {
        setTimeout(() => this.dispatch(message), delay);
        return;
      }
    }
    this.dispatch(message);
  }

  private dispatch(message: WsServerEnvelope): void {
    this.handleProtocol(message);
    const set = this.handlers.get(message.type);
    if (set !== undefined) {
      for (const handler of [...set]) handler(message);
    }
  }

  /** Протокольная логика клиента — до пользовательских обработчиков. */
  private handleProtocol(message: WsServerEnvelope): void {
    switch (message.type) {
      case 'connection:welcome': {
        const info = this.connectionInfo;
        const isReconnect = info !== null;
        this.connectionInfo = {
          connectionId: message.payload.connectionId,
          connectionEpoch: message.payload.connectionEpoch,
          inputStreamId: message.payload.inputStreamId,
          actorId: message.payload.actorId,
          actorType: message.payload.actorType,
          projectionKind: message.payload.projectionKind,
          matchId: message.payload.matchId,
          isReconnect: message.payload.isReconnect || isReconnect,
          lastSceneSequence: null,
          worldEpoch: null,
          lastRttMs: null,
        };
        this.ready = false;
        this.setStatus({
          status: 'CONNECTED',
          attempt: 0,
          maxAttempts: this.limits.maxAttempts,
          nextRetryAt: null,
          reason: null,
          closeCode: null,
        });
        this.startHeartbeat();
        // Reconnect: сброс буферов/deltas происходит в GameWorld по welcome;
        // movement inputs никогда не replay (новый inputStreamId).
        // `connection:client-ready` уходит из sendClientReady() — только после
        // регистрации handlers и готовности renderer (§4.2 шаг 7).
        this.clientReadySent = false;
        break;
      }
      case 'scene:keyframe': {
        const info = this.connectionInfo;
        if (info !== null) {
          this.connectionInfo = {
            ...info,
            lastSceneSequence: message.payload.sceneSequence,
            worldEpoch: message.payload.worldEpoch,
          };
        }
        this.onKeyframe?.(message.payload);
        break;
      }
      case 'scene:delta': {
        const info = this.connectionInfo;
        const delta = message.payload;
        if (info !== null) {
          const gap = info.lastSceneSequence !== null && delta.baseSceneSequence !== info.lastSceneSequence;
          const epochChange = info.worldEpoch !== null && delta.worldEpoch !== info.worldEpoch;
          if (gap || epochChange) {
            this.requestResync('sequence_gap');
            break;
          }
          this.connectionInfo = {
            ...info,
            lastSceneSequence: delta.sceneSequence,
            worldEpoch: delta.worldEpoch,
          };
        }
        this.onDelta?.(delta);
        break;
      }
      case 'connection:pong': {
        const sentAt = this.pendingPings.get(message.payload.pingId);
        if (sentAt !== undefined) {
          this.pendingPings.delete(message.payload.pingId);
          const rtt = Math.max(0, Date.now() - sentAt);
          const info = this.connectionInfo;
          if (info !== null) this.connectionInfo = { ...info, lastRttMs: rtt };
        }
        break;
      }
      case 'connection:ready':
        this.ready = true;
        this.onReady?.();
        this.probeRtt();
        break;
      case 'scene:resync-required':
        this.onResyncRequired?.(message.payload.reason);
        break;
      case 'connection:error':
        /* ERROR не фатален для состояния сцены; reason доступен подписчикам. */
        break;
      case 'scene:input-ack':
        /* ack обрабатывается подписчиками GameWorld; протокольной логики нет. */
        break;
      case 'scene:durable-event':
        /* Reliable P06 channel: не coalescing и не interpolation; отдаётся подписчикам. */
        break;
    }
  }

  // --------------------------------------------------------------- heartbeat

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const socket = this.socket;
      if (!this.connectionInfo || socket === null || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastAliveAt > this.heartbeatLimits.idleTimeoutMs) {
        console.warn('ws-client: heartbeat-таймаут — принудительный реконнект');
        try {
          socket.close(4000, 'heartbeat timeout');
        } catch {
          this.handleFailure('heartbeat timeout');
        }
        return;
      }
      this.probeRtt();
    }, this.heartbeatLimits.intervalMs);
  }

  /** Отправить connection:ping и зафиксировать время для RTT-оценки. */
  private probeRtt(): void {
    const pingId = newMessageId();
    this.pendingPings.set(pingId, Date.now());
    this.send('connection:ping', { pingId, clientTimeMs: Date.now() });
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // --------------------------------------------------------------- reconnect

  private handleClose(event: CloseEvent): void {
    this.ready = false;
    this.stopHeartbeat();
    this.socket = null;
    this.onClose?.(event.code);

    if (this.manualClose) {
      this.setStatus({ ...this.snapshot, status: 'CLOSED', nextRetryAt: null, closeCode: event.code });
      return;
    }
    if (event.code === WS_CLOSE_CODE.AUTH_INVALID || event.code === WS_CLOSE_CODE.AUTH_FORBIDDEN) {
      const reason =
        event.reason.length > 0
          ? event.reason
          : event.code === WS_CLOSE_CODE.AUTH_INVALID
            ? 'AUTH_INVALID'
            : 'AUTH_FORBIDDEN';
      this.setStatus({ ...this.snapshot, status: 'FAILED', nextRetryAt: null, closeCode: event.code, reason });
      return;
    }
    this.scheduleReconnect(`close ${event.code}`);
  }

  private handleFailure(reason: string): void {
    this.ready = false;
    this.stopHeartbeat();
    this.socket = null;
    if (this.manualClose) return;
    this.scheduleReconnect(reason);
  }

  private scheduleReconnect(reason: string | null): void {
    this.clearRetryTimer();
    const attempt = this.snapshot.attempt + 1;
    if (attempt > this.limits.maxAttempts) {
      this.setStatus({
        ...this.snapshot,
        status: 'FAILED',
        attempt: this.limits.maxAttempts,
        nextRetryAt: null,
        reason: reason ?? 'соединение потеряно; попытки исчерпаны',
      });
      return;
    }
    const delay = backoffDelayMs(attempt, this.limits);
    const nextRetryAt = Date.now() + delay;
    this.setStatus({ ...this.snapshot, status: 'RECONNECTING', attempt, nextRetryAt, reason, closeCode: null });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.setStatus({ ...this.snapshot, status: 'CONNECTING', nextRetryAt: null });
      this.openSocket();
    }, delay);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private setStatus(snapshot: ConnectionSnapshot): void {
    this.snapshot = Object.freeze(snapshot);
    this.onStatus?.(this.snapshot);
  }

  // ------------------------------------------------------------ impairment

  /** Искусственная деградация — scene replication движения и pong, не handshake. */
  private isImpairedIncoming(type: WsServerMessageType): boolean {
    return (
      this.networkProfile !== null &&
      (type === 'scene:delta' || type === 'scene:input-ack' || type === 'connection:pong')
    );
  }

  private impairmentDelay(): number {
    return this.networkProfile === null ? 0 : oneWayDelayMs(this.networkProfile, this.rng);
  }
}
