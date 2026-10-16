/**
 * Обработчики WS → сторы (промпт 1.12, п.3; v3 §VII.8).
 *
 * ЕДИНСТВЕННОЕ место, где сторы обновляются из WS-сообщений. Локальные
 * optimistic-операции живут в app-context.ts и reconcile'ятся здесь же
 * (ACTION_ACK/CHAT_ACK/ERROR). GM_COMMIT_TURN — без оптимизма: UI показывает
 * BUSY до GM_ACTION_ACK, состояние хода меняется только серверными сообщениями.
 */
import type { TurnResolution } from '@mnemosin/contracts';

import type { WSClient } from '../net/ws-client.js';
import { refreshPublicState } from '../net/state-sync.js';
import { IDLE_SNAPSHOT } from '../net/ws-client.js';
import { describeError } from '../lib/errors.js';
import { get } from 'svelte/store';

import { connectionStore } from './connection.js';
import { EMPTY_SESSION, sessionStore } from './session.js';
import { EMPTY_CHAT, chatStore, addServerMessage, ackPendingChat, mergeHistory, updatePendingChat } from './chat.js';
import {
  EMPTY_TURN,
  turnStore,
  setTurnView,
  setTurnFailed,
  setCommitted,
  addPrivateResolution,
  ackSubmittedAction,
  failSubmittedAction,
  updateGmOperation,
  setDraft,
  setDraftFromConflict,
  setAiContext,
  type GmOperation,
} from './turn.js';
import { upsertMediaJob, upsertAudioJob } from './visual.js';
import { pushFeed, pushFeedError, setBusyGmAction } from './ui.js';

/** Подписать все сторы на сообщения клиента. Вызывается один раз на WSClient. */
export function attachStores(ws: WSClient): void {
  // Соединение: статусы приходят из WSClient (v3 §VII.3) — connectionStore
  // обновляется только этим каналом.
  ws.on('HELLO', (message) => {
    sessionStore.update((state) =>
      Object.freeze({
        ...state,
        serverVersion: message.payload.serverVersion,
        contractsVersion: message.payload.contractsVersion,
        capabilities: Object.freeze(message.payload.capabilities),
      }),
    );
  });

  ws.on('AUTH_OK', (message) => {
    sessionStore.update((state) =>
      Object.freeze({
        ...state,
        sessionId: message.payload.sessionId,
        myPlayerId: message.payload.playerId,
        isGM: message.payload.isGM,
      }),
    );
  });

  ws.on('SUBSCRIBED', () => {
    /* подтверждение подписки — состояние уже установлено AUTH_OK */
  });

  ws.on('SESSION_STATUS', (message) => {
    const to = message.payload.to;
    sessionStore.update((state) =>
      Object.freeze({
        ...state,
        status: to === 'LOBBY' || to === 'ACTIVE' || to === 'PAUSED' || to === 'ENDED' ? to : state.status,
      }),
    );
    pushFeed({ kind: 'session', text: `Статус сессии: ${message.payload.from} → ${message.payload.to}` });
  });

  ws.on('PLAYER_PRESENCE', (message) => {
    const { playerId, status, connections } = message.payload;
    sessionStore.update((state) =>
      Object.freeze({
        ...state,
        presence: Object.freeze({ ...state.presence, [playerId]: Object.freeze({ status, connections }) }),
      }),
    );
    // D278: presence не содержит имени; неизвестный игрок → догоняем публичную
    // проекцию по HTTP (net/state-sync.ts), чтобы он появился в списках UI.
    const state = get(sessionStore);
    if (
      status === 'ACTIVE' &&
      state.publicState !== null &&
      !state.publicState.players.some((player) => player.playerId === playerId)
    ) {
      void refreshPublicState(state.publicState.sessionId);
    }
  });

  ws.on('STATE_PROJECTION', (message) => {
    sessionStore.update((state) => Object.freeze({ ...state, publicState: message.payload }));
  });

  ws.on('STATE_PROJECTION_PRIVATE', (message) => {
    sessionStore.update((state) => Object.freeze({ ...state, privateState: message.payload }));
  });

  ws.on('TURN_UPDATE', (message) => {
    const view = message.payload;
    const prevFailed = get(turnStore).failed;
    setTurnView(view);
    // Проваленный ход мог не сопровождаться живым TURN_FAILED (крах сервера,
    // reconcileOnBoot): восстанавливаем запись ленты из проекции хода.
    if (view.failed !== null && (prevFailed === null || prevFailed.turnId !== view.turnId)) {
      pushFeed({
        kind: 'turn-failed',
        text: `Ход провалился: ${view.failed.message}`,
        error: describeError(view.failed.code, view.failed.message),
      });
    }
  });

  ws.on('TURN_DRAFT_READY', (message) => {
    setDraft(message.payload.summary, null);
    pushFeed({
      kind: 'info',
      text: `Черновик хода готов (провайдер: ${message.payload.summary.providerId}, требуется ревью GM)`,
    });
  });

  ws.on('TURN_RESOLUTION_GM', (message) => {
    setDraft(null, message.payload);
  });

  ws.on('TURN_COMMITTED', (message) => {
    setCommitted({
      turnId: message.payload.turnId,
      version: message.payload.version,
      segments: message.payload.publicSegments.map((segment) => ({ segmentId: segment.segmentId, text: segment.text })),
    });
    pushFeed({
      kind: 'narrative',
      segments: message.payload.publicSegments.map((segment) => ({ segmentId: segment.segmentId, text: segment.text })),
      text: null,
    });
  });

  ws.on('TURN_PRIVATE_RESOLUTION', (message) => {
    // D269: дедупликация по turnId (чат-доставка PRIVATE дублирует сигнал).
    if (addPrivateResolution(message.payload.turnId, message.payload.text)) {
      pushFeed({ kind: 'private', text: message.payload.text });
    }
  });

  ws.on('TURN_FAILED', (message) => {
    setTurnFailed(message.payload.turnId, message.payload.errorCode, message.payload.message);
    pushFeed({
      kind: 'turn-failed',
      text: `Ход провалился: ${message.payload.message}`,
      error: describeError(message.payload.errorCode, message.payload.message),
    });
  });

  ws.on('CHAT_PUBLIC', (message) => addServerMessage(message.payload));
  ws.on('CHAT_PRIVATE', (message) => addServerMessage(message.payload));
  ws.on('CHAT_SYSTEM', (message) => addServerMessage(message.payload));
  ws.on('CHAT_GM', (message) => addServerMessage(message.payload));

  ws.on('CHAT_ACK', (message) => {
    const requestId = message.payload.requestId;
    if (requestId === null) return;
    const session = get(sessionStore);
    ackPendingChat(requestId, message.payload.messageId, {
      playerId: session.myPlayerId,
      displayName: displayNameOf(session.myPlayerId, session.publicState?.players ?? []),
    });
  });

  ws.on('HISTORY_RESULT', (message) => {
    mergeHistory(message.payload.messages);
  });

  ws.on('ACTION_ACK', (message) => {
    ackSubmittedAction(message.payload.requestId, message.payload.actionId, message.payload.sequenceId);
  });

  ws.on('GM_ACTION_ACK', (message) => {
    const requestId = message.requestId;
    if (requestId === undefined) return;
    updateGmOperation(requestId, { status: message.payload.ok ? 'OK' : 'ERROR', error: null });
    setBusyGmAction(null);
    pushFeed({
      kind: 'gm-ack',
      text: `GM: ${message.payload.action} — ${message.payload.ok ? 'OK' : 'отклонено сервером'}`,
      details: message.payload.meta,
    });
  });

  ws.on('GM_NOTE_ACK', (message) => {
    const requestId = message.requestId;
    if (requestId === undefined) return;
    updateGmOperation(requestId, { status: 'OK', error: null });
    setBusyGmAction(null);
    pushFeed({ kind: 'gm-ack', text: `Заметка сохранена (${String(message.payload.noteId).slice(0, 8)}…)` });
  });

  ws.on('GM_STATE', (message) => {
    sessionStore.update((state) => Object.freeze({ ...state, gmState: message.payload }));
  });

  ws.on('GM_AI_CONTEXT', (message) => {
    setAiContext(message.payload);
  });

  ws.on('CAPABILITY_CHANGED', (message) => {
    sessionStore.update((state) =>
      Object.freeze({
        ...state,
        capabilities: Object.freeze(
          state.capabilities.some((item) => item.capability === message.payload.capability)
            ? state.capabilities.map((item) =>
                item.capability === message.payload.capability ? message.payload : item,
              )
            : [...state.capabilities, message.payload],
        ),
      }),
    );
    pushFeed({
      kind: 'capability',
      text: `Capability «${message.payload.capability}»: ${message.payload.available ? 'доступна' : `недоступна (${message.payload.reason ?? 'причина не указана'})`}`,
    });
  });

  ws.on('BUDGET_WARNING', (message) => {
    sessionStore.update((state) =>
      Object.freeze({
        ...state,
        budget: Object.freeze({
          spentUsd: message.payload.spentUsd,
          budgetUsd: message.payload.budgetUsd,
          exceeded: false,
          disabledCapability: null,
        }),
      }),
    );
    pushFeed({
      kind: 'budget',
      text: `Бюджет: $${message.payload.spentUsd.toFixed(2)} из $${message.payload.budgetUsd.toFixed(2)}`,
    });
  });

  ws.on('BUDGET_EXCEEDED', (message) => {
    sessionStore.update((state) =>
      Object.freeze({
        ...state,
        budget: Object.freeze({
          spentUsd: message.payload.spentUsd,
          budgetUsd: message.payload.budgetUsd,
          exceeded: true,
          disabledCapability: message.payload.disabledCapability,
        }),
      }),
    );
    pushFeed({
      kind: 'budget',
      text: `Бюджет превышен ($${message.payload.spentUsd.toFixed(2)} > $${message.payload.budgetUsd.toFixed(2)})`,
    });
  });

  ws.on('MEDIA_STARTED', () => {
    /* этап 2: jobs обновляются MEDIA_READY/FAILED */
  });
  ws.on('MEDIA_READY', (message) => upsertMediaJob(message.payload));
  ws.on('MEDIA_FAILED', (message) => upsertMediaJob(message.payload));
  ws.on('AUDIO_STARTED', () => {
    /* этап 2 */
  });
  ws.on('AUDIO_READY', (message) => upsertAudioJob(message.payload));
  ws.on('AUDIO_FAILED', (message) => upsertAudioJob(message.payload));

  ws.on('PONG', () => {
    /* liveness учитывается внутри WSClient */
  });

  // ERROR — маршрутизация по владельцу requestId (SENDER_ONLY, SPEC §6.3).
  ws.on('ERROR', (message) => {
    const { code, message: text, meta, requestId } = message.payload;
    const described = describeError(code, text, meta);

    const turns = get(turnStore);
    if (requestId !== null && turns.submittedActions[requestId] !== undefined) {
      // Откат оптимистичного действия с показом кода и clientAction (SPEC §4).
      failSubmittedAction(requestId, described);
      pushFeedError(described, { action: turns.submittedActions[requestId]?.rawText ?? null });
      return;
    }
    const chats = get(chatStore);
    if (requestId !== null && chats.pending.some((item) => item.requestId === requestId)) {
      updatePendingChat(requestId, { status: 'FAILED', error: described });
      return;
    }
    const gmOp: GmOperation | undefined = requestId !== null ? turns.gmOps[requestId] : undefined;
    if (gmOp !== undefined) {
      updateGmOperation(gmOp.requestId, { status: 'ERROR', error: described });
      setBusyGmAction(null);
      // A1.8/SPEC §5: 409 при Edit&Approve — актуальный черновик из meta.
      if (
        code === 'VERSION_CONFLICT' &&
        meta !== undefined &&
        typeof meta['resolution'] === 'object' &&
        meta['resolution'] !== null
      ) {
        setDraftFromConflict(meta['resolution'] as TurnResolution);
        pushFeed({
          kind: 'error',
          error: described,
          text: 'Черновик изменён — панель Review обновлена, повторите правку',
        });
        return;
      }
      pushFeedError(described, { gmAction: gmOp.action });
      return;
    }
    pushFeedError(described);
  });
}

function displayNameOf(playerId: string | null, players: readonly { playerId: string; displayName: string }[]): string {
  if (playerId === null) return '';
  return players.find((player) => player.playerId === playerId)?.displayName ?? '';
}

/** Сброс всех сторов (logout / смена identity). */
export function resetStoresForLogout(): void {
  connectionStore.set(IDLE_SNAPSHOT);
  sessionStore.set(EMPTY_SESSION);
  chatStore.set(EMPTY_CHAT);
  turnStore.set(EMPTY_TURN);
}
