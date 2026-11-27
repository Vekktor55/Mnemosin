import type {
  EventId,
  MatchId,
  HotGameplayEventEnvelope,
  HotGameplayEventAck,
  ColdToHotCommand,
  SessionId,
} from '@mnemosin/contracts';

export interface ProcessHotEventInput {
  readonly event: HotGameplayEventEnvelope;
  /** COLD-сессия, чьё GameState мутируется. Это НЕ matchId: match и сессия — разные идентификаторы. */
  readonly sessionId: SessionId;
}

export interface ProcessColdCommandInput {
  readonly command: ColdToHotCommand;
  readonly sessionId: SessionId;
}

export interface ColdProcessorResult {
  readonly ack: HotGameplayEventAck;
  /** -1 означает replay: новой journal-записи не создано. */
  readonly journalEntryId: number;
}

export interface HotEventProcessingError {
  readonly eventId: EventId;
  readonly matchId: MatchId;
  readonly errorCode: string;
  readonly retryable: boolean;
}
