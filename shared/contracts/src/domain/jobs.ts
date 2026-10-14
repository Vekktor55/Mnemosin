import { z } from 'zod';
import { IsoDateTime } from '../time.js';
import { ErrorCode } from '../errors.js';
import { IdempotencyKey, MediaJobId, SessionId, TurnId } from '../ids.js';
import { VisualSceneDescriptionSchema } from './visual.js';

/**
 * Идемпотентность (v3 §III.2 + патч аудита §8.3, блокер B-08).
 *
 * Отклонения от v3:
 *  - `command` — не enum из 3 значений, а union всех мутирующих команд
 *    (в v3 enum не вмещал lockTurn/retryAI/activateEvent/moveGroup);
 *  - добавлен `resultJson`: повтор команды обязан вернуть клиенту ТОТ ЖЕ ответ
 *    (например `{version}`), а не хэш;
 *  - добавлены `errorCode` и `traceId` для ветки `failed_before`.
 */

export const CommandName = z.enum([
  'openTurn',
  'lockTurn',
  'unlockTurn',
  'cancelTurn',
  'resolveTurn',
  'commitTurn',
  'rejectTurn',
  'retryTurn',
  'editAndApprove',
  'submitAction',
  'moveGroup',
  'activateEvent',
  'forceApplyDeferred',
  'pauseSession',
  'resumeSession',
  'endSession',
  'startSession',
  'kickPlayer',
  'requestScene',
  'cancelMediaJob',
  'setFlag',
  'setNameRemembered',
  'importSession',
  // contracts 0.4.0 (промпт 1.6, D218): union обязан покрывать ВСЕ мутирующие команды
  // (комментарий выше). Сервисы сессий 1.6 добавили четыре команды, которых не хватало.
  'createSession',
  'joinSession',
  'leaveSession',
  'createCharacter',
]);
export type CommandName = z.infer<typeof CommandName>;

export const IdempotencyStatus = z.enum(['IN_FLIGHT', 'DONE', 'FAILED']);
export type IdempotencyStatus = z.infer<typeof IdempotencyStatus>;

export const IdempotencyRecordSchema = z.object({
  key: IdempotencyKey,
  turnId: TurnId.nullable(),
  sessionId: SessionId.nullable(),
  command: CommandName,
  status: IdempotencyStatus,
  /** Полный ответ команды — возвращается при повторе (B-08.4). */
  resultJson: z.string().nullable(),
  resultHash: z.string().length(64),
  errorCode: ErrorCode.nullable(),
  traceId: z.string().max(64),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type IdempotencyRecord = z.infer<typeof IdempotencyRecordSchema>;

export type IdempotencyAcquire =
  | { kind: 'proceed' }
  | { kind: 'cached'; resultJson: string }
  | { kind: 'in_flight' }
  | { kind: 'failed_before'; errorCode: ErrorCode };

/**
 * Media job (v3 §IV.6 + F-1.11/F-7.9: схема и статус QUEUED отсутствовали).
 */
export const MediaJobStatus = z.enum(['QUEUED', 'SUBMITTED', 'READY', 'FAILED', 'CANCELLED']);
export type MediaJobStatus = z.infer<typeof MediaJobStatus>;

export const MediaJobSchema = z.object({
  mediaJobId: MediaJobId,
  sessionId: SessionId,
  turnId: TurnId.nullable(),
  status: MediaJobStatus,
  providerId: z.string().max(64).nullable(),
  externalJobId: z.string().max(120).nullable(),
  scene: VisualSceneDescriptionSchema.nullable(),
  prompt: z.string().max(4000).nullable(),
  negativePrompt: z.string().max(2000).nullable(),
  promptHash: z.string().length(64).nullable(),
  workflow: z.string().max(120).nullable(),
  seed: z.number().int().nullable(),
  url: z.string().max(500).nullable(),
  errorCode: ErrorCode.nullable(),
  attempts: z.number().int().nonnegative().default(0),
  fromCache: z.boolean().default(false),
  queuedAt: IsoDateTime,
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
});
export type MediaJob = z.infer<typeof MediaJobSchema>;

/**
 * Audio job (этап 3, промпт 3.7) — объявлен сейчас, чтобы добавление модуля
 * Audio Director не меняло контракты (критерий A3.5).
 */
export const AudioJobStatus = z.enum(['QUEUED', 'SUBMITTED', 'READY', 'FAILED', 'CANCELLED']);
export type AudioJobStatus = z.infer<typeof AudioJobStatus>;

export const AudioJobSchema = z.object({
  audioJobId: z.string().uuid(),
  sessionId: SessionId,
  turnId: TurnId.nullable(),
  status: AudioJobStatus,
  providerId: z.string().max(64).nullable(),
  externalJobId: z.string().max(120).nullable(),
  text: z.string().max(4000),
  textHash: z.string().length(64).nullable(),
  voice: z.string().max(60).nullable(),
  url: z.string().max(500).nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  errorCode: ErrorCode.nullable(),
  attempts: z.number().int().nonnegative().default(0),
  queuedAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
});
export type AudioJob = z.infer<typeof AudioJobSchema>;
