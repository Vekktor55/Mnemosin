import { writable } from 'svelte/store';

/**
 * HUD-метрики клиента (P05-B §7.6): обновляются throttled из GameWorld, чтобы
 * не дергать Svelte-реактивность на каждом кадре. Raw per-frame метрики для E2E
 * публикуются отдельно в `window.__MNEMOSIN__`.
 */
export interface GameHudState {
  readonly fps: number;
  readonly frameTimeMs: number;
  readonly inputToVisualMs: number;
  readonly rttMs: number | null;
  readonly ready: boolean;
  readonly myParticipantId: string | null;
  readonly playerCount: number;
}

export const EMPTY_GAME_HUD: GameHudState = Object.freeze({
  fps: 0,
  frameTimeMs: 0,
  inputToVisualMs: 0,
  rttMs: null,
  ready: false,
  myParticipantId: null,
  playerCount: 0,
});

export const gameStore = writable<GameHudState>(EMPTY_GAME_HUD);

export function setGameHud(patch: Partial<GameHudState>): void {
  gameStore.update((state) => Object.freeze({ ...state, ...patch }));
}
