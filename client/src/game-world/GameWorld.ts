/**
 * GameWorld — оркестратор realtime-клиента P05-B.
 *
 * Связывает WSClient (v4), KeyboardInputController, ClientPrediction,
 * InterpolationBuffer и PixiRenderer. Рендер-цикл независим от WebSocket
 * (requestAnimationFrame), input sampling — каждый кадр, отправка — ~20 Гц.
 *
 * Авторитетная позиция принадлежит серверу: prediction/advance меняют только
 * отображаемую позицию; authoritative обновляется лишь из ACK/keyframe/delta.
 *
 * LIFECYCLE (NETWORK_PROTOCOL.md §4.2, шаг 7):
 *   `attach()` — подписка на WS-события ДО `ws.connect()`; обработчики должны
 *   быть зарегистрированы до того, как клиент сообщит `connection:client-ready`.
 *   `start()`  — асинхронная инициализация renderer; keyframe, пришедший до её
 *   завершения, буферизуется и применяется сразу после `renderer.init()`.
 *
 * Сервер присылает `scene:keyframe` строго перед `connection:ready`
 * (gateways/ws/src/router.ts), поэтому единственный способ потерять keyframe —
 * отправить `connection:client-ready` раньше, чем клиент готов его принять.
 * Именно это и устранено: `connection:client-ready` уходит из `markClientReady()`
 * после подписки и готовности renderer.
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

import { KeyboardInputController } from './movement/input.js';
import { ClientPrediction } from './movement/prediction.js';
import { InterpolationBuffer } from './movement/interpolation.js';
import type {
  GameWorldCanvasHost,
  GameWorldFrameScheduler,
  GameWorldInputPort,
  GameWorldRendererPort,
  GameWorldResyncReason,
  GameWorldWsPort,
} from './ports.js';
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
/**
 * PROTOTYPE-ONLY: cooldown между `scene:resync`-запросами (§9.3, §17.4).
 * Не даёт спамить сокет, пока сервер готовит keyframe.
 */
const RESYNC_COOLDOWN_MS = 1_000;

export interface GameWorldOptions {
  readonly ws: GameWorldWsPort;
  readonly parent: GameWorldCanvasHost;
  readonly renderer: GameWorldRendererPort;
  readonly frameScheduler?: GameWorldFrameScheduler;
  readonly input?: GameWorldInputPort;
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
  private readonly ws: GameWorldWsPort;
  private readonly parent: GameWorldCanvasHost;
  private readonly renderer: GameWorldRendererPort;
  private readonly frameScheduler: GameWorldFrameScheduler;
  private readonly input: GameWorldInputPort;
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

  /** Unsubscribe-хэндлы всех ws.on(...): снимаются в destroy() (без утечек). */
  private readonly unsubscribes: (() => void)[] = [];
  private attached = false;
  private rendererReady = false;
  private hasAppliedKeyframe = false;
  private pendingKeyframe: SceneKeyframePayload | null = null;
  /** Последняя ПРИМЕНЁННАЯ клиентом scene sequence (§9.4). */
  private lastAppliedSceneSequence: number | null = null;
  private welcomeReceived = false;
  private clientReadySent = false;
  private resyncRequested = false;
  private lastResyncRequestAt: number | null = null;

  constructor(options: GameWorldOptions) {
    this.ws = options.ws;
    this.parent = options.parent;
    this.renderer = options.renderer;
    this.frameScheduler = options.frameScheduler ?? defaultFrameScheduler;
    this.input = options.input ?? new KeyboardInputController();
    this.interpolation = new InterpolationBuffer({
      interpolationDelayMs: PROTOTYPE_INTERPOLATION_DELAY_MS,
      extrapolationLimitMs: PROTOTYPE_EXTRAPOLATION_LIMIT_MS,
      maxBufferSize: PROTOTYPE_INTERPOLATION_BUFFER_SIZE,
    });
  }

  /**
   * Подписка на WS-события. Вызывается ДО `ws.connect()`: обработчики должны
   * существовать раньше, чем клиент отправит `connection:client-ready`.
   */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.unsubscribes.push(
      this.ws.on('connection:welcome', (message) => this.onWelcome(message.payload)),
      this.ws.on('scene:keyframe', (message) => this.onKeyframe(message.payload)),
      this.ws.on('scene:delta', (message) => this.onDelta(message.payload)),
      this.ws.on('connection:ready', () => this.onReady()),
      this.ws.on('scene:resync-required', () => this.onResyncRequired()),
      this.ws.on('scene:input-ack', (message) => this.onInputAck(message.payload)),
    );
    this.input.setOnChange(() => this.onDirectionChange());
    const targets = browserEventTargets();
    if (targets !== null) {
      this.input.attach(targets.target, targets.windowTarget, targets.visibilityTarget);
    }
  }

  /**
   * Асинхронная инициализация renderer. Keyframe, пришедший до её завершения,
   * буферизуется и применяется сразу после `renderer.init()`.
   */
  async start(): Promise<void> {
    // Идемпотентно: подписка должна существовать до любого входящего кадра.
    this.attach();
    await this.renderer.init(this.parent);
    this.rendererReady = true;
    this.flushPendingKeyframe();
    this.markClientReady();

    this.inputSendTimer = setInterval(() => {
      const direction = this.input.current();
      if (direction.directionX !== 0 || direction.directionY !== 0) this.transmitInput(direction);
    }, INPUT_SEND_INTERVAL_MS);

    this.lastFrameAt = performance.now();
    this.lastHudAt = this.lastFrameAt;
    const loop = (now: number): void => {
      this.frameHandle = this.frameScheduler.request(loop);
      const frameDt = Math.min((now - this.lastFrameAt) / 1000, MAX_FRAME_DT_SECONDS);
      this.lastFrameTimeMs = now - this.lastFrameAt;
      this.lastFrameAt = now;
      this.tick(frameDt, now);
    };
    this.frameHandle = this.frameScheduler.request(loop);
  }

  destroy(): void {
    if (this.frameHandle !== null) this.frameScheduler.cancel(this.frameHandle);
    this.frameHandle = null;
    if (this.inputSendTimer !== null) clearInterval(this.inputSendTimer);
    this.inputSendTimer = null;
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
    this.attached = false;
    this.input.setOnChange(null);
    this.input.detach();
    this.renderer.destroy();
  }

  // ------------------------------------------------------------ ws handlers

  /** Новый connection lifecycle: сбрасываем scene-состояние (§4.4, §12). */
  private onWelcome(payload: { readonly connectionEpoch: number; readonly actorId: string }): void {
    this.welcomeReceived = true;
    this.clientReadySent = false;
    this.hasAppliedKeyframe = false;
    this.pendingKeyframe = null;
    this.lastAppliedSceneSequence = null;
    this.resyncRequested = false;
    this.lastResyncRequestAt = null;
    this.ownParticipantId = payload.actorId;
    this.doorPortalState = null;
    this.interpolation.reset();
    this.lastRemotePositions.clear();
    this.prediction = null;
    this.renderer.clearPlayers();
    // Если renderer уже готов (welcome пришёл после init) — client-ready уходит сразу.
    this.markClientReady();
  }

  private onKeyframe(keyframe: SceneKeyframePayload): void {
    if (!this.rendererReady) {
      // Renderer ещё инициализируется: keyframe не теряем, а откладываем.
      this.pendingKeyframe = keyframe;
      return;
    }
    this.applyKeyframe(keyframe);
  }

  private applyKeyframe(keyframe: SceneKeyframePayload): void {
    this.ownParticipantId = this.ws.getConnectionInfo()?.actorId ?? this.ownParticipantId;
    this.interpolation.reset();
    this.prediction = this.newPredictionFromKeyframe(keyframe);
    this.applyProjection(keyframe.projection.entities, keyframe.simulationTick, keyframe.serverTimeMs);
    this.renderer.setSceneObjects(keyframe.projection.objects);
    this.doorPortalState =
      keyframe.projection.objects.find((object) => object.portalState !== undefined)?.portalState ?? null;
    this.syncServerClock(keyframe.serverTimeMs);
    this.lastAppliedSceneSequence = keyframe.sceneSequence;
    this.hasAppliedKeyframe = true;
    this.pendingKeyframe = null;
    this.resyncRequested = false;
    this.setReady(keyframe.projection.entities.length);
  }

  private onDelta(delta: SceneDeltaPayload): void {
    if (!this.hasAppliedKeyframe) {
      // §9.3: клиент не пытается самостоятельно восстановить пропущенные
      // изменения — запрашивает полный keyframe. Причина — client_recovery:
      // локального состояния сцены ещё нет.
      this.requestResync('client_recovery');
      return;
    }
    if (delta.baseSceneSequence !== this.lastAppliedSceneSequence) {
      // §9.3: разрыв цепочки baseSceneSequence — полный keyframe.
      this.requestResync('sequence_gap');
      return;
    }
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
    this.lastAppliedSceneSequence = delta.sceneSequence;
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

  private onResyncRequired(): void {
    this.interpolation.reset();
    this.prediction?.reset(this.prediction.snapshot().authoritative);
    this.hasAppliedKeyframe = false;
    this.resyncRequested = false;
    this.lastResyncRequestAt = null;
  }

  // -------------------------------------------------------------- lifecycle

  /** §4.2 шаг 7: `connection:client-ready` после подписки и готовности renderer. */
  private markClientReady(): void {
    if (!this.welcomeReceived || !this.rendererReady || this.clientReadySent) return;
    // Флаг ставится только после успешной отправки: если сокет ещё не открыт,
    // client-ready будет отправлен при следующей попытке.
    if (this.ws.sendClientReady()) this.clientReadySent = true;
  }

  private flushPendingKeyframe(): void {
    const keyframe = this.pendingKeyframe;
    if (keyframe === null) return;
    this.applyKeyframe(keyframe);
  }

  /** Типизированный `scene:resync` с валидным reason и cooldown (§9.3, §17.4). */
  private requestResync(reason: GameWorldResyncReason): void {
    const now = Date.now();
    if (this.lastResyncRequestAt !== null && now - this.lastResyncRequestAt < RESYNC_COOLDOWN_MS) return;
    this.lastResyncRequestAt = now;
    this.resyncRequested = true;
    this.ws.requestResync(reason, { lastAppliedSceneSequence: this.lastAppliedSceneSequence });
  }

  /** Для диагностики: был ли уже запрошен resync (cooldown активен). */
  isResyncRequested(): boolean {
    return this.resyncRequested;
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
    publishDebugMetrics(metrics);
  }
}

const defaultFrameScheduler: GameWorldFrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

function browserEventTargets(): {
  target: Window;
  windowTarget: Window;
  visibilityTarget: Document;
} | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  return { target: window, windowTarget: window, visibilityTarget: document };
}

/**
 * Debug-хук для E2E/ручной диагностики. Без `as unknown as`: тип выводится из
 * объявления глобального augment-контракта.
 */
declare global {
  interface Window {
    __MNEMOSIN__?: DebugMetrics;
  }
}

function publishDebugMetrics(metrics: DebugMetrics): void {
  if (typeof window === 'undefined') return;
  window.__MNEMOSIN__ = metrics;
}
