import {
  InputStreamId,
  type MatchId,
  ParticipantId,
  SceneInputMessageSchema,
  SimulationTick,
  type WorldEpoch,
  type SceneInputMessage,
  type SpatialWorldPack,
} from '@mnemosin/contracts';

import { FIXED_DT_MS } from './constants.js';
import {
  compileHotWorldGeometry,
  isCirclePositionFree,
  type HotGeometryOptions,
  type HotWorldGeometry,
} from './geometry.js';
import { runHotSimulationStep } from './simulation.js';
import type { HotInputReceipt, HotQueuedInput, HotRuntimeConfig, HotSimulationState, HotTickResult } from './types.js';
import { HotColdRevisionBoundary } from './cold-boundary.js';

export interface HotPlayerSpawn {
  readonly participantId: ParticipantId;
  readonly spawnPointId: string;
}

export interface HotRuntimeOptions extends HotGeometryOptions {
  readonly pack: SpatialWorldPack;
  readonly players: readonly HotPlayerSpawn[];
  readonly config: HotRuntimeConfig;
  readonly matchId: MatchId;
  readonly worldEpoch: WorldEpoch;
  /** Монотонные часы только для диагностики, не для интеграции движения. */
  readonly now?: () => number;
}

function validateConfig(config: HotRuntimeConfig): void {
  if (!Number.isFinite(config.movementSpeedCellsPerSecond) || config.movementSpeedCellsPerSecond <= 0) {
    throw new Error('HOT config: movementSpeedCellsPerSecond должен быть положительным finite number');
  }
  if (!Number.isFinite(config.entityRadius) || config.entityRadius <= 0) {
    throw new Error('HOT config: entityRadius должен быть положительным finite number');
  }
  if (
    !Number.isFinite(config.collisionEpsilon) ||
    config.collisionEpsilon <= 0 ||
    config.collisionEpsilon >= config.entityRadius
  ) {
    throw new Error('HOT config: collisionEpsilon должен быть > 0 и < entityRadius');
  }
  if (!Number.isSafeInteger(config.inputLeaseTicks) || config.inputLeaseTicks <= 0) {
    throw new Error('HOT config: inputLeaseTicks должен быть положительным safe integer');
  }
}

/** Внешняя доставка сообщений и ownership состояния; чистый расчёт в simulation.ts. */
export class HotRuntime {
  readonly geometry: HotWorldGeometry;
  readonly config: HotRuntimeConfig;
  readonly coldBoundary: HotColdRevisionBoundary;

  private state: HotSimulationState;
  private pending: HotQueuedInput[] = [];
  private readonly pendingHighWater = new Map<ParticipantId, SceneInputMessage['inputSequence']>();
  private readonly now: () => number;
  private arrivalSequence = 0;

  constructor(options: HotRuntimeOptions) {
    validateConfig(options.config);
    this.config = { ...options.config };
    this.now = options.now ?? (() => performance.now());
    this.geometry = compileHotWorldGeometry(options.pack, options);
    this.coldBoundary = new HotColdRevisionBoundary({
      matchId: options.matchId,
      worldEpoch: options.worldEpoch,
    });

    const seenParticipants = new Set<ParticipantId>();
    const players = options.players.map((spawn) => {
      const participantId = ParticipantId.parse(spawn.participantId);
      if (seenParticipants.has(participantId)) throw new Error(`HOT: дубликат participantId «${participantId}»`);
      seenParticipants.add(participantId);
      const spawnPoint = options.pack.spawnPoints.find((point) => point.spawnPointId === spawn.spawnPointId);
      if (spawnPoint === undefined) throw new Error(`HOT: неизвестный spawnPointId «${spawn.spawnPointId}»`);
      const position = { ...spawnPoint.position };
      if (!isCirclePositionFree(position, this.config.entityRadius, this.config.collisionEpsilon, this.geometry)) {
        throw new Error(`HOT: spawn «${spawn.spawnPointId}» пересекается с collision geometry`);
      }
      return {
        participantId,
        position,
        direction: { directionX: 0, directionY: 0 },
        velocity: { x: 0, y: 0 },
        activeInputStreamId: null,
        lastProcessedInputSequence: null,
        lastInputTick: null,
      };
    });
    players.sort((a, b) => a.participantId.localeCompare(b.participantId));
    this.state = { simulationTick: SimulationTick.parse(0), players };
  }

  getState(): HotSimulationState {
    return this.state;
  }

  /** Явная смена connection epoch; старые queued packets и held direction отбрасываются. */
  activateInputStream(participantId: ParticipantId, streamId: InputStreamId): void {
    const player = this.state.players.find((candidate) => candidate.participantId === participantId);
    if (player === undefined) throw new Error(`HOT: неизвестный participantId «${participantId}»`);
    const parsedStream = InputStreamId.parse(streamId);
    if (player.activeInputStreamId === parsedStream) return;

    this.pending = this.pending.filter((queued) => queued.participantId !== participantId);
    this.pendingHighWater.delete(participantId);
    this.state = {
      ...this.state,
      players: this.state.players.map((candidate) =>
        candidate.participantId === participantId
          ? {
              ...candidate,
              direction: { directionX: 0, directionY: 0 },
              velocity: { x: 0, y: 0 },
              activeInputStreamId: parsedStream,
              lastProcessedInputSequence: null,
              lastInputTick: null,
            }
          : candidate,
      ),
    };
  }

  receiveInput(participantId: ParticipantId, rawMessage: unknown): HotInputReceipt {
    const parsed = SceneInputMessageSchema.safeParse(rawMessage);
    if (!parsed.success) return { accepted: false, reason: 'invalid_message' };
    let player = this.state.players.find((candidate) => candidate.participantId === participantId);
    if (player === undefined) return { accepted: false, reason: 'unknown_player' };

    if (player.activeInputStreamId === null) this.activateInputStream(participantId, parsed.data.inputStreamId);
    player = this.state.players.find((candidate) => candidate.participantId === participantId);
    if (player === undefined || player.activeInputStreamId !== parsed.data.inputStreamId) {
      return { accepted: false, reason: 'inactive_stream' };
    }

    const highWater = this.pendingHighWater.get(participantId) ?? player.lastProcessedInputSequence;
    if (highWater !== null && parsed.data.inputSequence <= highWater) {
      return { accepted: false, reason: 'stale_sequence' };
    }

    this.arrivalSequence += 1;
    this.pendingHighWater.set(participantId, parsed.data.inputSequence);
    this.pending.push({ arrivalSequence: this.arrivalSequence, participantId, message: parsed.data });
    return { accepted: true, arrivalSequence: this.arrivalSequence };
  }

  receiveColdCommand(raw: unknown) {
    return this.coldBoundary.receive(raw);
  }

  getColdBoundaryState() {
    return this.coldBoundary.getState();
  }

  tick(): HotTickResult {
    const startedAt = this.now();

    // Step 2: Apply committed COLD updates in revision order
    const boundaryResult = this.coldBoundary.drainForTick();

    const inputs = this.pending;
    this.pending = [];
    const result = runHotSimulationStep(this.state, inputs, this.geometry, this.config);
    this.state = result.state;
    const durationMs = Math.max(0, this.now() - startedAt);
    return {
      acknowledgements: result.acknowledgements,
      diagnostics: {
        simulationTick: this.state.simulationTick,
        durationMs,
        overrun: durationMs > FIXED_DT_MS,
        coldRevisionsApplied: boundaryResult.appliedRevision,
        awaitingColdRevision: boundaryResult.awaitingRevision,
      },
    };
  }
}
