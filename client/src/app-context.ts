/**
 * Контекст приложения P05-B (realtime client).
 *
 * Владеет единственным WSClient и GameWorld; optimistic-операции v3 (submitAction/
 * chat/GM) удалены вместе с legacy-каталогом. Сторы обновляются только отсюда
 * (connectionStore) и из GameWorld (gameStore) — см. stores/connection.js.
 */
import { wsUrl } from './net/url.js';
import { WSClient, IDLE_SNAPSHOT, type ConnectionSnapshot } from './net/ws-client.js';
import { GameWorld } from './game-world/GameWorld.js';
import { parseNetworkProfile } from './game-world/net/profile.js';
import { connectionStore } from './stores/connection.js';
import { gameStore, EMPTY_GAME_HUD } from './stores/game.js';
import { clearIdentity, purgeTokensFromLocalStorage, type ClientIdentity } from './lib/privacy.js';

let client: WSClient | null = null;
let world: GameWorld | null = null;

export interface StartGameOptions {
  readonly identity: ClientIdentity;
  readonly parent: HTMLElement;
}

/** Создать WSClient + GameWorld, подключиться и запустить рендер. Возвращает cleanup. */
export function startGame(options: StartGameOptions): () => void {
  teardownGame();
  purgeTokensFromLocalStorage();

  const ws = new WSClient({
    url: wsUrl(),
    token: options.identity.token,
    networkProfile: parseNetworkProfile(netProfileParam()),
    onStatus: (snapshot: ConnectionSnapshot) => connectionStore.set(snapshot),
  });
  client = ws;
  const gameWorld = new GameWorld({ ws, parent: options.parent });
  world = gameWorld;
  ws.connect();
  void gameWorld
    .start()
    .catch((cause: unknown) =>
      console.error('game world start failed', cause instanceof Error ? cause.message : cause),
    );

  return () => teardownGame();
}

export function teardownGame(): void {
  if (world !== null) {
    world.destroy();
    world = null;
  }
  if (client !== null) {
    client.close();
    client = null;
  }
  connectionStore.set(IDLE_SNAPSHOT);
  gameStore.set(EMPTY_GAME_HUD);
}

export function reconnectNow(): void {
  client?.reconnectNow();
}

export function logout(): void {
  teardownGame();
  clearIdentity();
}

export function getGameWorld(): GameWorld | null {
  return world;
}

/** Искусственный сетевой профиль только через query-параметр (E2E/debug). */
function netProfileParam(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('netProfile');
  } catch {
    return null;
  }
}
