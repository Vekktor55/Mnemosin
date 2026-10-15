import {
  AppError,
  ResolutionSummaryViewSchema,
  WS_PRIVACY_POLICY,
  WSServerMessageSchema,
  FORBIDDEN_IN_BROADCAST,
  nowIso,
  type ConnectionId,
  type ItemStatus,
  type PlayerId,
  type PublicGameStateView,
  type ResolutionSummaryView,
  type SessionId,
  type Turn,
  type TurnId,
  type TurnView,
  type WSServerType,
  type WsPrivacyPolicy,
} from '@mnemosin/contracts';
import type { WebSocket } from '@fastify/websocket';

import type { ConnectionRegistry, WsConnectionRecord } from './connection-registry.js';
import type { WsGatewayDeps, WsGatewayLog } from './deps.js';

/**
 * Проекции и доставка (промпт 1.11, п.5) — ЕДИНСТВЕННОЕ место, где доменные
 * данные превращаются в клиентские сообщения (инвариант 14 + блокер B-10).
 *
 * ЖЁСТКИЕ ПРАВИЛА:
 *  1. каждое исходящее сообщение проходит WSServerMessageSchema.parse
 *     (инвариант 16 — невалидный payload не покидает сервер);
 *  2. аудитория сообщения согласуется с WS_PRIVACY_POLICY (contracts):
 *     BROADCAST → всем в сессии; GM_ONLY → соединениям с isGM; TARGETED →
 *     конкретному playerId (все его соединения); SENDER_ONLY → инициатору.
 *     Политика задаёт МАКСИМАЛЬНУЮ аудиторию: сузить её (отправить
 *     BROADCAST-тип одному соединению, например в reconnect-последовательности)
 *     разрешено, расширить — нет (runtime-проверка, нарушение → INTERNAL);
 *  3. payload, уходящий ЦЕЛОЙ сессии (target 'session'), проверяется глубоким
 *     сканом на FORBIDDEN_IN_BROADCAST-ключи (defense in depth — даже если
 *     проекция ошиблась, приватное не уйдёт в broadcast);
 *  4. broadcast-payload не содержит per-player полей: приватная часть хода —
 *     отдельным TURN_PRIVATE_RESOLUTION адресату (TARGETED), полный
 *     resolution — только TURN_RESOLUTION_GM (GM_ONLY), публичный
 *     TURN_COMMITTED — {turnId, version, publicSegments}.
 */

export type DeliveryTarget =
  | { readonly kind: 'session'; readonly sessionId: SessionId }
  | { readonly kind: 'gm'; readonly sessionId: SessionId }
  | { readonly kind: 'player'; readonly sessionId: SessionId; readonly playerId: PlayerId }
  | { readonly kind: 'connection'; readonly connectionId: string };

/**
 * Серверный конверт (внутреннее представление ack'а; ts проставляет
 * WsBroadcaster.send в момент фактической отправки).
 */
export interface ServerEnvelope {
  readonly type: WSServerType;
  readonly payload: unknown;
  readonly requestId?: string | undefined;
  readonly sessionId?: SessionId | undefined;
}

const ALLOWED_TARGETS: Readonly<Record<WsPrivacyPolicy, readonly DeliveryTarget['kind'][]>> = Object.freeze({
  BROADCAST: ['session', 'gm', 'player', 'connection'],
  GM_ONLY: ['gm', 'connection'],
  TARGETED: ['player', 'connection'],
  SENDER_ONLY: ['connection'],
});

function assertTargetAllowed(type: WSServerType, target: DeliveryTarget, connections: WsConnectionRecord[]): void {
  const policy = WS_PRIVACY_POLICY[type];
  if (!ALLOWED_TARGETS[policy].includes(target.kind)) {
    throw new AppError('INTERNAL', `сообщение ${type} (${policy}) нельзя слать аудитории ${target.kind}`, {
      reason: 'privacy_policy_violation',
      type,
      policy,
    });
  }
  // GM_ONLY через 'connection' — только если соединение действительно GM.
  if (policy === 'GM_ONLY' && target.kind === 'connection' && connections.some((c) => !c.isGM)) {
    throw new AppError('INTERNAL', `сообщение ${type} (GM_ONLY) адресовано не-GM соединению`, {
      reason: 'privacy_policy_violation',
      type,
    });
  }
}

/** Глубокий скан: запрещённые в broadcast ключи (FORBIDDEN_IN_BROADCAST, A1.7). */
export function findForbiddenKey(value: unknown, depth = 0): string | null {
  if (depth > 12 || value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForbiddenKey(item, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if ((FORBIDDEN_IN_BROADCAST as readonly string[]).includes(key)) return key;
    const found = findForbiddenKey(nested, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Доставка server-сообщений с применением WS_PRIVACY_POLICY.
 * Один экземпляр на gateway; используется router'ом (синхронные ack'и) и
 * broadcast'ом (событийная доставка).
 */
export class WsBroadcaster {
  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly logger?: WsGatewayLog,
  ) {}

  /**
   * Формирует конверт, валидирует схемой и отправляет выбранным соединениям.
   * Возвращает число сокетов, получивших сообщение (0 — некому).
   */
  send(
    type: WSServerType,
    payload: unknown,
    target: DeliveryTarget,
    extra: { requestId?: string; sessionId?: SessionId } = {},
  ): number {
    const envelope: Record<string, unknown> = { type, payload, ts: nowIso() };
    if (extra.requestId !== undefined) envelope['requestId'] = extra.requestId;
    if (extra.sessionId !== undefined) envelope['sessionId'] = extra.sessionId;

    const connections = this.select(type, target);
    // Инвариант 16: исходящее сообщение валидно ИЛИ не отправлено никому.
    const parsed = WSServerMessageSchema.parse(envelope) as ServerEnvelope;
    // П.3: broadcast-payload (вся сессия) не содержит запрещённых полей.
    if (target.kind === 'session') this.assertBroadcastSafe(type, parsed.payload);
    const serialized = JSON.stringify(parsed);
    let sent = 0;
    for (const record of connections) {
      if (record.socket.readyState === 1 /* OPEN */) {
        record.socket.send(serialized);
        sent += 1;
      }
    }
    this.logger?.debug({ type, target: target.kind, sent, event: 'ws_send' }, 'ws_send');
    return sent;
  }

  /**
   * Прямая отправка в сокет МИНУЯ реестр — для неаутентифицированных соединений
   * (окно AUTH, D267): записи в registry ещё нет, а ERROR/PONG доставить надо.
   * Политика SENDER_ONLY гарантируется вызывающим кодом (только respond роутера).
   */
  sendDirect(
    socket: WebSocket,
    type: WSServerType,
    payload: unknown,
    extra: { requestId?: string; sessionId?: SessionId } = {},
  ): void {
    const envelope: Record<string, unknown> = { type, payload, ts: nowIso() };
    if (extra.requestId !== undefined) envelope['requestId'] = extra.requestId;
    if (extra.sessionId !== undefined) envelope['sessionId'] = extra.sessionId;
    const parsed = WSServerMessageSchema.parse(envelope);
    if (socket.readyState === 1) socket.send(JSON.stringify(parsed));
  }

  private select(type: WSServerType, target: DeliveryTarget): WsConnectionRecord[] {
    let connections: WsConnectionRecord[];
    switch (target.kind) {
      case 'session':
        connections = this.registry.listBySession(target.sessionId);
        break;
      case 'gm':
        connections = this.registry.listBySession(target.sessionId).filter((record) => record.isGM);
        break;
      case 'player':
        connections = this.registry
          .listByPlayer(target.playerId)
          .filter((record) => record.sessionId === target.sessionId);
        break;
      case 'connection': {
        const record = this.registry.get(target.connectionId as ConnectionId);
        connections = record === undefined ? [] : [record];
        break;
      }
    }
    assertTargetAllowed(type, target, connections);
    return connections;
  }

  /**
   * Защита broadcast-payload: вызывается send'ом для target 'session'.
   * Нарушение — баг проекции; сообщение НЕ отправляется (INTERNAL).
   */
  assertBroadcastSafe(type: WSServerType, payload: unknown): void {
    const forbidden = findForbiddenKey(payload);
    if (forbidden !== null) {
      throw new AppError('INTERNAL', `broadcast ${type} содержит запрещённое поле ${forbidden}`, {
        reason: 'forbidden_in_broadcast',
        type,
        field: forbidden,
      });
    }
  }
}

// ---------------------------------------------------------------- проекции

/** Публичная проекция состояния (BROADCAST): только публичные поля (B-10, D124). */
export async function buildPublicGameStateView(
  deps: WsGatewayDeps,
  sessionId: SessionId,
): Promise<PublicGameStateView> {
  return deps.projections.publicGameState(sessionId);
}

/** Приватная проекция игрока (TARGETED): только его knowledge (K11). */
export async function buildPlayerPrivateView(
  deps: WsGatewayDeps,
  sessionId: SessionId,
  playerId: PlayerId,
): Promise<{ playerId: PlayerId; version: number; knowledge: unknown[] }> {
  return deps.projections.playerGameState(sessionId, playerId);
}

/**
 * TURN_UPDATE (BROADCAST) — публичный срез хода БЕЗ myActions (viewer=null):
 * per-player поля в broadcast запрещены (D268). Свои действия клиент знает
 * из ACTION_ACK; после реконнекта myActions приходят TURN_UPDATE'ом,
 * адресованным ОДНОМУ соединению (сужение аудитории допустимо).
 */
export async function buildTurnUpdate(deps: WsGatewayDeps, turnId: TurnId, viewer: PlayerId | null): Promise<TurnView> {
  return deps.turns.getTurnView(turnId, viewer);
}

/** Сводка черновика для GM-панели (TURN_DRAFT_READY, GM_ONLY). */
export function buildResolutionSummary(turn: Turn): ResolutionSummaryView {
  const resolution = turn.resolution;
  if (resolution === null) {
    throw new AppError('NOT_FOUND', `ход ${turn.turnId} не имеет черновика`, { reason: 'no_resolution' });
  }
  const counts: Partial<Record<ItemStatus, number>> = {};
  const bump = (status: ItemStatus): void => {
    counts[status] = (counts[status] ?? 0) + 1;
  };
  const ruleResults = [
    ...resolution.proposedEvents.flatMap((item) => item.ruleResults),
    ...resolution.proposedObjectChanges.flatMap((item) => item.ruleResults),
  ];
  for (const segment of resolution.segments) bump(segment.status);
  for (const message of resolution.privateMessages) bump(message.status);
  for (const event of resolution.proposedEvents) bump(event.status);
  for (const change of resolution.proposedObjectChanges) bump(change.status);
  return ResolutionSummaryViewSchema.parse({
    turnId: resolution.turnId,
    source: resolution.source,
    resolutionHash: resolution.resolutionHash,
    counts,
    requiresGM: resolution.diagnostics.requiresGM,
    violations: resolution.diagnostics.violations.length,
    ruleResults,
    providerId: resolution.diagnostics.providerId,
    durationMs: resolution.diagnostics.durationMs,
    costUsd: resolution.diagnostics.costUsd,
  });
}

/**
 * Публичная часть закоммиченного хода (TURN_COMMITTED, BROADCAST):
 * только сегменты с audience ALL в статусе APPLIED — никаких per-player полей.
 */
export function buildTurnCommittedPublic(
  turn: Turn,
  version: number,
): {
  turnId: TurnId;
  version: number;
  publicSegments: Array<{ segmentId: string; text: string }>;
} {
  const resolution = turn.resolution;
  const publicSegments = (resolution?.segments ?? [])
    .filter((segment) => segment.audience.kind === 'ALL' && segment.status === 'APPLIED')
    .map((segment) => ({ segmentId: segment.segmentId, text: segment.text }));
  return { turnId: turn.turnId, version, publicSegments };
}

/**
 * Приватная часть хода для адресата (TURN_PRIVATE_RESOLUTION, TARGETED):
 * его privateMessages + сегменты с audience PLAYER/PLAYERS в его адрес.
 * Дублирование с PRIVATE-доставкой чата (D238) ОСОЗНАННОЕ (D269): чат —
 * персистентная лента, TURN_PRIVATE_RESOLUTION — сигнал «результат хода»;
 * клиент (1.12) дедуплицирует по turnId.
 */
export function buildPrivateResolutionText(turn: Turn, playerId: PlayerId): string | null {
  const resolution = turn.resolution;
  if (resolution === null) return null;
  const parts: string[] = [];
  for (const segment of resolution.segments) {
    if (segment.status !== 'APPLIED') continue;
    const audience = segment.audience;
    const addressed =
      (audience.kind === 'PLAYER' && audience.playerId === playerId) ||
      (audience.kind === 'PLAYERS' && audience.playerIds.includes(playerId));
    if (addressed) parts.push(segment.text);
  }
  for (const message of resolution.privateMessages) {
    if (message.status === 'APPLIED' && message.playerId === playerId) parts.push(message.text);
  }
  if (parts.length === 0) return null;
  return parts.join('\n\n').slice(0, 1500);
}

/** Игроки сессии (для адресных раздач STATE_PROJECTION_PRIVATE). */
export function playersOf(publicView: PublicGameStateView): PlayerId[] {
  return publicView.players.map((player) => player.playerId);
}

/** Отладочный хелпер: сокет жив? */
export function isOpen(socket: WebSocket): boolean {
  return socket.readyState === 1;
}
