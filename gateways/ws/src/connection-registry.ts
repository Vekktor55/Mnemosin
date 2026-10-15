import type { ConnectionId, PlayerId, SessionId } from '@mnemosin/contracts';
import type { WebSocket } from '@fastify/websocket';

/**
 * Реестр WS-соединений (промпт 1.11, п.2) — in-memory, один процесс.
 *
 * connectionId → запись; playerId → Set<connectionId> (multi-tab, этап 3);
 * ip → Set<connectionId> (лимит wsMaxConnectionsPerIp). PLAYER_PRESENCE при
 * изменении публикует server.ts через broadcaster (registry сам ничего не
 * шлёт — он только данные; приватность — исключительно projections.ts, B-10).
 *
 * Соединение ≠ игрок: закрытие сокета уменьшает счётчик connections; статус
 * DISCONNECTED выставляется, когда у игрока не осталось соединений (D278).
 */

export interface WsConnectionRecord {
  readonly connectionId: ConnectionId;
  readonly playerId: PlayerId;
  readonly sessionId: SessionId;
  readonly isGM: boolean;
  readonly ip: string;
  readonly socket: WebSocket;
  readonly connectedAt: string;
  subscribedAt: string;
  lastPongAt: number;
}

export class ConnectionRegistry {
  private readonly byId = new Map<ConnectionId, WsConnectionRecord>();
  private readonly byPlayer = new Map<PlayerId, Set<ConnectionId>>();
  private readonly byIp = new Map<string, Set<ConnectionId>>();

  add(record: WsConnectionRecord): void {
    this.byId.set(record.connectionId, record);
    let playerSet = this.byPlayer.get(record.playerId);
    if (playerSet === undefined) {
      playerSet = new Set();
      this.byPlayer.set(record.playerId, playerSet);
    }
    playerSet.add(record.connectionId);
    let ipSet = this.byIp.get(record.ip);
    if (ipSet === undefined) {
      ipSet = new Set();
      this.byIp.set(record.ip, ipSet);
    }
    ipSet.add(record.connectionId);
  }

  remove(connectionId: ConnectionId): WsConnectionRecord | undefined {
    const record = this.byId.get(connectionId);
    if (record === undefined) return undefined;
    this.byId.delete(connectionId);
    const playerSet = this.byPlayer.get(record.playerId);
    if (playerSet !== undefined) {
      playerSet.delete(connectionId);
      if (playerSet.size === 0) this.byPlayer.delete(record.playerId);
    }
    const ipSet = this.byIp.get(record.ip);
    if (ipSet !== undefined) {
      ipSet.delete(connectionId);
      if (ipSet.size === 0) this.byIp.delete(record.ip);
    }
    return record;
  }

  get(connectionId: ConnectionId): WsConnectionRecord | undefined {
    return this.byId.get(connectionId);
  }

  listByPlayer(playerId: PlayerId): WsConnectionRecord[] {
    const ids = this.byPlayer.get(playerId);
    if (ids === undefined) return [];
    return [...ids].map((id) => this.byId.get(id)).filter((r): r is WsConnectionRecord => r !== undefined);
  }

  listBySession(sessionId: SessionId): WsConnectionRecord[] {
    return [...this.byId.values()].filter((record) => record.sessionId === sessionId);
  }

  countByIp(ip: string): number {
    return this.byIp.get(ip)?.size ?? 0;
  }

  countByPlayer(playerId: PlayerId): number {
    return this.byPlayer.get(playerId)?.size ?? 0;
  }

  size(): number {
    return this.byId.size;
  }

  listAll(): WsConnectionRecord[] {
    return [...this.byId.values()];
  }

  /** Отметка активности: любой входящий кадр и protocol-pong продлевают жизнь. */
  touch(connectionId: ConnectionId, now: number): void {
    const record = this.byId.get(connectionId);
    if (record !== undefined) record.lastPongAt = now;
  }

  /**
   * presenceSweep (джоб из main.ts): убирает записи с мёртвыми сокетами —
   * защита от утечки, если close-событие не доставлено (крах transport-слоя).
   * Возвращает число удалённых записей.
   */
  sweepClosed(): WsConnectionRecord[] {
    const removed: WsConnectionRecord[] = [];
    for (const [connectionId, record] of this.byId) {
      // readyState: 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED.
      if (record.socket.readyState >= 2) {
        const gone = this.remove(connectionId);
        if (gone !== undefined) removed.push(gone);
      }
    }
    return removed;
  }
}
