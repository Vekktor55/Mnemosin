/**
 * GameWorld — оркестратор realtime-клиента P05-B.
 *
 * Связывает WSClient (v4), KeyboardInputController, ClientPrediction,
 * InterpolationBuffer и PixiRenderer. Рендер-цикл независим от WebSocket
 * (requestAnimationFrame), input sampling — каждый кадр, отправка — ~20 Гц.
 *
 * Авторитетная позиция принадлежит серверу: prediction/advance меняют только
 * отображаемую позицию; authoritative обновляется лишь из ACK/keyframe/delta.
 */
import {
  InputStreamId,
  InputSequence,
  type MovementInput,
  type PlayerSceneEntity,
  type SceneDeltaPayload,
  type SceneKeyframePayload,
  type SceneInputAckMessage,
} from '@mnemosin/contracts';

import { GridProjection } from './projection/GridProjection.js';
import { PixiRenderer } from './pixi/PixiRenderer.js';
import { KeyboardInputController } from './movement/input.js';
import { ClientPrediction } from './movement/prediction.js';
import { InterpolationBuffer } from './movement/interpolation.js';
import type { WSClient } from '../net/ws-client.js';
import { setGameHud } from '../stores/game.js';

/** PROTOTYPE-ONLY: зеркало серверного HOT config (без импорта core/). */
const PROTOTYPE_SPEED_CELLS_PER_SECOND = 2;
const PROTOTYPE_FIXED_DT_SECONDS = 0.05;
const PROTOTYPE_INTERPOLATION_DELAY_MS = 100;
const PROTOTYPE_EXTRAPOLATION_LIMIT_MS = 100;
const PROTOTYPE_INTERPOLATION_BUFFER_SIZE = 32;
const INPUT_SEND_INTERVAL_MS = 50;
const MAX_FRAME_DT_SECONDS = 0.1;
const HUD_UPDATE_INTERVAL_MS = 250;

export interface GameWorldOptions {
  readonly ws: WSClient;
  readonly parent: HTMLElement;
}

interface DebugMetrics {
  readonly fps: number;
  readonly frameTimeMs: number;
  readonly inputToVisualMs: number;
  readonly rttMs: number | null;
  readonly ready: boolean;
  readonly myParticipantId: string | null;
  readonly playerCount: number;
  readonly ownX: number;
  readonly ownY: number;
  readonly authoritativeX: number;
  readonly authoritativeY: number;
  readonly doorPortalState: 'open' | 'closed' | 'locked' | null;
  readonly remotes: ReadonlyArray<{ readonly participantId: string; readonly x: number; readonly y: number }>;
}

export class GameWorld {
  private readonly ws: WSClient;
  private readonly parent: HTMLElement;
  private readonly projection: GridProjection;
  private readonly renderer: PixiRenderer;
  private readonly input: KeyboardInputController;
  private readonly interpolation: InterpolationBuffer;
  private prediction: ClientPrediction | null = null;
  private ownParticipantId: string | null = null;
  private doorPortalState: 'open' | 'closed' | 'locked' | null = null;
  private readonly lastRemotePositions = new Map<string, { x: number; y: number }>();
  private serverClockOffsetMs = 0;
  private inputSendTimer: ReturnType<typeof setInterval> | null = null;
  private frameHandle: number | null = null;
  private lastFrameAt = 0;
  private lastFrameTimeMs = 0;
  private inputChangedAt: number | null = null;
  private lastInputToVisualMs = 0;
  private lastHudAt = 0;

  constructor(options: GameWorldOptions) {
    this.ws = options.ws;
    this.parent = options.parent;
    this.projection = new GridProjection({
      halfTileWidth: 32,
      halfTileHeight: 16,
      originX: 0,
      originY: 0,
      elevationStep: 12,
    });
    this.renderer = new PixiRenderer(this.projection);
    this.input = new KeyboardInputController();
    this.interpolation = new InterpolationBuffer({
      interpolationDelayMs: PROTOTYPE_INTERPOLATION_DELAY_MS,
      extrapolationLimitMs: PROTOTYPE_EXTRAPOLATION_LIMIT_MS,
      maxBufferSize: PROTOTYPE_INTERPOLATION_BUFFER_SIZE,
    });
  }

  async start(): Promise<void> {
    await this.renderer.init(this.parent);
    this.input.attach(window, window, document);
    this.input.setOnChange(() => this.onDirectionChange());

    this.ws.on('scene:keyframe', (message) => this.onKeyframe(message.payload));
    this.ws.on('scene:delta', (message) => this.onDelta(message.payload));
    this.ws.on('connection:ready', () => this.onReady());
    this.ws.on('scene:resync-required', () => {
      this.interpolation.reset();
      this.prediction?.reset(this.prediction.snapshot().authoritative);
    });
    this.ws.on('scene:input-ack', (message) => this.onInputAck(message.payload));

    this.inputSendTimer = setInterval(() => {
      const direction = this.input.current();
      if (direction.directionX !== 0 || direction.directionY !== 0) this.transmitInput(direction);
    }, INPUT_SEND_INTERVAL_MS);

    this.lastFrameAt = performance.now();
    this.lastHudAt = this.lastFrameAt;
    const loop = (now: number): void => {
      this.frameHandle = requestAnimationFrame(loop);
      const frameDt = Math.min((now - this.lastFrameAt) / 1000, MAX_FRAME_DT_SECONDS);
      this.lastFrameTimeMs = now - this.lastFrameAt;
      this.lastFrameAt = now;
      this.tick(frameDt, now);
    };
    this.frameHandle = requestAnimationFrame(loop);
  }

  destroy(): void {
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    if (this.inputSendTimer !== null) clearInterval(this.inputSendTimer);
    this.input.detach();
    this.renderer.destroy();
  }

  // ------------------------------------------------------------ ws handlers

  private onKeyframe(keyframe: SceneKeyframePayload): void {
    this.ownParticipantId = this.ws.getConnectionInfo()?.actorId ?? null;
    this.interpolation.reset();
    this.prediction = this.newPredictionFromKeyframe(keyframe);
    this.applyProjection(keyframe.projection.entities, keyframe.simulationTick, keyframe.serverTimeMs);
    this.renderer.setSceneObjects(keyframe.projection.objects);
    this.doorPortalState =
      keyframe.projection.objects.find((object) => object.portalState !== undefined)?.portalState ?? null;
    this.syncServerClock(keyframe.serverTimeMs);
    this.setReady(keyframe.projection.entities.length);
  }

  private onDelta(delta: SceneDeltaPayload): void {
    this.applyProjection(delta.entityUpserts, delta.simulationTick, delta.serverTimeMs);
    for (const participantId of delta.entityRemovals) {
      this.interpolation.remove(participantId);
      this.lastRemotePositions.delete(participantId);
      this.renderer.removePlayer(participantId);
    }
    if (delta.ownActorState !== undefined && this.prediction !== null) {
      this.prediction.reset(delta.ownActorState.position);
    }
    this.syncServerClock(delta.serverTimeMs);
  }

  private onInputAck(ack: SceneInputAckMessage): void {
    if (this.prediction === null) return;
    this.prediction.reconcile({
      lastProcessedInputSequence: ack.lastProcessedInputSequence,
      authoritativePosition: ack.authoritativePosition,
    });
  }

  private onReady(): void {
    setGameHud({ ready: true });
  }

  // --------------------------------------------------------------- movement

  private onDirectionChange(): void {
    const direction = this.input.current();
    this.inputChangedAt = performance.now();
    this.transmitInput(direction);
  }

  private transmitInput(direction: MovementInput): void {
    if (!this.ws.isReady()) return;
    const info = this.ws.getConnectionInfo();
    if (info === null || this.prediction === null) return;
    const sequence = this.prediction.onInput(direction);
    this.ws.send('scene:input', {
      inputStreamId: InputStreamId.parse(info.inputStreamId),
      inputSequence: InputSequence.parse(sequence),
      input: direction,
      clientSentAt: Date.now(),
    });
  }

  // ----------------------------------------------------------------- render

  private tick(frameDtSeconds: number, now: number): void {
    if (this.prediction !== null) this.prediction.advance(frameDtSeconds);

    const renderServerTimeMs = now + this.serverClockOffsetMs;
    const ownPosition = this.prediction?.snapshot().predicted ?? null;

    for (const participantId of this.interpolation.participantIds()) {
      if (participantId === this.ownParticipantId) continue;
      const sampled = this.interpolation.sample(participantId, renderServerTimeMs);
      if (sampled !== null) {
        this.lastRemotePositions.set(participantId, { x: sampled.x, y: sampled.y });
        this.renderer.setPlayer(participantId, sampled, false);
      }
    }
    if (ownPosition !== null && this.ownParticipantId !== null) {
      this.renderer.setPlayer(this.ownParticipantId, ownPosition, true);
      this.renderer.centerOn(ownPosition, { width: this.parent.clientWidth, height: this.parent.clientHeight });
    }

    this.renderer.render();

    if (this.inputChangedAt !== null && ownPosition !== null) {
      this.lastInputToVisualMs = Math.max(0, performance.now() - this.inputChangedAt);
      this.inputChangedAt = null;
    }

    if (now - this.lastHudAt >= HUD_UPDATE_INTERVAL_MS) {
      this.lastHudAt = now;
      this.publishMetrics();
    }
  }

  // --------------------------------------------------------------- helpers

  private newPredictionFromKeyframe(keyframe: SceneKeyframePayload): ClientPrediction {
    const own =
      this.ownParticipantId !== null
        ? keyframe.projection.entities.find((entity) => entity.participantId === this.ownParticipantId)
        : undefined;
    const start = keyframe.ownActorState?.position ?? own?.position ?? { x: 0.5, y: 0.5 };
    const prediction = new ClientPrediction(start, {
      speedCellsPerSecond: PROTOTYPE_SPEED_CELLS_PER_SECOND,
      fixedDtSeconds: PROTOTYPE_FIXED_DT_SECONDS,
    });
    if (keyframe.lastProcessedInputSequence !== undefined) {
      prediction.reconcile({
        lastProcessedInputSequence: keyframe.lastProcessedInputSequence,
        authoritativePosition: start,
      });
    }
    return prediction;
  }

  private applyProjection(entities: readonly PlayerSceneEntity[], simulationTick: number, serverTimeMs: number): void {
    for (const entity of entities) {
      if (entity.participantId === this.ownParticipantId) continue;
      this.interpolation.add(entity.participantId, {
        simulationTick,
        serverTimeMs,
        position: entity.position,
        velocity: entity.velocity,
      });
    }
  }

  private syncServerClock(serverTimeMs: number): void {
    this.serverClockOffsetMs = serverTimeMs - performance.now();
  }

  private setReady(playerCount: number): void {
    setGameHud({
      ready: true,
      myParticipantId: this.ownParticipantId,
      playerCount,
    });
  }

  private publishMetrics(): void {
    const predictionSnapshot = this.prediction?.snapshot() ?? null;
    const metrics: DebugMetrics = {
      fps: this.lastFrameTimeMs > 0 ? Math.round(1000 / this.lastFrameTimeMs) : 0,
      frameTimeMs: this.lastFrameTimeMs > 0 ? Number(this.lastFrameTimeMs.toFixed(2)) : 0,
      inputToVisualMs: Number(this.lastInputToVisualMs.toFixed(2)),
      rttMs: this.ws.getConnectionInfo()?.lastRttMs ?? null,
      ready: this.ws.isReady(),
      myParticipantId: this.ownParticipantId,
      playerCount: this.interpolation.participantIds().length + (this.ownParticipantId !== null ? 1 : 0),
      ownX: predictionSnapshot !== null ? Number(predictionSnapshot.predicted.x.toFixed(4)) : 0,
      ownY: predictionSnapshot !== null ? Number(predictionSnapshot.predicted.y.toFixed(4)) : 0,
      authoritativeX: predictionSnapshot !== null ? Number(predictionSnapshot.authoritative.x.toFixed(4)) : 0,
      authoritativeY: predictionSnapshot !== null ? Number(predictionSnapshot.authoritative.y.toFixed(4)) : 0,
      doorPortalState: this.doorPortalState,
      remotes: [...this.lastRemotePositions.entries()].map(([participantId, position]) => ({
        participantId,
        x: Number(position.x.toFixed(4)),
        y: Number(position.y.toFixed(4)),
      })),
    };
    setGameHud(metrics);
    (window as unknown as { __MNEMOSIN__?: DebugMetrics }).__MNEMOSIN__ = metrics;
  }
}
