/**
 * WSClient (промпт 1.12, п.2; v3 §VII.7; SPEC §6.1, §6.4; D123).
 *
 * - connect: handshake-авторизация subprotocol'ом `mnemosin.v1.<jwt>` (D123 —
 *   основной способ; сервер эхо-ит его через handleProtocols). Очередь исходящих
 *   до AUTH_OK (HELLO → AUTH_OK — гарантированный порядок сервера, промпт 1.11).
 * - reconnect: экспоненциальный backoff (net/backoff.ts, зеркало limits.yaml:
 *   base 500, factor 2, cap 15000, jitter ±20%, maxAttempts 8) → после
 *   исчерпания FAILED с причиной; «Подключиться снова» = reconnectNow() (F-6.10).
 *   Close 4401/4403 (AUTH_INVALID/AUTH_FORBIDDEN/EXPIRED) — НЕ ретраятся:
 *   требуется повторный вход (clientAction REAUTH, ERROR_TABLE).
 * - offline-queue: сообщения с idempotencyKey/requestId персистятся в
 *   localStorage `mnemosin:pending:<playerId>` (D126), удаляются по ack,
 *   переотправляются после реконнекта; сервер дедуплицирует по requestId и
 *   идемпотентности (A1.9, D272).
 * - heartbeat: свой app-level PING каждые 20 с; нет входящих кадров
 *   idleTimeoutMs (45 с) → принудительный реконнект. На серверные
 *   protocol-level PING браузер отвечает PONG автоматически (RFC 6455).
 * - on(type, handler): типизация по WSServerMessage; входящие кадры
 *   валидируются WSServerMessageSchema (инвариант 16 — zod на границе).
 */
import type { z } from 'zod';
import {
  WS_CLOSE_CODE,
  WSServerMessageSchema,
  type WSClientMessage,
  type WSClientType,
  type WSServerMessage,
  type WSServerType,
  type WSClientPayloadSchemas,
} from '@mnemosin/contracts';

import {
  backoffDelayMs,
  DEFAULT_HEARTBEAT_LIMITS,
  DEFAULT_RECONNECT_LIMITS,
  type HeartbeatLimits,
  type ReconnectLimits,
} from './backoff.js';
import { isRetryableErrorCode, OfflineQueue, shouldPersist, type StorageLike } from './offline-queue.js';

/** Payload клиентского сообщения по типу (схема — источник истины). */
export type ClientPayloadOf<T extends WSClientType> = z.infer<(typeof WSClientPayloadSchemas)[T]>;

/** Серверное сообщение конкретного типа (discriminated union из контрактов). */
export type ServerMessageOf<T extends WSServerType> = Extract<WSServerMessage, { type: T }>;

/** Состояния соединения (v3 §VII.3) + попытка и время следующего ретрая. */
export type ConnectionStatus = 'IDLE' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'FAILED' | 'CLOSED';

export interface ConnectionSnapshot {
  readonly status: ConnectionStatus;
  /** 1-based номер предстоящей/выполняемой попытки реконнекта (0 — первое подключение). */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly nextRetryAt: number | null;
  /** Причина FAILED (код закрытия или текст) — для ConnectionBar. */
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
  /** Известный playerId (из сохранённой identity) — чтобы offline-очередь работала до AUTH_OK. */
  readonly playerId?: string | null;
  /** Изменения состояния соединения (connectionStore обновляется ТОЛЬКО отсюда, v3 §VII.8). */
  readonly onStatus?: (snapshot: ConnectionSnapshot) => void;
  /** Вызывается после AUTH_OK (и после каждого реконнекта) — app-level SUBSCRIBE/HISTORY. */
  readonly onReady?: (auth: { playerId: string; sessionId: string; isGM: boolean }) => void;
  readonly reconnect?: Partial<ReconnectLimits>;
  readonly heartbeat?: Partial<HeartbeatLimits>;
  /** Инжекция storage (тесты/приватный режим); по умолчанию localStorage. */
  readonly storage?: StorageLike | null;
}

type ServerHandler = (message: WSServerMessage) => void;

interface CloseReasonPayload {
  code?: string;
  message?: string;
}

/** Субпротокол handshake (D123): `mnemosin.v1.<jwt>`. */
export function wsSubprotocol(token: string): string {
  return `mnemosin.v1.${token}`;
}

export class WSClient {
  private readonly url: string;
  private readonly token: string;
  private readonly limits: ReconnectLimits;
  private readonly heartbeatLimits: HeartbeatLimits;
  private readonly onStatus: ((snapshot: ConnectionSnapshot) => void) | null;
  private readonly onReady: WSClientOptions['onReady'] | null;
  private readonly queue: OfflineQueue;

  private readonly handlers = new Map<WSServerType, Set<ServerHandler>>();
  private socket: WebSocket | null = null;
  private snapshot: ConnectionSnapshot = IDLE_SNAPSHOT;

  private playerId: string | null;
  private sessionId: string | null = null;
  private isGM = false;

  /** Исходящие до AUTH_OK (в т.ч. созданные офлайн, когда playerId ещё неизвестен). */
  private preAuthQueue: WSClientMessage[] = [];
  private authed = false;
  private manualClose = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastAliveAt = 0;

  constructor(options: WSClientOptions) {
    this.url = options.url;
    this.token = options.token;
    this.playerId = options.playerId ?? null;
    this.onStatus = options.onStatus ?? null;
    this.onReady = options.onReady ?? null;
    this.limits = { ...DEFAULT_RECONNECT_LIMITS, ...options.reconnect };
    this.heartbeatLimits = { ...DEFAULT_HEARTBEAT_LIMITS, ...options.heartbeat };
    this.queue = new OfflineQueue(options.storage === undefined ? undefined : options.storage);
    this.snapshot = { ...IDLE_SNAPSHOT, maxAttempts: this.limits.maxAttempts };
  }

  // ------------------------------------------------------------------ public

  connect(): void {
    this.manualClose = false;
    this.setStatus({ ...this.snapshot, status: 'CONNECTING', reason: null, closeCode: null });
    this.openSocket();
  }

  /** «Подключиться снова» (F-6.10): сброс счётчика попыток и немедленный connect. */
  reconnectNow(): void {
    this.clearRetryTimer();
    this.teardownSocket();
    this.setStatus({ ...IDLE_SNAPSHOT, maxAttempts: this.limits.maxAttempts });
    this.connect();
  }

  /** Ручное закрытие (logout): без реконнекта. */
  close(): void {
    this.manualClose = true;
    this.clearRetryTimer();
    this.stopHeartbeat();
    this.authed = false;
    this.teardownSocket();
    this.setStatus({ ...this.snapshot, status: 'CLOSED', nextRetryAt: null });
  }

  /** Типизированная подписка; возвращает функцию отписки. */
  on<T extends WSServerType>(type: T, handler: (message: ServerMessageOf<T>) => void): () => void {
    const set = this.handlers.get(type) ?? new Set<ServerHandler>();
    const wrapped: ServerHandler = (message) => handler(message as ServerMessageOf<T>);
    set.add(wrapped);
    this.handlers.set(type, set);
    return () => {
      set.delete(wrapped);
    };
  }

  /**
   * Отправка сообщения. До AUTH_OK складывается в очередь (промпт 1.12, п.2);
   * сообщения с idempotencyKey/requestId персистятся в offline-очередь.
   *
   * ВАЖНО (requestId): zod-схемы payload'ов GM-команд НЕ объявляют requestId —
   * серверный парсинг вырезал бы его из payload, и echo-корреляция ack/ERROR
   * (F-6.7) потерялась бы. Поэтому requestId дублируется в envelope: роутер
   * читает `payload.requestId ?? message.requestId` (router.ts), а envelope-
   * поле сохраняется схемой конверта (envelopeExtra).
   */
  send<T extends WSClientType>(type: T, payload: ClientPayloadOf<T>): void {
    const record = payload as unknown as Record<string, unknown>;
    const envelopeRequestId = typeof record['requestId'] === 'string' ? record['requestId'] : undefined;
    const envelope = {
      type,
      payload,
      ts: new Date().toISOString(),
      ...(envelopeRequestId === undefined ? {} : { requestId: envelopeRequestId }),
    } as unknown as WSClientMessage;

    if (shouldPersist(type, record) && this.playerId !== null) {
      this.queue.push(this.playerId, {
        type,
        payload: record,
        ...(envelopeRequestId === undefined ? {} : { requestId: envelopeRequestId }),
        queuedAt: envelope.ts,
      });
    }

    if (this.socket !== null && this.socket.readyState === WebSocket.OPEN && this.authed) {
      this.rawSend(envelope);
      return;
    }
    this.preAuthQueue.push(envelope);
  }

  /** Повторить сохранённое сообщение тем же envelope (retry с тем же idempotencyKey). */
  resend(envelope: { type: string; payload: Record<string, unknown> }): void {
    this.send(envelope.type as WSClientType, envelope.payload as never);
  }

  getSnapshot(): ConnectionSnapshot {
    return this.snapshot;
  }

  getPlayerId(): string | null {
    return this.playerId;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getIsGM(): boolean {
    return this.isGM;
  }

  /** Снять сообщение с offline-очереди вручную (например, пользователь отменил отправку). */
  dropPending(requestId: string): void {
    if (this.playerId !== null) this.queue.removeByRequestId(this.playerId, requestId);
  }

  listPending(): { type: string; payload: Record<string, unknown>; requestId?: string }[] {
    if (this.playerId === null) return [];
    return this.queue.list(this.playerId);
  }

  // ----------------------------------------------------------------- socket

  private openSocket(): void {
    this.teardownSocket();
    let socket: WebSocket;
    try {
      // D123: токен в subprotocol (не в URL — не попадает в логи).
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
      this.handleIncoming(typeof event.data === 'string' ? event.data : '');
    };
    socket.onerror = () => {
      // Браузер всегда следует onerror → onclose: обработка там.
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

  private rawSend(envelope: WSClientMessage): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(envelope));
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
    const parsed = WSServerMessageSchema.safeParse(json);
    if (!parsed.success) {
      console.warn('ws-client: кадр не прошёл WSServerMessageSchema — игнорирован');
      return;
    }
    const message = parsed.data;
    this.handleProtocol(message);
    const set = this.handlers.get(message.type);
    if (set !== undefined) {
      for (const handler of [...set]) handler(message);
    }
  }

  /** Протокольная логика самого клиента (AUTH_OK/ack/ERROR) — до пользовательских обработчиков. */
  private handleProtocol(message: WSServerMessage): void {
    switch (message.type) {
      case 'AUTH_OK': {
        this.playerId = message.payload.playerId;
        this.sessionId = message.payload.sessionId;
        this.isGM = message.payload.isGM;
        this.authed = true;
        this.setStatus({
          status: 'CONNECTED',
          attempt: 0,
          maxAttempts: this.limits.maxAttempts,
          nextRetryAt: null,
          reason: null,
          closeCode: null,
        });
        this.startHeartbeat();
        // 1) накопленные до AUTH_OK, 2) персистентная offline-очередь (A1.9).
        this.flushPreAuthQueue();
        this.replayOfflineQueue();
        this.onReady?.({
          playerId: message.payload.playerId,
          sessionId: message.payload.sessionId,
          isGM: message.payload.isGM,
        });
        break;
      }
      case 'ACTION_ACK':
        this.dequeue(message.payload.requestId);
        break;
      case 'CHAT_ACK':
        if (message.payload.requestId !== null) this.dequeue(message.payload.requestId);
        break;
      case 'GM_ACTION_ACK':
      case 'GM_NOTE_ACK':
        if (message.requestId !== undefined) this.dequeue(message.requestId);
        break;
      case 'ERROR': {
        const requestId = message.payload.requestId;
        if (requestId !== null && !isRetryableErrorCode(message.payload.code)) {
          this.dequeue(requestId);
        }
        break;
      }
      case 'PONG':
        this.lastAliveAt = Date.now();
        break;
      default:
        break;
    }
  }

  private dequeue(requestId: string): void {
    if (this.playerId !== null) this.queue.removeByRequestId(this.playerId, requestId);
  }

  private flushPreAuthQueue(): void {
    const pending = this.preAuthQueue;
    this.preAuthQueue = [];
    for (const envelope of pending) this.rawSend(envelope);
  }

  private replayOfflineQueue(): void {
    if (this.playerId === null) return;
    for (const item of this.queue.list(this.playerId)) {
      const requestId = typeof item.payload['requestId'] === 'string' ? item.payload['requestId'] : item.requestId;
      this.rawSend({
        type: item.type,
        payload: item.payload,
        ts: new Date().toISOString(),
        ...(requestId === undefined ? {} : { requestId }),
      } as unknown as WSClientMessage);
    }
  }

  // --------------------------------------------------------------- heartbeat

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const socket = this.socket;
      if (!this.authed || socket === null || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastAliveAt > this.heartbeatLimits.idleTimeoutMs) {
        // Соединение «полумёртвое»: входящих нет — закрываем, путь реконнекта стандартный.
        console.warn('ws-client: heartbeat-таймаут — принудительный реконнект');
        try {
          socket.close(4000, 'heartbeat timeout');
        } catch {
          this.handleFailure('heartbeat timeout');
        }
        return;
      }
      this.rawSend({ type: 'PING', payload: {}, ts: new Date().toISOString() } as unknown as WSClientMessage);
    }, this.heartbeatLimits.intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // --------------------------------------------------------------- reconnect

  private handleClose(event: CloseEvent): void {
    this.authed = false;
    this.stopHeartbeat();
    this.socket = null;

    if (this.manualClose) {
      this.setStatus({ ...this.snapshot, status: 'CLOSED', nextRetryAt: null, closeCode: event.code });
      return;
    }
    if (event.code === WS_CLOSE_CODE.AUTH_INVALID || event.code === WS_CLOSE_CODE.AUTH_FORBIDDEN) {
      // 4401/4403: ретрай бессмысленен — нужен повторный вход (clientAction REAUTH).
      const reason = parseCloseReason(event.reason);
      this.setStatus({
        ...this.snapshot,
        status: 'FAILED',
        nextRetryAt: null,
        closeCode: event.code,
        reason: reason ?? (event.code === WS_CLOSE_CODE.AUTH_INVALID ? 'AUTH_INVALID' : 'AUTH_FORBIDDEN'),
      });
      return;
    }
    this.scheduleReconnect(closeReasonText(event));
  }

  private handleFailure(reason: string): void {
    this.authed = false;
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
}

function parseCloseReason(reason: string): string | null {
  if (reason.length === 0) return null;
  try {
    const parsed = JSON.parse(reason) as CloseReasonPayload;
    if (typeof parsed.code === 'string') return parsed.code;
  } catch {
    /* reason — не JSON */
  }
  return reason;
}

function closeReasonText(event: CloseEvent): string | null {
  const parsed = parseCloseReason(event.reason);
  if (parsed !== null) return `close ${event.code}: ${parsed}`;
  return event.code === 1006 ? 'соединение потеряно (1006)' : `close ${event.code}`;
}
