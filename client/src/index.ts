/**
 * @mnemosin/client — публичная поверхность пакета (P05-B realtime client).
 *
 * Экспорты нужны unit-тестам (backoff, ws-client, чистые модули движения) и
 * проверяются architecture-тестами (инвариант 15: только @mnemosin/contracts +
 * svelte* + zod + pixi.js).
 */
export const PACKAGE_ID = '@mnemosin/client';
export const IMPLEMENTED_IN_PROMPT = 'P05-B';

export * from './net/backoff.js';
export { WSClient, wsSubprotocol, IDLE_SNAPSHOT } from './net/ws-client.js';
export type { ConnectionSnapshot, ConnectionStatus, WSClientOptions, ConnectionInfo } from './net/ws-client.js';
export { describeError, CLIENT_ACTION_HINT, ruleRejectReason } from './lib/errors.js';
export { newIdempotencyKey, newRequestId, newMessageId } from './lib/ids.js';
export {
  escapeHtml,
  setTextSafe,
  saveIdentity,
  loadIdentity,
  clearIdentity,
  purgeTokensFromLocalStorage,
} from './lib/privacy.js';
export type { ClientIdentity, ClientRole } from './lib/privacy.js';

// --- P05-B: чистые клиентские модули (node-тестируемы, без PixiJS)
export { GridProjection, depthKey } from './game-world/projection/GridProjection.js';
export type {
  GridProjectionConfig,
  ScreenPoint,
  WorldPoint,
  GridCell,
} from './game-world/projection/GridProjection.js';
export { normalizeDirection, directionFromKeys, KeyboardInputController } from './game-world/movement/input.js';
export { ClientPrediction } from './game-world/movement/prediction.js';
export type {
  ClientPredictionConfig,
  UnackedInput,
  PredictionReconcile,
  PredictionSnapshot,
} from './game-world/movement/prediction.js';
export { InterpolationBuffer } from './game-world/movement/interpolation.js';
export type { RemoteSnapshot, InterpolationConfig } from './game-world/movement/interpolation.js';
export { parseNetworkProfile, oneWayDelayMs, shouldDrop } from './game-world/net/profile.js';
export type { NetworkProfile } from './game-world/net/profile.js';
