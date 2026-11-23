import type {
  EventId,
  MatchId,
  WorldEpoch,
  HotGameplayEventEnvelope,
  HotGameplayEventAck,
  ColdToHotCommand,
  SessionId,
} from '@mnemosin/contracts';
import type { UnitOfWork, CommandRunner } from '../domain/ports/index.js';
import type { JournalService } from '../turns/index.js';
import type { StateService } from '../state/index.js';

export interface ColdProcessorDeps {
  readonly uow: UnitOfWork;
  readonly commandRunner: CommandRunner;
  readonly journal: JournalService;
  readonly state: StateService;
}

export interface ProcessHotEventInput {
  readonly event: HotGameplayEventEnvelope;
  readonly sessionId: SessionId;
}

export interface ProcessColdCommandInput {
  readonly command: ColdToHotCommand;
  readonly sessionId: SessionId;
}

export interface ColdProcessorResult {
  readonly ack: HotGameplayEventAck;
  readonly journalEntryId: number;
}

export interface ProcessedEventRecord {
  readonly eventId: EventId;
  readonly matchId: MatchId;
  readonly worldEpoch: WorldEpoch;
  readonly processedAt: number;
}

export interface HotEventProcessingError {
  readonly eventId: EventId;
  readonly matchId: MatchId;
  readonly errorCode: string;
  readonly retryable: boolean;
}
