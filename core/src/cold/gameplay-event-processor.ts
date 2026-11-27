import {
  AppError,
  CoreError,
  ERROR_TABLE,
  HotGameplayEventAckSchema,
  HotGameplayEventEnvelopeSchema,
  HotGameplayJournalPayloadSchema,
  HOT_GAMEPLAY_EVENT_TYPES,
  nowIso,
  SessionId,
  type FlagKey,
  type HotGameplayEventAck,
  type HotGameplayEventEnvelope,
  type HotGameplayEventType,
  type MatchId,
  type StateMutation,
} from '@mnemosin/contracts';
import type { CommandRunner, TxScope } from '../domain/ports/index.js';
import { runCommand } from '../domain/command.js';
import type { JournalService } from '../turns/index.js';
import type { StateService } from '../state/index.js';
import type { ColdProcessorResult, ProcessHotEventInput } from './types.js';

/** PROTOTYPE-ONLY (HC-09): bounded retry; production pause policy remains open. */
export const PROTOTYPE_COLD_EVENT_RETRY = Object.freeze({ attempts: 3, baseDelayMs: 50 });

export interface ColdEventRetryOptions {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  /** Test-only deterministic sleep; production wiring uses setTimeout. */
  readonly sleep?: (delayMs: number) => Promise<void>;
}

export interface ColdGameplayEventProcessorDeps {
  readonly commandRunner: CommandRunner;
  readonly journal: JournalService;
  readonly state: StateService;
  /**
   * Match, которому принадлежит обслуживаемая COLD-сессия.
   *
   * PROTOTYPE-ONLY (одна сессия = один match): привязка известна в wiring,
   * поэтому событие чужого match отклоняется ДО транзакции — в журнал и
   * GameState чужой match не попадает (иначе recovery вынужден был бы
   * fail-closed на расхождении COLD и HOT).
   */
  readonly matchId: MatchId;
  readonly retry?: ColdEventRetryOptions;
}

/**
 * HOT → COLD durable event consumer (at-least-once + idempotent consumer).
 *
 * Идемпотентность НЕ хранится в памяти процесса. `CommandRunner` — существующий
 * `IdempotencyService`: ключ, StateService mutation, journal/outbox и сохранённый
 * результат коммитятся одной SQLite-транзакцией. Поэтому новый processor после
 * restart получает тот же ACK через `replayed`, не повторяя игровой эффект.
 */
export class ColdGameplayEventProcessor {
  private readonly commandRunner: CommandRunner;
  private readonly journal: JournalService;
  private readonly state: StateService;
  /** Match, которому принадлежит обслуживаемая COLD-сессия. */
  readonly matchId: MatchId;
  private readonly attempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(deps: ColdGameplayEventProcessorDeps) {
    this.commandRunner = deps.commandRunner;
    this.journal = deps.journal;
    this.state = deps.state;
    this.matchId = deps.matchId;
    this.attempts = deps.retry?.attempts ?? PROTOTYPE_COLD_EVENT_RETRY.attempts;
    this.baseDelayMs = deps.retry?.baseDelayMs ?? PROTOTYPE_COLD_EVENT_RETRY.baseDelayMs;
    this.sleep = deps.retry?.sleep ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
    if (!Number.isSafeInteger(this.attempts) || this.attempts <= 0) {
      throw new Error('COLD event retry attempts must be a positive safe integer');
    }
    if (!Number.isFinite(this.baseDelayMs) || this.baseDelayMs < 0) {
      throw new Error('COLD event retry baseDelayMs must be a non-negative finite number');
    }
  }

  async process(input: ProcessHotEventInput): Promise<ColdProcessorResult> {
    const sessionId = SessionId.parse(input.sessionId);
    const event = validateHotEvent(input.event, this.matchId);
    let lastError: unknown;

    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      try {
        return await this.processOnce(event, sessionId);
      } catch (error) {
        lastError = error;
        if (!isRetryable(error)) throw error;
        if (attempt < this.attempts - 1) await this.sleep(this.baseDelayMs * 2 ** attempt);
      }
    }

    // Цикл всегда возвращает результат или выбрасывает ошибку; защита от будущих правок.
    throw new AppError('INTERNAL', 'Durable event processing failed', {
      eventId: event.eventId,
      cause: lastError instanceof Error ? lastError.message : String(lastError),
    });
  }

  private async processOnce(event: HotGameplayEventEnvelope, sessionId: SessionId): Promise<ColdProcessorResult> {
    const result = await runCommand(
      this.commandRunner,
      {
        key: hotEventIdempotencyKey(event),
        command: 'processHotGameplayEvent',
        sessionId,
        turnId: null,
        traceId: `hot-event-${event.eventId}`,
      },
      (scope) => this.commit(event, sessionId, scope),
    );

    if (result.replayed) {
      return { ack: { ...result.value.ack, outcome: 'replayed' }, journalEntryId: -1 };
    }
    // runCommand возвращается только после commit CommandRunner; ACK раньше не существует.
    return result.value;
  }

  private async commit(
    event: HotGameplayEventEnvelope,
    sessionId: SessionId,
    scope: TxScope,
  ): Promise<ColdProcessorResult> {
    const currentState = await scope.repos.state.findBySession(sessionId);
    const stateResult = await this.state.apply({
      sessionId,
      mutations: this.toStateMutations(event),
      expectedVersion: currentState?.version ?? 0,
      turnId: null,
      traceId: `hot-event-${event.eventId}`,
      scope,
    });

    const journalEntry = await this.journal.append(
      {
        sessionId,
        turnId: null,
        kind: 'hot_gameplay_committed',
        payload: HotGameplayJournalPayloadSchema.parse({ event }),
        traceId: `hot-event-${event.eventId}`,
      },
      scope,
    );

    const ack: HotGameplayEventAck = HotGameplayEventAckSchema.parse({
      eventId: event.eventId,
      matchId: event.matchId,
      worldEpoch: event.worldEpoch,
      eventSequence: event.eventSequence,
      simulationTick: event.simulationTick,
      outcome: 'committed',
      coldStateVersion: stateResult.version,
      committedAt: nowIso(),
    });
    return { ack, journalEntryId: journalEntry.id };
  }

  private toStateMutations(event: HotGameplayEventEnvelope): StateMutation[] {
    switch (event.type) {
      case 'prototype.item.acquired':
        return [
          { kind: 'OBJECT_TAKEN', objectId: event.payload.itemId, taken: true },
          {
            kind: 'SET_FLAG',
            key: `prototype.item.${event.payload.itemId}.owner` as FlagKey,
            value: event.payload.ownerId,
            setBy: 'ENGINE',
          },
        ];
      case 'prototype.filter.depleted':
        return [
          {
            kind: 'OBJECT_PATCH',
            objectId: event.payload.filterId,
            patch: { charge: 0, depleted: true },
          },
          {
            kind: 'SET_FLAG',
            key: `prototype.filter.${event.payload.filterId}.depleted` as FlagKey,
            value: true,
            setBy: 'ENGINE',
          },
        ];
      case 'prototype.capture.recorded':
        return [
          {
            kind: 'SET_FLAG',
            key: `prototype.capture.${event.payload.capturedParticipantId}` as FlagKey,
            value: true,
            setBy: 'ENGINE',
          },
        ];
    }
  }
}

export function hotEventIdempotencyKey(event: HotGameplayEventEnvelope): string {
  return `hot-event:${event.matchId}:${event.worldEpoch}:${event.eventId}`;
}

function validateHotEvent(event: HotGameplayEventEnvelope, expectedMatchId: MatchId): HotGameplayEventEnvelope {
  const eventType = (event as { type?: unknown }).type;
  if (typeof eventType !== 'string' || !HOT_GAMEPLAY_EVENT_TYPES.includes(eventType as HotGameplayEventType)) {
    throw new CoreError('CORE_EVENT_NOT_REGISTERED', `Unknown durable HOT event type: ${String(eventType)}`, {
      eventId: (event as { eventId?: unknown }).eventId,
      eventType,
    });
  }
  const parsed = HotGameplayEventEnvelopeSchema.safeParse(event);
  if (!parsed.success) {
    throw new AppError('VALIDATION', 'Durable HOT event failed HotGameplayEventEnvelopeSchema', {
      issues: parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  // Fail-closed: событие другого match не должно попасть в GameState/журнал этой сессии.
  if (parsed.data.matchId !== expectedMatchId) {
    throw new CoreError('CORE_INVALID_STATE_TRANSITION', 'Durable HOT event belongs to a different match', {
      eventId: parsed.data.eventId,
      eventMatchId: parsed.data.matchId,
      expectedMatchId,
    });
  }
  return parsed.data;
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof AppError)) return true;
  const category = ERROR_TABLE[error.code]?.category;
  return category !== 'validation' && category !== 'rules' && category !== 'content';
}
