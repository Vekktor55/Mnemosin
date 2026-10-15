import { z } from 'zod';
import {
  GMNoteVisibility,
  IdempotencyKey,
  JournalEntrySchema,
  NoteId,
  PlayerId,
  SessionId,
  TurnId,
  defineModule,
} from '@mnemosin/contracts';
import { DirectorContextSchema, GMStateViewSchema } from '@mnemosin/contracts';
import { GmAuditEntrySchema } from '@mnemosin/contracts';

/**
 * Контракт модуля gm (v3 §IV.8 + исправления; промпт 1.9, п.4).
 *
 * БЕЗ finishTurn (D119/B-09: REVIEW→COMMITTED владеет gm-review). Добавлено:
 * pauseSession, resumeSession, endSession, moveGroup, sendSystemMessage,
 * activateEvent (этап 2 — заглушка NOT_IMPLEMENTED), inspectState,
 * inspectAIContext, inspectJournal, addNote, listAudit, kickPlayer.
 * Базовые GM-операции жизненного цикла (startSession, openTurn, lockTurn,
 * unlockTurn, cancelTurn) — обёртки над доменными сервисами core (1.6) c
 * аудит-событием; транспорт 1.10 ходит СЮДА, а не в core напрямую.
 *
 * Все мутирующие команды эмитят GM_ACTION_PERFORMED{sessionId, gmPlayerId,
 * action, meta, idempotencyKey} (traceId — в конверте события) через outbox
 * ТОЙ ЖЕ транзакцией, что и основное действие; при replay команда событие
 * НЕ дублирует.
 */

const TraceId = z.string().min(1).max(64).optional();

const SessionCommandBase = z.object({
  sessionId: SessionId,
  gmPlayerId: PlayerId,
  idempotencyKey: IdempotencyKey,
  traceId: TraceId,
});

const TurnCommandBase = z.object({
  turnId: TurnId,
  gmPlayerId: PlayerId,
  idempotencyKey: IdempotencyKey,
  traceId: TraceId,
});

export const StartSessionInputSchema = SessionCommandBase;
export type StartSessionInput = z.infer<typeof StartSessionInputSchema>;
export const StartSessionOutputSchema = z.object({
  sessionId: SessionId,
  turnId: TurnId,
  turnNumber: z.number().int().nonnegative(),
  replayed: z.boolean(),
});
export type StartSessionOutput = z.infer<typeof StartSessionOutputSchema>;

export const PauseSessionInputSchema = SessionCommandBase;
export type PauseSessionInput = z.infer<typeof PauseSessionInputSchema>;
export const SessionStatusOutputSchema = z.object({
  sessionId: SessionId,
  status: z.enum(['LOBBY', 'ACTIVE', 'PAUSED', 'ENDED']),
  replayed: z.boolean(),
});
export type SessionStatusOutput = z.infer<typeof SessionStatusOutputSchema>;

export const ResumeSessionInputSchema = SessionCommandBase;
export type ResumeSessionInput = z.infer<typeof ResumeSessionInputSchema>;

export const EndSessionInputSchema = SessionCommandBase.extend({ reason: z.string().min(1).max(200) });
export type EndSessionInput = z.infer<typeof EndSessionInputSchema>;

export const OpenTurnInputSchema = SessionCommandBase;
export type OpenTurnInput = z.infer<typeof OpenTurnInputSchema>;
export const TurnRefOutputSchema = z.object({
  turnId: TurnId,
  sessionId: SessionId,
  number: z.number().int().nonnegative(),
  status: z.enum(['OPEN', 'LOCKED', 'PROCESSING', 'REVIEW', 'COMMITTED', 'FAILED']),
  replayed: z.boolean(),
});
export type TurnRefOutput = z.infer<typeof TurnRefOutputSchema>;

export const LockTurnInputSchema = TurnCommandBase;
export type LockTurnInput = z.infer<typeof LockTurnInputSchema>;
export const UnlockTurnInputSchema = TurnCommandBase;
export type UnlockTurnInput = z.infer<typeof UnlockTurnInputSchema>;
export const CancelTurnInputSchema = TurnCommandBase.extend({ reason: z.string().min(1).max(200) });
export type CancelTurnInput = z.infer<typeof CancelTurnInputSchema>;

export const MoveGroupInputSchema = z.object({
  sessionId: SessionId,
  gmPlayerId: PlayerId,
  playerIds: z.array(PlayerId).min(1).max(12),
  toLocationId: z.string().uuid(),
  turnId: TurnId.nullish(),
  idempotencyKey: IdempotencyKey.optional(), // ядро всё равно считает детерминированный ключ (D217)
  traceId: TraceId,
});
export type MoveGroupInput = z.infer<typeof MoveGroupInputSchema>;
export const MoveGroupOutputSchema = z.object({
  sessionId: SessionId,
  version: z.number().int().nonnegative(),
  replayed: z.boolean(),
});
export type MoveGroupOutput = z.infer<typeof MoveGroupOutputSchema>;

export const KickPlayerInputSchema = z.object({
  sessionId: SessionId,
  gmPlayerId: PlayerId,
  playerId: PlayerId,
  idempotencyKey: IdempotencyKey,
  traceId: TraceId,
});
export type KickPlayerInput = z.infer<typeof KickPlayerInputSchema>;

export const SendSystemMessageInputSchema = z.object({
  sessionId: SessionId,
  gmPlayerId: PlayerId,
  text: z.string().min(1),
  turnId: TurnId.nullish(),
  idempotencyKey: IdempotencyKey,
  traceId: TraceId,
});
export type SendSystemMessageInput = z.infer<typeof SendSystemMessageInputSchema>;
export const SendSystemMessageOutputSchema = z.object({
  messageId: z.string().uuid(),
  replayed: z.boolean(),
});
export type SendSystemMessageOutput = z.infer<typeof SendSystemMessageOutputSchema>;

export const ActivateEventInputSchema = z.object({
  sessionId: SessionId,
  gmPlayerId: PlayerId,
  eventId: z.string().uuid(),
  idempotencyKey: IdempotencyKey,
  traceId: TraceId,
});
export type ActivateEventInput = z.infer<typeof ActivateEventInputSchema>;

export const AddNoteInputSchema = z.object({
  sessionId: SessionId,
  gmPlayerId: PlayerId,
  turnId: TurnId.nullish(),
  visibility: GMNoteVisibility,
  text: z.string().min(1).max(4000),
  idempotencyKey: IdempotencyKey,
  traceId: TraceId,
});
export type AddNoteInput = z.infer<typeof AddNoteInputSchema>;
export const AddNoteOutputSchema = z.object({ noteId: NoteId, replayed: z.boolean() });
export type AddNoteOutput = z.infer<typeof AddNoteOutputSchema>;

// ---------------------------------------------------------------- запросы

export const InspectStateInputSchema = z.object({ sessionId: SessionId });
export type InspectStateInput = z.infer<typeof InspectStateInputSchema>;

export const InspectAIContextInputSchema = z.object({ turnId: TurnId });
export type InspectAIContextInput = z.infer<typeof InspectAIContextInputSchema>;

export const InspectJournalInputSchema = z.object({ turnId: TurnId });
export type InspectJournalInput = z.infer<typeof InspectJournalInputSchema>;

export const ListAuditInputSchema = z.object({
  sessionId: SessionId,
  since: z.string().datetime({ offset: false, precision: 3 }).optional(),
  limit: z.number().int().positive().max(1000).default(200),
});
export type ListAuditInput = z.infer<typeof ListAuditInputSchema>;

// ---------------------------------------------------------------- контракт

export const gmContract = defineModule({
  moduleId: 'gm',
  purpose:
    'Пульт ведущего: жизненный цикл сессии/хода, moveGroup, kick, системные сообщения, заметки, инспекция состояния/контекста/журнала/аудита (v3 §IV.8)',
  version: '0.1.0',
  commands: {
    startSession: { input: StartSessionInputSchema, output: StartSessionOutputSchema },
    pauseSession: { input: PauseSessionInputSchema, output: SessionStatusOutputSchema },
    resumeSession: { input: ResumeSessionInputSchema, output: SessionStatusOutputSchema },
    endSession: { input: EndSessionInputSchema, output: SessionStatusOutputSchema },
    openTurn: { input: OpenTurnInputSchema, output: TurnRefOutputSchema },
    lockTurn: { input: LockTurnInputSchema, output: TurnRefOutputSchema },
    unlockTurn: { input: UnlockTurnInputSchema, output: TurnRefOutputSchema },
    cancelTurn: { input: CancelTurnInputSchema, output: TurnRefOutputSchema },
    moveGroup: { input: MoveGroupInputSchema, output: MoveGroupOutputSchema },
    kickPlayer: { input: KickPlayerInputSchema, output: SessionStatusOutputSchema },
    sendSystemMessage: { input: SendSystemMessageInputSchema, output: SendSystemMessageOutputSchema },
    addNote: { input: AddNoteInputSchema, output: AddNoteOutputSchema },
    activateEvent: { input: ActivateEventInputSchema, output: z.object({ ok: z.literal(true) }) },
  },
  queries: {
    inspectState: { input: InspectStateInputSchema, output: GMStateViewSchema },
    inspectAIContext: { input: InspectAIContextInputSchema, output: DirectorContextSchema },
    inspectJournal: { input: InspectJournalInputSchema, output: z.array(JournalEntrySchema) },
    listAudit: { input: ListAuditInputSchema, output: z.array(GmAuditEntrySchema) },
  },
  idempotentCommands: [
    'startSession',
    'pauseSession',
    'resumeSession',
    'endSession',
    'openTurn',
    'lockTurn',
    'unlockTurn',
    'cancelTurn',
    'moveGroup',
    'kickPlayer',
    'sendSystemMessage',
    'addNote',
    'activateEvent',
  ],
  // LOCATION_CHANGED декларативно принадлежит gm (EVENT_EMITTERS); физически
  // пишет core/LocationService.moveGroup — обёртка gm вызывает её (D249-образец).
  emits: ['GM_ACTION_PERFORMED', 'GM_NOTE_ADDED', 'LOCATION_CHANGED'],
  subscribes: ['TURN_COMMITTED'], // публикация заметок PUBLIC_AFTER_COMMIT (F-3.8; D245)
  ports: [],
  dependencies: [],
  capabilities: [],
});
