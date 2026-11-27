import { z } from 'zod';

import {
  CommandId,
  EventId,
  EventSequence,
  MatchId,
  ObjectId,
  ParticipantId,
  Scalar,
  SimulationTick,
  WorldEpoch,
} from '../ids.js';
import { IsoDateTime } from '../time.js';

/**
 * HOT ↔ COLD контракты P06 (HOT_COLD_DESIGN.md §7.2–7.3).
 *
 * Выделены в отдельный модуль, потому что их используют и transport-схемы
 * (`scene:durable-event`), и Core (`core/src/hot`, `core/src/cold`). Общий
 * модуль исключает циклический импорт `transport/realtime` ↔ `transport/envelope`.
 */

const hotEventMetadata = {
  schemaVersion: z.literal(1),
  eventId: EventId,
  matchId: MatchId,
  worldEpoch: WorldEpoch,
  simulationTick: SimulationTick,
  serverTimeMs: z.number().int().nonnegative().safe(),
  eventSequence: EventSequence,
  actor: z.object({ participantId: ParticipantId }).strict(),
  source: z.object({ kind: z.literal('hot-runtime'), runtimeId: z.string().uuid() }).strict(),
  correlation: z.object({ correlationId: z.string().uuid(), causationId: EventId.nullable() }).strict(),
} as const;

export const HotGameplayEventPayloadSchemas = {
  'prototype.item.acquired': z.object({ itemId: ObjectId, ownerId: ParticipantId }).strict(),
  'prototype.filter.depleted': z.object({ filterId: ObjectId }).strict(),
  'prototype.capture.recorded': z.object({ capturedParticipantId: ParticipantId }).strict(),
} as const;
export type HotGameplayEventType = keyof typeof HotGameplayEventPayloadSchemas;

function hotEvent<TType extends HotGameplayEventType>(type: TType) {
  return z
    .object({ ...hotEventMetadata, type: z.literal(type), payload: HotGameplayEventPayloadSchemas[type] })
    .strict();
}

/** HOT → COLD durable gameplay events; не WebSocket scene delta и не narrative reset. */
export const HotGameplayEventEnvelopeSchema = z.discriminatedUnion('type', [
  hotEvent('prototype.item.acquired'),
  hotEvent('prototype.filter.depleted'),
  hotEvent('prototype.capture.recorded'),
]);
export type HotGameplayEventEnvelope = z.infer<typeof HotGameplayEventEnvelopeSchema>;
export type HotGameplayEventOf<TType extends HotGameplayEventType> = Extract<HotGameplayEventEnvelope, { type: TType }>;

/** Все известные типы durable-событий — для доменной валидации до commit. */
export const HOT_GAMEPLAY_EVENT_TYPES = Object.freeze(
  Object.keys(HotGameplayEventPayloadSchemas) as HotGameplayEventType[],
);

export const HotGameplayEventAckSchema = z
  .object({
    eventId: EventId,
    matchId: MatchId,
    worldEpoch: WorldEpoch,
    eventSequence: EventSequence,
    simulationTick: SimulationTick,
    outcome: z.enum(['committed', 'replayed']),
    coldStateVersion: z.number().int().nonnegative().safe(),
    committedAt: IsoDateTime,
  })
  .strict();
export type HotGameplayEventAck = z.infer<typeof HotGameplayEventAckSchema>;

export const HotGameplayJournalPayloadSchema = z.object({ event: HotGameplayEventEnvelopeSchema }).strict();
export type HotGameplayJournalPayload = z.infer<typeof HotGameplayJournalPayloadSchema>;

const coldCommandMetadata = {
  schemaVersion: z.literal(1),
  commandId: CommandId,
  matchId: MatchId,
  revision: z.number().int().positive().safe(),
  worldEpoch: WorldEpoch,
  issuedAtEventId: EventId.optional(),
} as const;

/** P06 test-only update: проверяет ordering без введения правил дверей/света P07. */
export const ColdToHotCommandSchema = z
  .object({
    ...coldCommandMetadata,
    type: z.literal('prototype.runtime.fact'),
    target: z.object({ participantId: ParticipantId }).strict(),
    payload: z.object({ key: z.string().min(1).max(80), value: Scalar }).strict(),
  })
  .strict();
export type ColdToHotCommand = z.infer<typeof ColdToHotCommandSchema>;

/**
 * Journal payload COLD→HOT: применённая команда с её ревизией.
 *
 * Нужен для восстановления после рестарта: по журналу собираются команды с
 * `revision > recoveryPoint.coldRevision` и применяются в HOT заново, строго
 * по возрастанию ревизии (HOT_COLD_DESIGN.md §9.2, §13.5).
 */
export const ColdToHotJournalPayloadSchema = z.object({ command: ColdToHotCommandSchema }).strict();
export type ColdToHotJournalPayload = z.infer<typeof ColdToHotJournalPayloadSchema>;
