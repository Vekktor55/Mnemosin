import { writable } from 'svelte/store';
import type {
  CapabilityAvailability,
  GMStateView,
  PlayerGameStateView,
  PublicGameStateView,
} from '@mnemosin/contracts';

/** Статус присутствия игрока (PLAYER_PRESENCE). */
export interface PresenceEntry {
  readonly status: 'ACTIVE' | 'DISCONNECTED' | 'LEFT' | 'SPECTATOR';
  readonly connections: number;
}

export interface SessionState {
  readonly sessionId: string | null;
  readonly status: 'LOBBY' | 'ACTIVE' | 'PAUSED' | 'ENDED' | null;
  readonly myPlayerId: string | null;
  readonly isGM: boolean;
  readonly serverVersion: string | null;
  readonly contractsVersion: string | null;
  readonly capabilities: readonly CapabilityAvailability[];
  /** STATE_PROJECTION (BROADCAST): локация, игроки, публичные флаги (D124), объекты. */
  readonly publicState: PublicGameStateView | null;
  /** STATE_PROJECTION_PRIVATE (TARGETED): только свой knowledge. */
  readonly privateState: PlayerGameStateView | null;
  readonly presence: Readonly<Record<string, PresenceEntry>>;
  /** GM_STATE / POST /gm/inspect/state — только для GM-панели. */
  readonly gmState: GMStateView | null;
  /** BUDGET_WARNING/BUDGET_EXCEEDED (GM_ONLY). */
  readonly budget: {
    readonly spentUsd: number;
    readonly budgetUsd: number;
    readonly exceeded: boolean;
    readonly disabledCapability: string | null;
  } | null;
}

export const EMPTY_SESSION: SessionState = Object.freeze({
  sessionId: null,
  status: null,
  myPlayerId: null,
  isGM: false,
  serverVersion: null,
  contractsVersion: null,
  capabilities: [],
  publicState: null,
  privateState: null,
  presence: {},
  gmState: null,
  budget: null,
});

export const sessionStore = writable<SessionState>(EMPTY_SESSION);

export function resetSessionStore(keepIdentity: boolean): void {
  sessionStore.update((current) =>
    keepIdentity
      ? {
          ...EMPTY_SESSION,
          sessionId: current.sessionId,
          myPlayerId: current.myPlayerId,
          isGM: current.isGM,
        }
      : EMPTY_SESSION,
  );
}
