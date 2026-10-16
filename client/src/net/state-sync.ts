/**
 * Догонка публичной проекции (промпт 1.12).
 *
 * PLAYER_JOINED транслируется гейтвеем как PLAYER_PRESENCE (без имени, D278);
 * полный список игроков приходит в STATE_PROJECTION (reconnect-последовательность
 * и STATE_COMMITTED). Чтобы новый игрок появлялся в PlayerPanel/PrivateChat
 * сразу, при presence НЕИЗВЕСТНОГО playerId клиент разово добирает публичную
 * проекцию по HTTP (GET /state/projection?view=public, auth player) и кладёт
 * её в sessionStore — стор по-прежнему обновляется из одного места.
 */
import type { PublicGameStateView } from '@mnemosin/contracts';

import { api } from './http.js';
import { sessionStore } from '../stores/session.js';
import { loadIdentity } from '../lib/privacy.js';

let inFlight = false;

export async function refreshPublicState(sessionId: string): Promise<void> {
  if (inFlight) return;
  const token = loadIdentity()?.token;
  if (token === undefined) return;
  inFlight = true;
  try {
    const view = await api<PublicGameStateView>('GET', '/state/projection', {
      token,
      query: { sessionId, view: 'public' },
    });
    sessionStore.update((state) => Object.freeze({ ...state, publicState: view }));
  } catch {
    // best-effort: следующий STATE_COMMITTED/реконнект догонит проекцию
  } finally {
    inFlight = false;
  }
}
