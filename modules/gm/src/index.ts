/**
 * @mnemosin/module-gm — пульт ведущего (промпт 1.9, п.4–6; критерий A1.15).
 *
 *  - contract.ts — ModuleContract БЕЗ finishTurn (D119/B-09): жизненный цикл
 *    сессии/хода, moveGroup, kickPlayer, sendSystemMessage, addNote,
 *    activateEvent (заглушка NOT_IMPLEMENTED до 2.1) + инспекция
 *    (inspectState/inspectAIContext/inspectJournal/listAudit);
 *  - service.ts — обёртки доменных сервисов core: GM_ACTION_PERFORMED уходит
 *    в outbox АТОМАРНО с действием и НЕ дублируется при replay (D249);
 *  - inspect.ts — GMStateView (публичная проекция + GM-блок; GM_ONLY-заметки
 *    только в GM-части), DirectorContext из журнала 'ai_context_built' (D121);
 *  - notes.ts — addNote + обработчик TURN_COMMITTED: публикация заметок
 *    PUBLIC_AFTER_COMMIT системными сообщениями чата, ровно один раз (F-3.8).
 */
export {
  gmContract,
  StartSessionInputSchema,
  StartSessionOutputSchema,
  PauseSessionInputSchema,
  ResumeSessionInputSchema,
  SessionStatusOutputSchema,
  EndSessionInputSchema,
  OpenTurnInputSchema,
  LockTurnInputSchema,
  UnlockTurnInputSchema,
  CancelTurnInputSchema,
  TurnRefOutputSchema,
  MoveGroupInputSchema,
  MoveGroupOutputSchema,
  KickPlayerInputSchema,
  SendSystemMessageInputSchema,
  SendSystemMessageOutputSchema,
  ActivateEventInputSchema,
  AddNoteInputSchema,
  AddNoteOutputSchema,
  InspectStateInputSchema,
  InspectAIContextInputSchema,
  InspectJournalInputSchema,
  ListAuditInputSchema,
  type StartSessionInput,
  type StartSessionOutput,
  type PauseSessionInput,
  type ResumeSessionInput,
  type SessionStatusOutput,
  type EndSessionInput,
  type OpenTurnInput,
  type LockTurnInput,
  type UnlockTurnInput,
  type CancelTurnInput,
  type TurnRefOutput,
  type MoveGroupInput,
  type MoveGroupOutput,
  type KickPlayerInput,
  type SendSystemMessageInput,
  type SendSystemMessageOutput,
  type ActivateEventInput,
  type AddNoteInput,
  type AddNoteOutput,
  type InspectStateInput,
  type InspectAIContextInput,
  type InspectJournalInput,
  type ListAuditInput,
} from './contract.js';
export { GmService } from './service.js';
export { addNote, onTurnCommittedNotes } from './notes.js';
export { inspectAIContext, inspectJournal, inspectState, listAudit } from './inspect.js';
export { assertGmPlayer } from './access.js';
export { noteIdFromKey, publicNoteMessageId, systemMessageIdFromKey } from './ids.js';
export { type ChatSystemPort, type GmLog, type GmServiceDeps } from './deps.js';

export const PACKAGE_ID = '@mnemosin/module-gm';
export const IMPLEMENTED_IN_PROMPT = '1.9';
