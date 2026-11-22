import type {
  InputStreamId,
  MatchId,
  ParticipantId,
  SceneInputAckMessage,
  SceneObject,
  SessionId,
  SimulationTick,
  WorldEpoch,
  ProjectionRevision,
  WorldId,
  FloorId,
  WorldSpaceId,
  WorldPosition,
  MovementInput,
  ConnectionEpoch,
} from '@mnemosin/contracts';

import type { RealtimeNetworkConfig } from './config.js';

export type { RealtimeNetworkConfig } from './config.js';
export type WsLimits = RealtimeNetworkConfig;

export type WsActorType = 'player' | 'observer' | 'developer';
export type WsProjectionKind = 'player' | 'observer';
export type WsConnectionState =
  'unauthenticated' | 'authenticating' | 'awaiting_client_ready' | 'syncing' | 'ready' | 'closing' | 'closed';

/** Формируется только сервером после JWT и membership checks. */
export interface ConnectionActorContext {
  readonly connectionId: string;
  readonly actorId: ParticipantId;
  readonly actorType: WsActorType;
  readonly matchId: MatchId;
  readonly sessionId: SessionId;
  readonly connectionEpoch: ConnectionEpoch;
  readonly projectionKind: WsProjectionKind;
  readonly permissions: readonly string[];
}

export interface WsAuthenticatedActor {
  readonly actorId: ParticipantId;
  readonly actorType: WsActorType;
  readonly matchId: MatchId;
  readonly sessionId: SessionId;
  readonly projectionKind: WsProjectionKind;
  readonly permissions: readonly string[];
}

export type WsAuthenticationResult =
  | { readonly ok: true; readonly actor: WsAuthenticatedActor }
  | { readonly ok: false; readonly code: 'AUTH_INVALID' | 'AUTH_EXPIRED' | 'AUTH_FORBIDDEN' };

export interface WsHotPlayerState {
  readonly participantId: ParticipantId;
  readonly position: WorldPosition;
  readonly direction: MovementInput;
  readonly velocity: WorldPosition;
  readonly activeInputStreamId: InputStreamId | null;
  readonly lastProcessedInputSequence: number | null;
  readonly lastInputTick: SimulationTick | null;
}

export interface WsHotSimulationState {
  readonly simulationTick: SimulationTick;
  readonly players: readonly WsHotPlayerState[];
}

export interface WsHotTickResult {
  readonly acknowledgements: readonly SceneInputAckMessage[];
  readonly diagnostics: {
    readonly simulationTick: SimulationTick;
    readonly durationMs: number;
    readonly overrun: boolean;
  };
}

export type WsHotInputReceipt =
  | { readonly accepted: true; readonly arrivalSequence: number }
  | {
      readonly accepted: false;
      readonly reason: 'invalid_message' | 'unknown_player' | 'inactive_stream' | 'stale_sequence';
    };

export interface WsHotRuntimePort {
  activateInputStream(participantId: ParticipantId, streamId: InputStreamId): void;
  receiveInput(participantId: ParticipantId, message: unknown): WsHotInputReceipt;
  getState(): WsHotSimulationState;
}

export interface WsHotSchedulerPort {
  start(): void;
  stop(): void;
  status(): { readonly started: boolean; readonly backlogMs: number };
}

export interface WsHotMatchPort {
  readonly runtime: WsHotRuntimePort;
  readonly scheduler: WsHotSchedulerPort;
  setTickListener(listener: (result: WsHotTickResult) => void): void;
}

export interface WsStaticScene {
  readonly worldPackVersion: string;
  readonly worldEpoch: WorldEpoch;
  readonly projectionRevision: ProjectionRevision;
  readonly environment: { readonly worldId: WorldId; readonly floorId: FloorId; readonly worldSpaceId: WorldSpaceId };
  readonly objects: readonly SceneObject[];
}

export interface WsHiddenFactSource {
  hiddenFact(participantId: ParticipantId): { readonly hiddenRole: string | null; readonly infected: boolean };
}

export interface WsGatewayLog {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export interface WsGatewayDeps {
  readonly hot: WsHotMatchPort;
  readonly scene: WsStaticScene;
  authenticate(token: string): Promise<WsAuthenticationResult>;
  readonly hiddenFacts?: WsHiddenFactSource;
  readonly limits: RealtimeNetworkConfig;
  readonly serverVersion: string;
  readonly contractsVersion: string;
  readonly logger?: WsGatewayLog;
  readonly now?: () => number;
  readonly newId?: () => string;
  /** Детерминированный network impairment probe для integration-тестов; production не задаёт. */
  readonly isBackpressured?: (bufferedAmount: number, limit: number) => boolean;
}
