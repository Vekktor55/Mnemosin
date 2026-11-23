import {
  CoreError,
  HotGameplayEventAckSchema,
  HotGameplayJournalPayloadSchema,
  nowIso,
  type HotGameplayEventEnvelope,
  type HotGameplayEventAck,
  type SessionId,
  type FlagKey,
  type ObjectId,
  type StateMutation,
} from '@mnemosin/contracts';
import type { UnitOfWork } from '../domain/ports/index.js';
import type { JournalService } from '../turns/index.js';
import type { StateService } from '../state/index.js';
import { appendOutbox, createEvent } from '../events/index.js';

const PROTOTYPE_RETRY_ATTEMPTS = 3;
const PROTOTYPE_RETRY_BASE_MS = 50;

interface ProcessedEventRecord {
  readonly eventId: string;
  readonly matchId: string;
  readonly worldEpoch: number;
  readonly processedAt: number;
}

export class ColdGameplayEventProcessor {
  private readonly uow: UnitOfWork;
  private readonly journal: JournalService;
  private readonly state: StateService;
  private readonly processedEvents = new Map<string, ProcessedEventRecord>();

  constructor(deps: { readonly uow: UnitOfWork; readonly journal: JournalService; readonly state: StateService }) {
    this.uow = deps.uow;
    this.journal = deps.journal;
    this.state = deps.state;
  }

  async process(input: { readonly event: HotGameplayEventEnvelope; readonly sessionId: string }): Promise<{
    readonly ack: HotGameplayEventAck;
    readonly journalEntryId: number;
  }> {
    const { event, sessionId } = input;

    const existing = this.processedEvents.get(event.eventId);
    if (existing !== undefined) {
      const state = await this.state.get(sessionId as SessionId);
      return {
        ack: HotGameplayEventAckSchema.parse({
          eventId: event.eventId,
          matchId: event.matchId,
          worldEpoch: event.worldEpoch,
          eventSequence: event.eventSequence,
          simulationTick: event.simulationTick,
          outcome: 'replayed' as const,
          coldStateVersion: state.version,
          committedAt: nowIso(),
        }),
        journalEntryId: -1,
      };
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < PROTOTYPE_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await this.processOnce(event, sessionId, attempt);
      } catch (err) {
        lastError = err;
        if (attempt < PROTOTYPE_RETRY_ATTEMPTS - 1) {
          const delay = PROTOTYPE_RETRY_BASE_MS * 2 ** attempt;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw new CoreError('CORE_EVENT_NOT_REGISTERED', 'Durable event processing failed after retries', {
      eventId: event.eventId,
      cause: lastError instanceof Error ? lastError.message : String(lastError),
    });
  }

  private async processOnce(
    event: HotGameplayEventEnvelope,
    sessionId: string,
    attempt: number,
  ): Promise<{ readonly ack: HotGameplayEventAck; readonly journalEntryId: number }> {
    const traceId = `hot-event-${event.eventId}-${attempt}`;

    const result = await this.uow.runInTx(async (scope) => {
      const mutations = this.toStateMutations(event);
      const currentState = await scope.repos.state.findBySession(sessionId as SessionId);
      const stateResult = await this.state.apply({
        sessionId: sessionId as SessionId,
        mutations,
        expectedVersion: currentState?.version ?? 0,
        turnId: null,
        traceId,
        scope,
      });

      const journalEntry = await this.journal.append(
        {
          sessionId: sessionId as SessionId,
          turnId: null,
          kind: 'hot_gameplay_committed',
          payload: { event: HotGameplayJournalPayloadSchema.parse({ event }) },
          traceId,
        },
        scope,
      );

      await appendOutbox(
        [
          createEvent(
            'STATE_COMMITTED',
            {
              sessionId: sessionId as SessionId,
              version: stateResult.version,
              changedKeys: stateResult.changedKeys.map((k: string) => k.slice(0, 120)),
            },
            traceId,
          ),
        ],
        scope,
      );

      return { stateResult, journalEntry };
    });

    const record: ProcessedEventRecord = {
      eventId: event.eventId,
      matchId: event.matchId,
      worldEpoch: event.worldEpoch,
      processedAt: Date.now(),
    };
    this.processedEvents.set(event.eventId, record);

    return {
      ack: HotGameplayEventAckSchema.parse({
        eventId: event.eventId,
        matchId: event.matchId,
        worldEpoch: event.worldEpoch,
        eventSequence: event.eventSequence,
        simulationTick: event.simulationTick,
        outcome: 'committed' as const,
        coldStateVersion: result.stateResult.version,
        committedAt: nowIso(),
      }),
      journalEntryId: result.journalEntry.id,
    };
  }

  private toStateMutations(event: HotGameplayEventEnvelope): StateMutation[] {
    switch (event.type) {
      case 'prototype.item.acquired': {
        const payload = event.payload as { itemId: string; ownerId: string };
        return [
          { kind: 'OBJECT_TAKEN', objectId: payload.itemId as ObjectId, taken: true },
          {
            kind: 'SET_FLAG',
            key: `prototype.item.${payload.itemId}.owner` as FlagKey,
            value: payload.ownerId,
            setBy: 'ENGINE',
          },
        ];
      }
      case 'prototype.filter.depleted': {
        const payload = event.payload as { filterId: string };
        return [
          { kind: 'OBJECT_PATCH', objectId: payload.filterId as ObjectId, patch: { charge: 0, depleted: true } },
          {
            kind: 'SET_FLAG',
            key: `prototype.filter.${payload.filterId}.depleted` as FlagKey,
            value: true,
            setBy: 'ENGINE',
          },
        ];
      }
      case 'prototype.capture.recorded': {
        const payload = event.payload as { capturedParticipantId: string };
        return [
          {
            kind: 'SET_FLAG',
            key: `prototype.capture.${payload.capturedParticipantId}` as FlagKey,
            value: true,
            setBy: 'ENGINE',
          },
        ];
      }
      default:
        return [];
    }
  }
}
