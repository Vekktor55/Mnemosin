/**
 * @mnemosin/module-chat — чат партии (промпт 1.9, критерий A1.10).
 *
 *  - contract.ts — ModuleContract: sendPublicMessage/sendPrivateMessage/
 *    sendSystemMessage/sendGMMessage + history; emits CHAT_MESSAGE_*;
 *    subscribes TURN_COMMITTED (доставка черновика, D238), WORLD_EVENT_FIRED
 *    (этап 2), PLAYER_JOINED/PLAYER_LEFT/SESSION_STATUS_CHANGED (лента);
 *  - service.ts — ChatService: sanitize + token bucket (RATE_LIMIT) + запись
 *    в chat_messages + outbox-события одной транзакцией; идемпотентные
 *    обработчики событий на детерминированных messageId;
 *  - sanitize.ts — trim, нормализация \n, лимит maxMessageLen, отказ
 *    управляющих символов;
 *  - rate-limit.ts — TokenBucketLimiter (chat.publicPerSecond из limits.yaml).
 */
export {
  chatContract,
  SendPublicMessageInputSchema,
  SendPrivateMessageInputSchema,
  SendSystemMessageInputSchema,
  SendGMMessageInputSchema,
  SendMessageOutputSchema,
  HistoryInputSchema,
  HistoryOutputSchema,
  GetMessageInputSchema,
  GetMessageOutputSchema,
  type GetMessageInput,
  type GetMessageOutput,
  type SendPublicMessageInput,
  type SendPrivateMessageInput,
  type SendSystemMessageInput,
  type SendGMMessageInput,
  type SendMessageOutput,
  type HistoryInput,
  type HistoryOutput,
} from './contract.js';
export {
  ChatService,
  deterministicMessageId,
  toChatMessageView,
  type ChatLimits,
  type ChatLog,
  type ChatServiceDeps,
} from './service.js';
export { sanitizeChatText } from './sanitize.js';
export { TokenBucketLimiter } from './rate-limit.js';

export const PACKAGE_ID = '@mnemosin/module-chat';
export const IMPLEMENTED_IN_PROMPT = '1.9';
