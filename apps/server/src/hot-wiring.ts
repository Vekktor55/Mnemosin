import {
  MatchId,
  ProjectionRevision,
  WorldEpoch,
  WorldPositionSchema,
  type GameState,
  type SpatialWorldPack,
} from '@mnemosin/contracts';
import type { LimitsConfig } from '@mnemosin/config';
import { HotRuntime, HotTickScheduler, type HotRuntimeConfig, type HotTickResult } from '@mnemosin/core';
import {
  realtimeNetworkConfig,
  type RealtimeNetworkConfig,
  type WsGatewayDeps,
  type WsHotMatchPort,
  type WsHotTickResult,
  type WsColdSceneSnapshot,
  type WsStaticScene,
} from '@mnemosin/gateway-ws';

/** PROTOTYPE-ONLY: P04 movement tuning; не клиентский сетевой контракт и не баланс. */
export const PROTOTYPE_HOT_RUNTIME_CONFIG: HotRuntimeConfig = Object.freeze({
  movementSpeedCellsPerSecond: 2,
  entityRadius: 0.2,
  collisionEpsilon: 1e-9,
  inputLeaseTicks: 100,
});

export interface PrototypeHotPlayer {
  readonly participantId: Parameters<HotRuntime['activateInputStream']>[0];
  readonly spawnPointId: 'player-1' | 'player-2';
}

export class PrototypeHotMatch implements WsHotMatchPort {
  readonly runtime: HotRuntime;
  readonly scheduler: HotTickScheduler;
  readonly matchId: MatchId;
  readonly worldEpoch: WorldEpoch;
  private listener: (result: WsHotTickResult) => void = () => undefined;

  constructor(
    pack: SpatialWorldPack,
    players: readonly PrototypeHotPlayer[],
    options?: {
      /**
       * PROTOTYPE-ONLY: идентификатор матча. В P06-прототипе одна сессия = один match,
       * поэтому wiring передаёт UUID сессии явно. `matchId` и `sessionId` — разные
       * идентификаторы: match определяет HOT-контекст, session — COLD-состояние.
       */
      readonly matchId?: MatchId;
      readonly worldEpoch?: WorldEpoch;
    },
    onDiagnostics?: (result: HotTickResult) => void,
  ) {
    const monotonicNow = () => performance.now();
    const matchId = options?.matchId ?? MatchId.parse(pack.manifest.floorId);
    const worldEpoch = options?.worldEpoch ?? WorldEpoch.parse(1);
    this.matchId = matchId;
    this.worldEpoch = worldEpoch;
    this.runtime = new HotRuntime({
      pack,
      players,
      config: PROTOTYPE_HOT_RUNTIME_CONFIG,
      now: monotonicNow,
      matchId,
      worldEpoch,
    });
    this.scheduler = new HotTickScheduler({
      now: monotonicNow,
      timers: {
        setInterval: (callback, intervalMs) => {
          const timer = setInterval(callback, intervalMs);
          timer.unref();
          return timer;
        },
        clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
      },
      tick: () => {
        const result = this.runtime.tick();
        this.listener(result);
        onDiagnostics?.(result);
        return result;
      },
    });
  }

  setTickListener(listener: (result: WsHotTickResult) => void): void {
    this.listener = listener;
  }
}

export function prototypeStaticScene(pack: SpatialWorldPack): WsStaticScene {
  return {
    worldPackVersion: pack.manifest.contentVersion,
    worldEpoch: WorldEpoch.parse(1),
    projectionRevision: ProjectionRevision.parse(1),
    environment: {
      worldId: pack.manifest.worldId,
      floorId: pack.manifest.floorId,
      worldSpaceId: pack.manifest.worldSpaceId,
    },
    objects: pack.objects.map((object) => {
      const portal = pack.portals.find((candidate) => candidate.stateObjectId === object.objectId);
      return {
        objectId: object.objectId,
        position: WorldPositionSchema.parse(object.position),
        ...(portal?.initialState !== undefined ? { portalState: portal.initialState } : {}),
      };
    }),
  };
}

/** P06 reconnect read-model: committed COLD object facts + revision, без чтения БД в HOT tick. */
export function prototypeColdScene(pack: SpatialWorldPack, state: GameState | null): WsColdSceneSnapshot {
  return {
    projectionRevision: ProjectionRevision.parse((state?.version ?? 0) + 1),
    objects: prototypeStaticScene(pack).objects.map((object) => {
      const cold = state?.objectStates[object.objectId];
      return cold === undefined ? object : { ...object, taken: cold.taken };
    }),
  };
}

/** Единственный mapping application config → WS prototype limits. */
export function prototypeRealtimeLimits(
  limits: Pick<
    LimitsConfig,
    'wsAuthTimeoutMs' | 'wsMaxConnectionsPerIp' | 'wsMaxPayloadBytes' | 'wsRatePerConnection' | 'heartbeat'
  >,
): Partial<RealtimeNetworkConfig> {
  return {
    wsAuthTimeoutMs: limits.wsAuthTimeoutMs,
    wsMaxConnectionsPerIp: limits.wsMaxConnectionsPerIp,
    wsMaxPayloadBytes: limits.wsMaxPayloadBytes,
    inputRatePerSecond: limits.wsRatePerConnection.DEFAULT,
    heartbeat: limits.heartbeat,
  };
}

export interface PrototypeWsOptions extends Omit<WsGatewayDeps, 'hot' | 'scene' | 'limits'> {
  readonly pack: SpatialWorldPack;
  readonly players: readonly PrototypeHotPlayer[];
  readonly limits?: Partial<RealtimeNetworkConfig>;
  /**
   * PROTOTYPE-ONLY: идентификатор матча для HOT-контекста и WS-сцены.
   * Если не задан — берётся floorId World Pack. `matchId` (матч) и `sessionId`
   * (COLD-сессия) — разные идентификаторы и не подменяют друг друга.
   */
  readonly matchId?: MatchId;
  readonly worldEpoch?: WorldEpoch;
}

export function createPrototypeWsGateway(
  options: PrototypeWsOptions,
): WsGatewayDeps & { readonly hot: PrototypeHotMatch } {
  const hot = new PrototypeHotMatch(options.pack, options.players, {
    ...(options.matchId !== undefined ? { matchId: options.matchId } : {}),
    ...(options.worldEpoch !== undefined ? { worldEpoch: options.worldEpoch } : {}),
  });
  return {
    ...options,
    hot,
    scene: prototypeStaticScene(options.pack),
    limits: realtimeNetworkConfig(options.limits),
  };
}
