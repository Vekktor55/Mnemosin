/**
 * @mnemosin/client — публичная поверхность пакета (промпт 1.12).
 *
 * Клиент — приложение (MPA: /player/ и /gm/), а не библиотека: экспорты нужны
 * unit-тестам (backoff, offline-queue) и проверяются architecture-тестами
 * (инвариант 15: только @mnemosin/contracts + svelte* + zod).
 */
export const PACKAGE_ID = '@mnemosin/client';
export const IMPLEMENTED_IN_PROMPT = '1.12';

export * from './net/backoff.js';
export * from './net/offline-queue.js';
export { WSClient, wsSubprotocol, IDLE_SNAPSHOT } from './net/ws-client.js';
export type { ConnectionSnapshot, ConnectionStatus, WSClientOptions } from './net/ws-client.js';
export { describeError, CLIENT_ACTION_HINT, ruleRejectReason } from './lib/errors.js';
export { newIdempotencyKey, newRequestId } from './lib/ids.js';
export {
  escapeHtml,
  setTextSafe,
  saveIdentity,
  loadIdentity,
  clearIdentity,
  purgeTokensFromLocalStorage,
} from './lib/privacy.js';
export type { ClientIdentity, ClientRole } from './lib/privacy.js';
