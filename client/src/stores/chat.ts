import { writable } from 'svelte/store';
import type { ChatMessageView } from '@mnemosin/contracts';

import type { DescribedError } from '../lib/errors.js';

/** Кольцевой буфер — 500 (config/limits.yaml chatRingBuffer; SPEC §4). */
export const CHAT_RING_BUFFER = 500;

export interface PendingChatMessage {
  readonly requestId: string;
  readonly visibility: 'PUBLIC' | 'PRIVATE';
  readonly text: string;
  readonly toPlayerId: string | null;
  readonly status: 'SENDING' | 'FAILED';
  readonly error: DescribedError | null;
  readonly sentAt: string;
}

export interface ChatState {
  /** Серверные сообщения (PUBLIC/PRIVATE/SYSTEM/GM), дедупликация по messageId. */
  readonly messages: readonly ChatMessageView[];
  /** Оптимистичные отправки до CHAT_ACK (reconcile по requestId→messageId). */
  readonly pending: readonly PendingChatMessage[];
}

export const EMPTY_CHAT: ChatState = Object.freeze({ messages: [], pending: [] });

export const chatStore = writable<ChatState>(EMPTY_CHAT);

function pushMessage(messages: readonly ChatMessageView[], view: ChatMessageView): ChatMessageView[] {
  if (messages.some((item) => item.messageId === view.messageId)) return [...messages];
  const next = [...messages, view].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return next.length > CHAT_RING_BUFFER ? next.slice(next.length - CHAT_RING_BUFFER) : next;
}

/** Входящее серверное сообщение (CHAT_PUBLIC/PRIVATE/SYSTEM/GM). */
export function addServerMessage(view: ChatMessageView): void {
  chatStore.update((state) => Object.freeze({ ...state, messages: Object.freeze(pushMessage(state.messages, view)) }));
}

/** HISTORY_RESULT: слияние с дедупликацией по messageId (A1.10). */
export function mergeHistory(messages: readonly ChatMessageView[]): void {
  chatStore.update((state) => {
    let next = [...state.messages];
    for (const view of messages) next = pushMessage(next, view);
    next = next.length > CHAT_RING_BUFFER ? next.slice(next.length - CHAT_RING_BUFFER) : next;
    return Object.freeze({ ...state, messages: Object.freeze(next) });
  });
}

/** Оптимистичная отправка (локальная операция §VII.8; reconcile — CHAT_ACK). */
export function addPendingChat(pending: PendingChatMessage): void {
  chatStore.update((state) => Object.freeze({ ...state, pending: Object.freeze([...state.pending, pending]) }));
}

export function updatePendingChat(requestId: string, patch: Partial<PendingChatMessage>): void {
  chatStore.update((state) =>
    Object.freeze({
      ...state,
      pending: Object.freeze(
        state.pending.map((item) => (item.requestId === requestId ? Object.freeze({ ...item, ...patch }) : item)),
      ),
    }),
  );
}

export function removePendingChat(requestId: string): void {
  chatStore.update((state) =>
    Object.freeze({ ...state, pending: Object.freeze(state.pending.filter((item) => item.requestId !== requestId)) }),
  );
}

/**
 * CHAT_ACK: pending → delivered. PRIVATE-копия отправителю сервером НЕ
 * рассылается (TARGETED только адресату), поэтому свое сообщение материализуем
 * из pending; PUBLIC придёт broadcast'ом и схлопнется по messageId.
 */
export function ackPendingChat(
  requestId: string,
  messageId: string,
  me: { playerId: string | null; displayName: string },
): void {
  chatStore.update((state) => {
    const pending = state.pending.find((item) => item.requestId === requestId);
    if (pending === undefined) return state;
    const view: ChatMessageView = {
      // Бренды контрактов (MessageId/PlayerId) — значения приходят с сервера,
      // здесь обратная материализация view из уже валидированного ack.
      messageId: messageId as ChatMessageView['messageId'],
      visibility: pending.visibility,
      fromPlayerId: (me.playerId ?? null) as ChatMessageView['fromPlayerId'],
      fromDisplayName: me.displayName.length > 0 ? me.displayName : null,
      toPlayerId: (pending.toPlayerId ?? null) as ChatMessageView['toPlayerId'],
      text: pending.text,
      turnId: null,
      createdAt: pending.sentAt,
    };
    return Object.freeze({
      messages: Object.freeze(pushMessage(state.messages, view)),
      pending: Object.freeze(state.pending.filter((item) => item.requestId !== requestId)),
    });
  });
}

/** Последнее createdAt — для HISTORY{since} после реконнекта (SPEC §6.4, шаг 5). */
export function lastMessageAt(messages: readonly ChatMessageView[]): string | null {
  if (messages.length === 0) return null;
  const last = messages[messages.length - 1];
  return last === undefined ? null : last.createdAt;
}

export function resetChatStore(): void {
  chatStore.set(EMPTY_CHAT);
}
