import {
  AppError,
  type CapabilityAvailability,
  type DomainEvent,
  type PlayerId,
  type SessionId,
  type TurnId,
} from '@mnemosin/contracts';
import type { Unsubscribe } from '@mnemosin/core/domain/ports';

import type { ConnectionRegistry } from './connection-registry.js';
import type { WsGatewayDeps, WsGatewayLog } from './deps.js';
import {
  buildPrivateResolutionText,
  buildPublicGameStateView,
  buildResolutionSummary,
  buildTurnCommittedPublic,
  buildTurnUpdate,
  playersOf,
  type WsBroadcaster,
} from './projections.js';

/**
 * Событийная доставка (промпт 1.11, п.6): подписки на доменную шину через
 * wiring (apps/server передаёт bus) и перевод событий в WS-сообщения СТРОГО
 * по WS_PRIVACY_POLICY:
 *
 *  STATE_COMMITTED      → STATE_PROJECTION (BROADCAST) + STATE_PROJECTION_PRIVATE (TARGETED, каждому игроку);
 *  TURN_OPENED/LOCKED/UNLOCKED/PROCESSING_STARTED → TURN_UPDATE (BROADCAST, viewer=null — D268);
 *  TURN_DRAFT_READY     → TURN_DRAFT_READY{summary} + TURN_RESOLUTION_GM (GM_ONLY);
 *  TURN_COMMITTED       → TURN_COMMITTED{turnId,version,publicSegments} (BROADCAST)
 *                          + TURN_PRIVATE_RESOLUTION (TARGETED) + TURN_RESOLUTION_GM (GM_ONLY);
 *  TURN_FAILED          → TURN_FAILED (BROADCAST);
 *  CHAT_MESSAGE_*       → CHAT_PUBLIC/CHAT_SYSTEM (BROADCAST), CHAT_PRIVATE (TARGETED), CHAT_GM (GM_ONLY);
 *  SESSION_STATUS_CHANGED → SESSION_STATUS (BROADCAST);
 *  PLAYER_JOINED/LEFT   → PLAYER_PRESENCE (BROADCAST);
 *  CAPABILITY_CHANGED   → CAPABILITY_CHANGED (BROADCAST).
 *
 * Обработчики идемпотентны (at-least-once, D113): повторная доставка события
 * шлёт тот же projection-срез — клиент reconcile'ит состояние по version.
 * GM_ACTION_PERFORMED в WS НЕ транслируется: ack уходит синхронным ответом
 * инициатору (D270); multi-tab-синхронизация GM — этап 3.
 */

export interface BroadcastAttachResult {
  detach(): void;
}

export function attachWsBroadcast(input: {
  deps: WsGatewayDeps;
  registry: ConnectionRegistry;
  broadcaster: WsBroadcaster;
  logger?: WsGatewayLog;
}): BroadcastAttachResult {
  const { deps, registry, broadcaster, logger } = input;

  const subscribedSessions = (sessionId: SessionId): boolean => registry.listBySession(sessionId).length > 0;

  const guard = (eventName: string, run: () => Promise<void>): Promise<void> =>
    run().catch((cause: unknown) => {
      // Ошибка доставки не должна ломать шину: WS-доставка best-effort, клиент
      // догонит состояние через STATE_PROJECTION/реконнект-контракт (A1.9).
      // INTERNAL от WsBroadcaster — штатный блок приватности (сообщение с
      // запрещёнными полями НЕ ушло, B-10); остальное — сбой проекции.
      const privacyBlock = cause instanceof AppError && cause.code === 'INTERNAL';
      logger?.error(
        { err: cause, eventName, privacyBlock, event: privacyBlock ? 'ws_privacy_block' : 'ws_broadcast_failed' },
        privacyBlock ? 'ws_privacy_block' : 'ws_broadcast_failed',
      );
    });

  const unsubscribes: Unsubscribe[] = [];
  const on = (
    eventName: Parameters<typeof deps.bus.subscribe>[0],
    handler: (event: DomainEvent) => Promise<void>,
  ): void => {
    unsubscribes.push(
      deps.bus.subscribe(eventName, (event) => {
        if (event.type !== eventName) return Promise.resolve();
        return guard(eventName, () => handler(event));
      }),
    );
  };

  on('STATE_COMMITTED', async (event) => {
    if (event.type !== 'STATE_COMMITTED') return;
    const { sessionId } = event.payload;
    if (!subscribedSessions(sessionId)) return;
    const publicView = await buildPublicGameStateView(deps, sessionId);
    broadcaster.send('STATE_PROJECTION', publicView, { kind: 'session', sessionId });
    for (const playerId of playersOf(publicView)) {
      const privateView = await deps.projections.playerGameState(sessionId, playerId);
      broadcaster.send('STATE_PROJECTION_PRIVATE', privateView, { kind: 'player', sessionId, playerId });
    }
  });

  const turnUpdateBroadcast = async (sessionId: SessionId, turnId: TurnId): Promise<void> => {
    if (!subscribedSessions(sessionId)) return;
    const view = await buildTurnUpdate(deps, turnId, null);
    broadcaster.send('TURN_UPDATE', view, { kind: 'session', sessionId });
  };

  on('TURN_OPENED', async (event) => {
    if (event.type !== 'TURN_OPENED') return;
    await turnUpdateBroadcast(event.payload.sessionId, event.payload.turnId);
  });
  on('TURN_LOCKED', async (event) => {
    if (event.type !== 'TURN_LOCKED') return;
    await turnUpdateBroadcast(event.payload.sessionId, event.payload.turnId);
  });
  on('TURN_UNLOCKED', async (event) => {
    if (event.type !== 'TURN_UNLOCKED') return;
    await turnUpdateBroadcast(event.payload.sessionId, event.payload.turnId);
  });
  on('TURN_PROCESSING_STARTED', async (event) => {
    if (event.type !== 'TURN_PROCESSING_STARTED') return;
    await turnUpdateBroadcast(event.payload.sessionId, event.payload.turnId);
  });

  on('TURN_DRAFT_READY', async (event) => {
    if (event.type !== 'TURN_DRAFT_READY') return;
    const { sessionId, turnId } = event.payload;
    if (!subscribedSessions(sessionId)) return;
    const turn = await deps.turns.getTurn(turnId);
    broadcaster.send('TURN_DRAFT_READY', { turnId, summary: buildResolutionSummary(turn) }, { kind: 'gm', sessionId });
    if (turn.resolution !== null) {
      broadcaster.send('TURN_RESOLUTION_GM', turn.resolution, { kind: 'gm', sessionId });
    }
  });

  on('TURN_COMMITTED', async (event) => {
    if (event.type !== 'TURN_COMMITTED') return;
    const { sessionId, turnId, version } = event.payload;
    if (!subscribedSessions(sessionId)) return;
    const turn = await deps.turns.getTurn(turnId);
    // Публично: только {turnId, version, publicSegments} (B-10).
    broadcaster.send('TURN_COMMITTED', buildTurnCommittedPublic(turn, version), { kind: 'session', sessionId });
    // Приватно: каждому адресату — его часть (TARGETED).
    const publicView = await buildPublicGameStateView(deps, sessionId);
    for (const playerId of playersOf(publicView)) {
      const text = buildPrivateResolutionText(turn, playerId);
      if (text !== null) {
        broadcaster.send('TURN_PRIVATE_RESOLUTION', { turnId, text }, { kind: 'player', sessionId, playerId });
      }
    }
    // Полный resolution — только GM (GM_ONLY).
    if (turn.resolution !== null) {
      broadcaster.send('TURN_RESOLUTION_GM', turn.resolution, { kind: 'gm', sessionId });
    }
  });

  on('TURN_FAILED', async (event) => {
    if (event.type !== 'TURN_FAILED') return;
    const { sessionId, turnId, errorCode, message } = event.payload;
    if (!subscribedSessions(sessionId)) return;
    broadcaster.send('TURN_FAILED', { turnId, errorCode, message }, { kind: 'session', sessionId });
  });

  const deliverChat = async (messageId: string, sessionId: SessionId): Promise<void> => {
    if (!subscribedSessions(sessionId)) return;
    const view = await deps.chat.getMessage(messageId);
    if (view === null) return; // гонка at-least-once: сообщения нет — не доставляем
    switch (view.visibility) {
      case 'PUBLIC':
        broadcaster.send('CHAT_PUBLIC', view, { kind: 'session', sessionId });
        break;
      case 'SYSTEM':
        broadcaster.send('CHAT_SYSTEM', view, { kind: 'session', sessionId });
        break;
      case 'PRIVATE': {
        if (view.toPlayerId === null) return;
        const toPlayerId: PlayerId = view.toPlayerId;
        broadcaster.send('CHAT_PRIVATE', view, { kind: 'player', sessionId, playerId: toPlayerId });
        break;
      }
      case 'GM':
        broadcaster.send('CHAT_GM', view, { kind: 'gm', sessionId });
        break;
    }
  };

  on('CHAT_MESSAGE_PUBLIC', async (event) => {
    if (event.type !== 'CHAT_MESSAGE_PUBLIC') return;
    await deliverChat(event.payload.messageId, event.payload.sessionId);
  });
  on('CHAT_MESSAGE_PRIVATE', async (event) => {
    if (event.type !== 'CHAT_MESSAGE_PRIVATE') return;
    await deliverChat(event.payload.messageId, event.payload.sessionId);
  });
  on('CHAT_MESSAGE_SYSTEM', async (event) => {
    if (event.type !== 'CHAT_MESSAGE_SYSTEM') return;
    await deliverChat(event.payload.messageId, event.payload.sessionId);
  });
  on('CHAT_MESSAGE_GM', async (event) => {
    if (event.type !== 'CHAT_MESSAGE_GM') return;
    await deliverChat(event.payload.messageId, event.payload.sessionId);
  });

  on('SESSION_STATUS_CHANGED', async (event) => {
    if (event.type !== 'SESSION_STATUS_CHANGED') return;
    const { sessionId, from, to } = event.payload;
    if (!subscribedSessions(sessionId)) return;
    broadcaster.send('SESSION_STATUS', { sessionId, from, to }, { kind: 'session', sessionId });
  });

  on('PLAYER_JOINED', async (event) => {
    if (event.type !== 'PLAYER_JOINED') return;
    const { sessionId, playerId } = event.payload;
    if (!subscribedSessions(sessionId)) return;
    broadcaster.send(
      'PLAYER_PRESENCE',
      { sessionId, playerId, status: 'ACTIVE', connections: registry.countByPlayer(playerId) },
      { kind: 'session', sessionId },
    );
  });

  on('PLAYER_LEFT', async (event) => {
    if (event.type !== 'PLAYER_LEFT') return;
    const { sessionId, playerId } = event.payload;
    if (!subscribedSessions(sessionId)) return;
    broadcaster.send(
      'PLAYER_PRESENCE',
      { sessionId, playerId, status: 'LEFT', connections: 0 },
      { kind: 'session', sessionId },
    );
  });

  on('CAPABILITY_CHANGED', async (event) => {
    if (event.type !== 'CAPABILITY_CHANGED') return;
    // WS-схема — CapabilityAvailabilitySchema (с required/checkedAt): берём
    // полный срез регистра, а не частичный payload события.
    const snapshot = deps
      .getCapabilities()
      .find((item: CapabilityAvailability) => item.capability === event.payload.capability);
    if (snapshot === undefined) return;
    for (const sessionId of sessionIdsOf(registry)) {
      broadcaster.send('CAPABILITY_CHANGED', snapshot, { kind: 'session', sessionId });
    }
  });

  return {
    detach(): void {
      for (const unsubscribe of unsubscribes) unsubscribe();
      unsubscribes.length = 0;
    },
  };
}

function sessionIdsOf(registry: ConnectionRegistry): SessionId[] {
  const seen = new Set<SessionId>();
  return registry
    .listAll()
    .map((record) => record.sessionId)
    .filter((sessionId) => {
      if (seen.has(sessionId)) return false;
      seen.add(sessionId);
      return true;
    });
}
