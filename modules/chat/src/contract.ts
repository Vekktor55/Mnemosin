import { z } from 'zod';
import {
  ChatVisibility,
  IdempotencyKey,
  IsoDateTime,
  MessageId,
  PlayerId,
  SessionId,
  TurnId,
  defineModule,
} from '@mnemosin/contracts';
import { ChatMessageViewSchema } from '@mnemosin/contracts';

/**
 * Контракт модуля chat (v3 §IV.7 + исправления; промпт 1.9, п.1).
 *
 * emits: CHAT_MESSAGE_PUBLIC/PRIVATE/SYSTEM/GM (в каталоге с 1.2, F-2.1).
 * subscribes: TURN_COMMITTED (доставка нарратива и приватных сообщений
 * закоммиченного черновика — D238), WORLD_EVENT_FIRED (этап 2), PLAYER_JOINED,
 * PLAYER_LEFT, SESSION_STATUS_CHANGED (системные сообщения ленты).
 *
 * Идемпотентность (at-least-once, D113): обработчики событий используют
 * ДЕТЕРМИНИРОВАННЫЕ messageId (sha256-сид от turnId/segmentId/noteId/traceId) —
 * повторная доставка упирается в существующую запись и пропускается.
 * Клиентские вызовы (транспорт 1.11) дедуплицируются по requestId (dedupeTtlMs)
 * и/или опциональному idempotencyKey.
 */

const TraceId = z.string().min(1).max(64).optional();

export const SendPublicMessageInputSchema = z.object({
  sessionId: SessionId,
  playerId: PlayerId,
  text: z.string(),
  turnId: TurnId.nullish(),
  /** Опциональный детерминированный id — повтор с тем же id не создаёт копию. */
  messageId: MessageId.optional(),
  idempotencyKey: IdempotencyKey.optional(),
  traceId: TraceId,
});
export type SendPublicMessageInput = z.infer<typeof SendPublicMessageInputSchema>;

export const SendPrivateMessageInputSchema = z.object({
  sessionId: SessionId,
  fromPlayerId: PlayerId,
  toPlayerId: PlayerId,
  text: z.string(),
  turnId: TurnId.nullish(),
  messageId: MessageId.optional(),
  idempotencyKey: IdempotencyKey.optional(),
  traceId: TraceId,
});
export type SendPrivateMessageInput = z.infer<typeof SendPrivateMessageInputSchema>;

export const SendSystemMessageInputSchema = z.object({
  sessionId: SessionId,
  text: z.string(),
  turnId: TurnId.nullish(),
  messageId: MessageId.optional(),
  traceId: TraceId,
});
export type SendSystemMessageInput = z.infer<typeof SendSystemMessageInputSchema>;

export const SendGMMessageInputSchema = z.object({
  sessionId: SessionId,
  gmPlayerId: PlayerId,
  text: z.string(),
  turnId: TurnId.nullish(),
  messageId: MessageId.optional(),
  traceId: TraceId,
});
export type SendGMMessageInput = z.infer<typeof SendGMMessageInputSchema>;

export const SendMessageOutputSchema = z.object({
  messageId: MessageId,
  /** Порядковый номер в ленте сессии (1-based) на момент записи. */
  sequenceId: z.number().int().nonnegative(),
  /** true — сообщение с таким messageId уже существовало (повторная доставка). */
  replayed: z.boolean(),
});
export type SendMessageOutput = z.infer<typeof SendMessageOutputSchema>;

export const HistoryInputSchema = z.object({
  sessionId: SessionId,
  since: IsoDateTime.optional(),
  visibility: ChatVisibility.optional(),
  /** Для PRIVATE обязателен: лента приватного — только from/to этого игрока (A1.10). */
  playerId: PlayerId.optional(),
  limit: z.number().int().positive().max(500).default(200),
});
export type HistoryInput = z.infer<typeof HistoryInputSchema>;

export const HistoryOutputSchema = z.array(ChatMessageViewSchema);
export type HistoryOutput = z.infer<typeof HistoryOutputSchema>;

/** D271 (промпт 1.11): построение view одного сообщения для доставки CHAT_MESSAGE_* по WS. */
export const GetMessageInputSchema = z.object({ messageId: MessageId });
export type GetMessageInput = z.infer<typeof GetMessageInputSchema>;
export const GetMessageOutputSchema = ChatMessageViewSchema.nullable();
export type GetMessageOutput = z.infer<typeof GetMessageOutputSchema>;

export const chatContract = defineModule({
  moduleId: 'chat',
  purpose: 'Чат партии: публичные/приватные/системные/GM-сообщения, sanitize, rate limit, лента истории (v3 §IV.7)',
  version: '0.2.0',
  commands: {
    sendPublicMessage: { input: SendPublicMessageInputSchema, output: SendMessageOutputSchema },
    sendPrivateMessage: { input: SendPrivateMessageInputSchema, output: SendMessageOutputSchema },
    sendSystemMessage: { input: SendSystemMessageInputSchema, output: SendMessageOutputSchema },
    sendGMMessage: { input: SendGMMessageInputSchema, output: SendMessageOutputSchema },
  },
  queries: {
    history: { input: HistoryInputSchema, output: HistoryOutputSchema },
    getMessage: { input: GetMessageInputSchema, output: GetMessageOutputSchema },
  },
  // Ключ от клиента опционален: WS-транспорт дедуплицирует по requestId (1.11),
  // обработчики событий — по детерминированным messageId.
  idempotentCommands: [],
  emits: ['CHAT_MESSAGE_PUBLIC', 'CHAT_MESSAGE_PRIVATE', 'CHAT_MESSAGE_SYSTEM', 'CHAT_MESSAGE_GM'],
  subscribes: ['TURN_COMMITTED', 'WORLD_EVENT_FIRED', 'PLAYER_JOINED', 'PLAYER_LEFT', 'SESSION_STATUS_CHANGED'],
  ports: [],
  dependencies: [],
  capabilities: [],
});
