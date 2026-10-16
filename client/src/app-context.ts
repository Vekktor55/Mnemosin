/**
 * Контекст приложения (промпт 1.12, п.3–5).
 *
 * Владеет единственным экземпляром WSClient и высокоуровневыми операциями:
 * локальные optimistic-операции (v3 §VII.8) обновляют сторы и отправляют
 * WS-сообщение; reconcile выполняют обработчики stores/handlers.ts.
 * GM_COMMIT_TURN и прочие GM-команды — БЕЗ оптимизма: только BUSY-индикатор.
 */
import { get } from 'svelte/store';
import type {
  ActionIntent,
  GMNoteVisibility,
  IdempotencyKey,
  PlayerId,
  SessionId,
  TurnId,
  WSClientType,
} from '@mnemosin/contracts';

import { WSClient, type ConnectionSnapshot } from './net/ws-client.js';
import { wsUrl } from './net/url.js';
import { attachStores, resetStoresForLogout } from './stores/handlers.js';
import { connectionStore } from './stores/connection.js';
import { chatStore, addPendingChat, removePendingChat, lastMessageAt } from './stores/chat.js';
import { turnStore, addSubmittedAction, addGmOperation, updateGmOperation, type GmOperation } from './stores/turn.js';
import { pushFeed, setBusyGmAction } from './stores/ui.js';
import { describeError } from './lib/errors.js';
import { newIdempotencyKey, newRequestId } from './lib/ids.js';
import {
  loadIdentity,
  saveIdentity,
  clearIdentity,
  purgeTokensFromLocalStorage,
  type ClientIdentity,
} from './lib/privacy.js';

let client: WSClient | null = null;

/**
 * Динамическая отправка произвольного типа каталога (WSClientType).
 * Payload'ы собираются из данных форм; схема валидируется сервером
 * (инвариант 16), клиент не дублирует zod-парсинг исходящих.
 */
function sendDynamic(ws: WSClient, type: WSClientType | string, payload: Record<string, unknown>): void {
  const send = ws.send.bind(ws) as unknown as (type: string, payload: Record<string, unknown>) => void;
  send(type, payload);
}

export interface StartConnectionOptions {
  readonly identity: ClientIdentity;
  /** Дополнительный hook после AUTH_OK (например, переход в shell). */
  readonly onAuthOk?: (auth: { playerId: string; sessionId: string; isGM: boolean }) => void;
}

/** Создать WSClient, привязать сторы и подключиться (subprotocol-handshake, D123). */
export function startConnection(options: StartConnectionOptions): WSClient {
  teardownConnection();
  purgeTokensFromLocalStorage();

  const ws = new WSClient({
    url: wsUrl(),
    token: options.identity.token,
    playerId: options.identity.playerId,
    onStatus: (snapshot: ConnectionSnapshot) => connectionStore.set(snapshot),
    onReady: (auth) => {
      // Дополняем identity: playerId/sessionId приходят в AUTH_OK (F-10.6).
      const current = loadIdentity();
      if (current !== null) {
        saveIdentity({ ...current, playerId: auth.playerId, sessionId: auth.sessionId });
      }
      // Явная подписка + догрузка истории чата (SPEC §6.1/§6.4, шаг 5).
      sendDynamic(ws, 'SUBSCRIBE', { sessionId: auth.sessionId });
      const since = lastMessageAt(get(chatStore).messages);
      sendDynamic(ws, 'HISTORY', {
        sessionId: auth.sessionId,
        ...(since === null ? {} : { since }),
        limit: 200,
        requestId: newRequestId(),
      });
      options.onAuthOk?.(auth);
    },
  });
  attachStores(ws);
  client = ws;
  ws.connect();
  return ws;
}

export function getConnection(): WSClient | null {
  return client;
}

export function requireConnection(): WSClient {
  if (client === null) throw new Error('client: соединение не установлено (нужен startConnection)');
  return client;
}

/** Ручное переподключение («Подключиться снова», F-6.10). */
export function reconnectNow(): void {
  client?.reconnectNow();
}

export function teardownConnection(): void {
  if (client !== null) {
    client.close();
    client = null;
  }
  resetStoresForLogout();
}

export function logout(): void {
  teardownConnection();
  clearIdentity();
}

// ------------------------------------------------------------ player actions

export interface ActionMetaInput {
  readonly targetObjectId?: string | null;
  readonly targetPlayerId?: string | null;
  readonly intent?: ActionIntent | null;
  readonly customLabel?: string | null;
}

/**
 * Отправка действия (SPEC §4): оптимистично показывается сразу;
 * ACTION_ACK → серверный actionId/sequenceId; ERROR → откат с кодом и
 * clientAction (stores/handlers.ts). idempotencyKey — crypto.randomUUID-based,
 * ≥16 символов; requestId — корреляция ack/ERROR.
 */
export function submitAction(turnId: string, rawText: string, meta?: ActionMetaInput): void {
  const ws = requireConnection();
  const requestId = newRequestId();
  const idempotencyKey = newIdempotencyKey('act');
  addSubmittedAction({
    requestId,
    idempotencyKey,
    rawText,
    turnId,
    status: 'PENDING',
    actionId: null,
    sequenceId: null,
    error: null,
    sentAt: new Date().toISOString(),
  });
  const metaPayload =
    meta === undefined
      ? undefined
      : {
          // ActionMetaSchema: все поля nullable c default — исходящий payload полный.
          targetObjectId: meta.targetObjectId ?? null,
          targetPlayerId: meta.targetPlayerId ?? null,
          intent: meta.intent ?? null,
          customLabel: meta.customLabel ?? null,
        };
  sendDynamic(ws, 'ACTION_SUBMIT', {
    turnId,
    rawText,
    ...(metaPayload === undefined ? {} : { meta: metaPayload }),
    idempotencyKey,
    requestId,
  });
}

/**
 * Повтор провалившегося действия. После доменного ERROR серверная
 * идемпотентность хранит прежний результат (D201: failed_before → прежний
 * errorCode), поэтому пользовательский retry — НОВАЯ операция: свежие
 * idempotencyKey и requestId. Прежние ключи переиспользует только
 * offline-очередь (транспортный повтор после реконнекта, A1.9).
 */
export function retryAction(originalRequestId: string): void {
  const action = Object.values(get(turnStore).submittedActions).find((item) => item.requestId === originalRequestId);
  if (action === undefined || action.status !== 'FAILED') return;
  submitAction(action.turnId, action.rawText);
}

// --------------------------------------------------------------------- chat

export function sendPublicChat(text: string): void {
  const ws = requireConnection();
  const requestId = newRequestId();
  addPendingChat({
    requestId,
    visibility: 'PUBLIC',
    text,
    toPlayerId: null,
    status: 'SENDING',
    error: null,
    sentAt: new Date().toISOString(),
  });
  sendDynamic(ws, 'CHAT_PUBLIC', { text, requestId });
}

export function sendPrivateChat(toPlayerId: string, text: string): void {
  const ws = requireConnection();
  const requestId = newRequestId();
  addPendingChat({
    requestId,
    visibility: 'PRIVATE',
    text,
    toPlayerId,
    status: 'SENDING',
    error: null,
    sentAt: new Date().toISOString(),
  });
  sendDynamic(ws, 'CHAT_PRIVATE', { toPlayerId, text, requestId });
}

export function retryChat(requestId: string): void {
  const pending = get(chatStore).pending.find((item) => item.requestId === requestId);
  if (pending === undefined) return;
  removePendingChat(requestId);
  if (pending.visibility === 'PRIVATE' && pending.toPlayerId !== null) {
    sendPrivateChat(pending.toPlayerId, pending.text);
  } else {
    sendPublicChat(pending.text);
  }
}

// --------------------------------------------------------------- GM команды

export interface GmCommandResult {
  readonly requestId: string;
  readonly idempotencyKey: string;
}

/**
 * GM-команда по WS с idempotencyKey (SPEC §5: ключ генерируется один раз на
 * операцию и переиспользуется при ретраях). Без оптимизма: статус BUSY до
 * GM_ACTION_ACK/ERROR; envelope сохраняется в turnStore.gmOps для retry.
 */
export function gmCommand(
  type:
    | 'GM_OPEN_TURN'
    | 'GM_LOCK_TURN'
    | 'GM_UNLOCK_TURN'
    | 'GM_COMMIT_TURN'
    | 'GM_EDIT_APPROVE'
    | 'GM_REJECT_TURN'
    | 'GM_RETRY_AI'
    | 'GM_MOVE_GROUP'
    | 'GM_SET_FLAG'
    | 'GM_PAUSE'
    | 'GM_RESUME'
    | 'GM_END_SESSION',
  payload: Record<string, unknown>,
  action: string,
): GmCommandResult {
  const ws = requireConnection();
  const requestId = newRequestId();
  const idempotencyKey = newIdempotencyKey('gm');
  const fullPayload = { ...payload, idempotencyKey, requestId };
  const op: GmOperation = {
    requestId,
    action,
    idempotencyKey,
    envelope: { type, payload: fullPayload },
    status: 'BUSY',
    error: null,
    startedAt: new Date().toISOString(),
  };
  addGmOperation(op);
  setBusyGmAction(action);
  sendDynamic(ws, type, fullPayload);
  return { requestId, idempotencyKey };
}

/** Повтор GM-операции ТЕМ ЖЕ envelope (тот же idempotencyKey — replay безопасен). */
export function retryGmOperation(requestId: string): void {
  const ws = requireConnection();
  const op = get(turnStore).gmOps[requestId];
  if (op === undefined || op.status === 'BUSY') return;
  updateGmOperation(requestId, { status: 'BUSY', error: null });
  setBusyGmAction(op.action);
  sendDynamic(ws, op.envelope.type, op.envelope.payload);
}

/** GM-заметка (GM_ADD_NOTE → GM_NOTE_ACK; ключ идемпотентности выводит сервер, D256). */
export function gmAddNote(input: {
  sessionId: string;
  turnId?: string | null;
  visibility: GMNoteVisibility;
  text: string;
}): void {
  const ws = requireConnection();
  const requestId = newRequestId();
  const op: GmOperation = {
    requestId,
    action: 'addNote',
    idempotencyKey: '',
    envelope: { type: 'GM_ADD_NOTE', payload: { ...input, requestId } },
    status: 'BUSY',
    error: null,
    startedAt: new Date().toISOString(),
  };
  addGmOperation(op);
  setBusyGmAction('addNote');
  sendDynamic(ws, 'GM_ADD_NOTE', {
    sessionId: input.sessionId,
    ...(input.turnId === undefined || input.turnId === null ? {} : { turnId: input.turnId }),
    visibility: input.visibility,
    text: input.text,
    requestId,
  });
}

/** GM: системное сообщение в ленту игроков (GM_SYSTEM_MESSAGE). */
export function gmSystemMessage(sessionId: string, text: string): void {
  const ws = requireConnection();
  sendDynamic(ws, 'GM_SYSTEM_MESSAGE', { sessionId, text, requestId: newRequestId() });
}

/** Ошибка GM-операции, обнаруженная на клиенте (HTTP/сеть) — снять BUSY. */
export function failGmOperation(requestId: string, code: string, message: string): void {
  const described = describeError(code, message);
  updateGmOperation(requestId, { status: 'ERROR', error: described });
  setBusyGmAction(null);
  pushFeed({ kind: 'error', error: described });
}

/** Брендовые id для HTTP/WS payload'ов (значения всегда приходят с сервера). */
export const brand = {
  turnId: (value: string): TurnId => value as TurnId,
  sessionId: (value: string): SessionId => value as SessionId,
  playerId: (value: string): PlayerId => value as PlayerId,
  idempotencyKey: (value: string): IdempotencyKey => value as IdempotencyKey,
};
