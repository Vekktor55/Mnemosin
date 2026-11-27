/**
 * Конверты и HOT↔COLD-схемы v4.
 *
 * WS-конверты живут в `transport/realtime.ts`, а HOT↔COLD-контракты — в
 * `transport/hot-event.ts` (общий модуль для `realtime.ts` и Core, чтобы не
 * было циклического импорта `realtime` ↔ `envelope`).
 */
export {
  WsClientEnvelopeSchema as WSClientMessageSchema,
  WsServerEnvelopeSchema as WSServerMessageSchema,
  WS_CLIENT_MESSAGE_TYPES as WS_CLIENT_TYPES,
  WS_SERVER_MESSAGE_TYPES as WS_SERVER_TYPES,
  WsClientPayloadSchemas as WSClientPayloadSchemas,
  WsServerPayloadSchemas as WSServerPayloadSchemas,
  type WsClientMessageType as WSClientMessageType,
  type WsServerMessageType as WSServerMessageType,
} from './realtime.js';
export {
  SceneDeltaPayloadSchema,
  SceneKeyframePayloadSchema,
  type SceneDeltaPayload,
  type SceneKeyframePayload,
} from './scene.js';
export {
  HotGameplayEventPayloadSchemas,
  HotGameplayEventEnvelopeSchema,
  HotGameplayEventAckSchema,
  HotGameplayJournalPayloadSchema,
  ColdToHotCommandSchema,
  ColdToHotJournalPayloadSchema,
  HOT_GAMEPLAY_EVENT_TYPES,
  type HotGameplayEventType,
  type HotGameplayEventEnvelope,
  type HotGameplayEventOf,
  type HotGameplayEventAck,
  type HotGameplayJournalPayload,
  type ColdToHotCommand,
  type ColdToHotJournalPayload,
} from './hot-event.js';
