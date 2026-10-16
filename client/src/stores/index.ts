/**
 * Barrel сторов (промпт 1.12, п.3). Импортируется компонентами; обновление —
 * только stores/handlers.ts (WS) и app-context.ts (optimistic-операции).
 */
export { connectionStore } from './connection.js';
export { sessionStore, EMPTY_SESSION, resetSessionStore, type SessionState, type PresenceEntry } from './session.js';
export {
  chatStore,
  EMPTY_CHAT,
  CHAT_RING_BUFFER,
  addServerMessage,
  mergeHistory,
  addPendingChat,
  updatePendingChat,
  removePendingChat,
  ackPendingChat,
  lastMessageAt,
  resetChatStore,
  type ChatState,
  type PendingChatMessage,
} from './chat.js';
export {
  turnStore,
  EMPTY_TURN,
  setTurnView,
  setTurnFailed,
  setCommitted,
  addPrivateResolution,
  addSubmittedAction,
  ackSubmittedAction,
  failSubmittedAction,
  dropSubmittedAction,
  addGmOperation,
  updateGmOperation,
  setDraft,
  setDraftFromConflict,
  acknowledgeDraftStale,
  setAiContext,
  resetTurnStore,
  type TurnState,
  type SubmittedAction,
  type GmOperation,
  type CommittedTurn,
} from './turn.js';
export {
  visualStore,
  EMPTY_VISUAL,
  upsertMediaJob,
  upsertAudioJob,
  resetVisualStore,
  type VisualState,
} from './visual.js';
export {
  uiStore,
  GM_TABS,
  FEED_RING,
  pushFeed,
  pushFeedError,
  setGmTab,
  setBusyGmAction,
  resetUiStore,
  type UiState,
  type FeedEntry,
  type FeedKind,
  type GmTab,
} from './ui.js';
export { attachStores, resetStoresForLogout } from './handlers.js';
