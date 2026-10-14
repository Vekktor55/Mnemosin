import { z } from 'zod';
import { IsoDateTime } from '../time.js';
import { MessageId, PlayerId, SessionId, TurnId } from '../ids.js';

/**
 * Chat (v3 §IV.7). Схема сообщения в v3 отсутствовала (F-1.7) — определена здесь.
 *
 * `visibility` управляет маршрутизацией: PUBLIC/SYSTEM — broadcast,
 * PRIVATE — только адресату, GM — только GM (матрица приватности, патч §8.4).
 */

export const ChatVisibility = z.enum(['PUBLIC', 'PRIVATE', 'SYSTEM', 'GM']);
export type ChatVisibility = z.infer<typeof ChatVisibility>;

export const ChatMessageSchema = z
  .object({
    messageId: MessageId,
    sessionId: SessionId,
    turnId: TurnId.nullable(),
    visibility: ChatVisibility,
    fromPlayerId: PlayerId.nullable(),
    toPlayerId: PlayerId.nullable(),
    /** Имя отправителя для бейджа (D157: игрок видит имя всегда). */
    fromDisplayName: z.string().max(60).nullable(),
    text: z.string().min(1).max(4000),
    createdAt: IsoDateTime,
  })
  .superRefine((msg, ctx) => {
    if (msg.visibility === 'PRIVATE' && msg.toPlayerId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toPlayerId'],
        message: 'PRIVATE сообщение требует toPlayerId',
      });
    }
    if (msg.visibility === 'PUBLIC' && msg.fromPlayerId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fromPlayerId'],
        message: 'PUBLIC сообщение требует fromPlayerId',
      });
    }
  });
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
