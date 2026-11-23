import {
  MatchId,
  ProjectionRevision,
  WorldEpoch,
  WorldPositionSchema,
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
  private listener: (result: WsHotTickResult) => void = () => undefined;

  constructor(
    pack: SpatialWorldPack,
    players: readonly PrototypeHotPlayer[],
    onDiagnostics?: (result: HotTickResult) => void,
  ) {
    const monotonicNow = () => performance.now();
    const matchId = MatchId.parse(pack.manifest.floorId); // прототип: используем floorId как matchId
    const worldEpoch = WorldEpoch.parse(1);
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
}

export function createPrototypeWsGateway(
  options: PrototypeWsOptions,
): WsGatewayDeps & { readonly hot: PrototypeHotMatch } {
  const hot = new PrototypeHotMatch(options.pack, options.players);
  return {
    ...options,
    hot,
    scene: prototypeStaticScene(options.pack),
    limits: realtimeNetworkConfig(options.limits),
  };
}
