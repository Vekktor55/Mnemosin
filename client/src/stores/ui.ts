import { writable } from 'svelte/store';

import type { DescribedError } from '../lib/errors.js';

/** Вкладки GMPanel (SPEC §5). */
export type GmTab = 'review' | 'turn' | 'state' | 'inspect' | 'notes' | 'audit';

export const GM_TABS: readonly { readonly id: GmTab; readonly label: string }[] = Object.freeze([
  { id: 'review', label: 'Review' },
  { id: 'turn', label: 'Turn' },
  { id: 'state', label: 'State' },
  { id: 'inspect', label: 'Inspect' },
  { id: 'notes', label: 'Notes' },
  { id: 'audit', label: 'Audit' },
]);

export type FeedKind =
  | 'narrative'
  | 'private'
  | 'system'
  | 'error'
  | 'info'
  | 'capability'
  | 'budget'
  | 'session'
  | 'turn-failed'
  | 'gm-ack';

export interface FeedEntry {
  readonly id: string;
  readonly kind: FeedKind;
  readonly at: string;
  readonly text: string | null;
  /** narrative: сегменты TURN_COMMITTED (рендерятся отдельными абзацами). */
  readonly segments: readonly { readonly segmentId: string; readonly text: string }[] | null;
  readonly error: DescribedError | null;
  readonly details: Readonly<Record<string, unknown>> | null;
}

export interface UiState {
  /** Лента SystemFeed (кольцо 100) — ошибки, нарратив, сервисные события. */
  readonly feed: readonly FeedEntry[];
  readonly gmTab: GmTab;
  /** Последний requestId GM-операции в полёте (индикаторы кнопок). */
  readonly busyGmAction: string | null;
}

export const FEED_RING = 100;

const EMPTY_UI: UiState = Object.freeze({ feed: [], gmTab: 'review', busyGmAction: null });

export const uiStore = writable<UiState>(EMPTY_UI);

let feedCounter = 0;

export interface FeedEntryDraft {
  readonly kind: FeedKind;
  readonly at?: string;
  readonly text?: string | null;
  readonly segments?: readonly { readonly segmentId: string; readonly text: string }[] | null;
  readonly error?: DescribedError | null;
  readonly details?: Readonly<Record<string, unknown>> | null;
}

export function pushFeed(entry: FeedEntryDraft): void {
  feedCounter += 1;
  const full: FeedEntry = Object.freeze({
    id: `feed-${Date.now()}-${feedCounter}`,
    at: entry.at ?? new Date().toISOString(),
    kind: entry.kind,
    text: entry.text ?? null,
    segments: entry.segments ?? null,
    error: entry.error ?? null,
    details: entry.details ?? null,
  });
  uiStore.update((state) => {
    const feed = [full, ...state.feed];
    return Object.freeze({ ...state, feed: Object.freeze(feed.length > FEED_RING ? feed.slice(0, FEED_RING) : feed) });
  });
}

export function pushFeedError(error: DescribedError, details?: Record<string, unknown>): void {
  pushFeed({ kind: 'error', error, details: details ?? null });
}

export function setGmTab(tab: GmTab): void {
  uiStore.update((state) => Object.freeze({ ...state, gmTab: tab }));
}

export function setBusyGmAction(action: string | null): void {
  uiStore.update((state) => Object.freeze({ ...state, busyGmAction: action }));
}

export function resetUiStore(): void {
  uiStore.set(EMPTY_UI);
}
