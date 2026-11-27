/**
 * Barrel сторов P05-B: connection + game HUD. Legacy session/chat/turn/visual/ui
 * сторы удалены вместе с v3-протоколом (P05-A удалил Turn/GM/Chat из шлюза).
 */
export { connectionStore } from './connection.js';
export { gameStore, EMPTY_GAME_HUD, setGameHud } from './game.js';
export type { GameHudState } from './game.js';
