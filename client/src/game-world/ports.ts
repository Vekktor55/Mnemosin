/**
 * Порты GameWorld (P05-B): структурные интерфейсы вместо прямых зависимостей.
 *
 * Зачем: lifecycle-сцену («подписка на keyframe ДО connect», «буферизация до
 * завершения renderer.init()») нужно проверять unit-тестом без браузера,
 * PixiJS и реального WebSocket. Продакшн-реализации портов:
 * WSClient (net/ws-client.ts), PixiRenderer (pixi/PixiRenderer.ts),
 * KeyboardInputController (movement/input.ts) и глобальный requestAnimationFrame.
 *
 * Инвариант 15: клиент зависит только от @mnemosin/contracts и своих модулей.
 */
import type { MovementInput, SceneObject, SceneResyncMessage } from '@mnemosin/contracts';

import type { BlurTargetLike, EventTargetLike, VisibilityTargetLike } from './movement/input.js';
import type { WorldPoint } from './projection/GridProjection.js';
import type { WsClientMessageType, WsServerMessageType } from '@mnemosin/contracts';
import type { WsClientPayload, WsServerMessage } from '../net/ws-client.js';

/** Причина resync — строго перечисление Zod-схемы `scene:resync`. */
export type GameWorldResyncReason = SceneResyncMessage['reason'];

export interface GameWorldConnectionInfo {
  readonly actorId: string;
  readonly inputStreamId: string;
  readonly lastRttMs: number | null;
  readonly lastSceneSequence: number | null;
  readonly worldEpoch: number | null;
}

/** Контейнер canvas: достаточно размеров, чтобы центрировать камеру. */
export interface GameWorldCanvasHost {
  readonly clientWidth: number;
  readonly clientHeight: number;
}

export interface GameWorldWsPort {
  on<T extends WsServerMessageType>(type: T, handler: (message: WsServerMessage<T>) => void): () => void;
  send<T extends WsClientMessageType>(type: T, payload: WsClientPayload<T>): void;
  isReady(): boolean;
  getConnectionInfo(): GameWorldConnectionInfo | null;
  /**
   * §17.4: запрос полного keyframe. `lastAppliedSceneSequence` — последняя
   * ПРИМЕНЁННАЯ клиентом sequence (не последняя полученная), чтобы сервер
   * знал фактическую точку восстановления.
   */
  requestResync(reason: GameWorldResyncReason, options?: { readonly lastAppliedSceneSequence?: number | null }): void;
  /**
   * §4.2 шаг 7: `connection:client-ready` — клиент зарегистрировал handlers и
   * готов принять keyframe. Отправляется один раз на connection lifecycle.
   */
  sendClientReady(): boolean;
}

export interface GameWorldRendererPort {
  init(parent: GameWorldCanvasHost): Promise<void>;
  setSceneObjects(objects: readonly SceneObject[]): void;
  setPlayer(participantId: string, position: WorldPoint, own: boolean): void;
  removePlayer(participantId: string): void;
  clearPlayers(): void;
  centerOn(position: WorldPoint, viewport: { width: number; height: number }): void;
  render(): void;
  destroy(): void;
}

export interface GameWorldFrameScheduler {
  request(callback: (now: number) => void): number;
  cancel(handle: number): void;
}

export interface GameWorldInputPort {
  attach(target: EventTargetLike, windowTarget: BlurTargetLike, visibilityTarget: VisibilityTargetLike): void;
  detach(): void;
  setOnChange(listener: (() => void) | null): void;
  current(): MovementInput;
}
