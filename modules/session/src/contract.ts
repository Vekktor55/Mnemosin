import { z } from 'zod';
import {
  CharacterId,
  IdempotencyKey,
  PlayerId,
  SessionId,
  SessionStatus,
  TurnId,
  defineModule,
} from '@mnemosin/contracts';

/**
 * Контракт модуля session (v3 §IV.3; промпт 1.9, п.8 — декларация для реестра).
 *
 * Реализация команд этапа 1 — доменный сервис core/SessionService (промпт 1.6):
 * лобби/партия — домен, а не прикладной модуль (D224). Контракт декларирует
 * владельца событий и поверхность команд для modules-registry и транспорта
 * (1.10 вызывает SessionService через wiring apps/server).
 */

const TraceId = z.string().min(1).max(64).optional();

export const CreateSessionInputSchema = z.object({
  title: z.string().min(1).max(120),
  gmDisplayName: z.string().min(1).max(60),
  characterName: z.string().min(1).max(60).optional(), // D157
  idempotencyKey: IdempotencyKey,
  traceId: TraceId,
});
export type CreateSessionInput = z.infer<typeof CreateSessionInputSchema>;

export const CreateSessionOutputSchema = z.object({
  sessionId: SessionId,
  gmPlayerId: PlayerId,
  gmCharacterId: CharacterId,
  status: SessionStatus,
  replayed: z.boolean(),
});
export type CreateSessionOutput = z.infer<typeof CreateSessionOutputSchema>;

export const JoinSessionInputSchema = z.object({
  sessionId: SessionId,
  displayName: z.string().min(1).max(60),
  characterName: z.string().min(1).max(60).optional(), // D157: имя задаёт игрок
  idempotencyKey: IdempotencyKey,
  traceId: TraceId,
});
export type JoinSessionInput = z.infer<typeof JoinSessionInputSchema>;

export const JoinSessionOutputSchema = z.object({
  sessionId: SessionId,
  playerId: PlayerId,
  characterId: CharacterId,
  displayName: z.string().min(1).max(60),
  replayed: z.boolean(),
});
export type JoinSessionOutput = z.infer<typeof JoinSessionOutputSchema>;

export const LeaveSessionInputSchema = z.object({
  sessionId: SessionId,
  playerId: PlayerId,
  idempotencyKey: IdempotencyKey,
  traceId: TraceId,
});
export type LeaveSessionInput = z.infer<typeof LeaveSessionInputSchema>;

export const StartSessionInputSchema = z.object({
  sessionId: SessionId,
  idempotencyKey: IdempotencyKey,
  traceId: TraceId,
});
export type StartSessionInput = z.infer<typeof StartSessionInputSchema>;

export const StartSessionOutputSchema = z.object({
  sessionId: SessionId,
  status: SessionStatus,
  turnId: TurnId,
  turnNumber: z.number().int().nonnegative(),
  replayed: z.boolean(),
});
export type StartSessionOutput = z.infer<typeof StartSessionOutputSchema>;

export const CreateCharacterInputSchema = z.object({
  sessionId: SessionId,
  name: z.string().min(1).max(60),
  archetype: z.string().max(60).nullish(),
  idempotencyKey: IdempotencyKey,
  traceId: TraceId,
});
export type CreateCharacterInput = z.infer<typeof CreateCharacterInputSchema>;

export const sessionContract = defineModule({
  moduleId: 'session',
  purpose:
    'Сессия и лобби: создание партии, вход/выход игроков, персонажи, старт (v3 §IV.3; реализация — core/SessionService, промпт 1.6)',
  version: '0.1.0',
  commands: {
    createSession: { input: CreateSessionInputSchema, output: CreateSessionOutputSchema },
    joinSession: { input: JoinSessionInputSchema, output: JoinSessionOutputSchema },
    leaveSession: { input: LeaveSessionInputSchema, output: z.object({ playerId: PlayerId, replayed: z.boolean() }) },
    startSession: { input: StartSessionInputSchema, output: StartSessionOutputSchema },
    createCharacter: {
      input: CreateCharacterInputSchema,
      output: z.object({ characterId: CharacterId, replayed: z.boolean() }),
    },
  },
  queries: {},
  idempotentCommands: ['createSession', 'joinSession', 'leaveSession', 'startSession', 'createCharacter'],
  // PLAYER_DISCONNECTED физически эмитит ws-gateway (1.11) от имени модуля;
  // EVENT_REGISTERED — world-pack этап 2 (2.4).
  emits: [
    'SESSION_CREATED',
    'SESSION_STATUS_CHANGED',
    'SESSION_ENDED',
    'PLAYER_JOINED',
    'PLAYER_LEFT',
    'PLAYER_DISCONNECTED',
    'EVENT_REGISTERED',
  ],
  subscribes: [],
  ports: [],
  dependencies: [],
  capabilities: [],
});
