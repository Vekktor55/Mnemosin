import { z } from 'zod';
import { IsoDateTime } from '../time.js';
import { FlagKey, LocationId, ObjectId, PlayerId, Scalar, SessionId, TurnId } from '../ids.js';

/**
 * GameState (v3 §II.7) с поправками аудита:
 *  - `storyFlags` ключуется **строковым key**, а не FlagId (блокер B-03):
 *    DSL обращается к флагам по key, и резолв пути должен быть однозначным;
 *  - `playerKnowledge.entries` — массив, а не record (F-1.15: ключ дублировал
 *    поле `key` внутри записи);
 *  - `version` — optimistic lock (v3 §III.13).
 *
 * Инварианты 7–8: AI и Media не пишут сюда напрямую — только через StateService.
 */

export const TimeOfDay = z.enum(['DAWN', 'MORNING', 'NOON', 'EVENING', 'NIGHT', 'UNKNOWN']);
export type TimeOfDay = z.infer<typeof TimeOfDay>;

export const WorldStateSchema = z.object({
  currentLocationId: LocationId,
  timeOfDay: TimeOfDay,
  weather: z.string().max(60).nullable(),
  ambientFlags: z.record(z.string().max(60), Scalar),
});
export type WorldState = z.infer<typeof WorldStateSchema>;

export const StoryFlagSchema = z.object({
  flagId: z.string().uuid(),
  key: FlagKey,
  value: Scalar,
  setAtTurnId: TurnId.nullable(),
  setBy: z.enum(['AI_APPROVED', 'GM', 'ENGINE']),
});
export type StoryFlag = z.infer<typeof StoryFlagSchema>;

export const ObjectStateSchema = z.object({
  objectId: ObjectId,
  locationId: LocationId,
  state: z.record(z.string().max(60), Scalar),
  visible: z.boolean().default(true),
  /** K16/D182: минимальная модель предметов — предмет = объект с `taken`. */
  taken: z.boolean().default(false),
  lastChangedAtTurnId: TurnId.nullable(),
});
export type ObjectState = z.infer<typeof ObjectStateSchema>;

export const KnowledgeSource = z.enum(['OBSERVED', 'TOLD', 'DISCOVERED', 'GM']);
export type KnowledgeSource = z.infer<typeof KnowledgeSource>;

export const KnowledgeEntrySchema = z.object({
  key: z.string().min(1).max(80),
  value: Scalar,
  learnedAtTurnId: TurnId.nullable(),
  source: KnowledgeSource,
});
export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

export const PlayerKnowledgeSchema = z.object({
  playerId: PlayerId,
  entries: z.array(KnowledgeEntrySchema),
});
export type PlayerKnowledge = z.infer<typeof PlayerKnowledgeSchema>;

export const EndingStateSchema = z.object({
  endingId: z.string().min(1).max(80),
  reachedAtTurnId: TurnId,
  summary: z.string().max(2000),
  survivors: z.array(PlayerId),
});
export type EndingState = z.infer<typeof EndingStateSchema>;

export const GameStateSchema = z.object({
  sessionId: SessionId,
  worldState: WorldStateSchema,
  storyFlags: z.record(FlagKey, StoryFlagSchema),
  objectStates: z.record(ObjectId, ObjectStateSchema),
  playerKnowledge: z.record(PlayerId, PlayerKnowledgeSchema),
  endingState: EndingStateSchema.nullable(),
  version: z.number().int().nonnegative(),
  updatedAt: IsoDateTime,
});
export type GameState = z.infer<typeof GameStateSchema>;

/** Точечная мутация состояния — единственный формат, который принимает StateService. */
export const StateMutationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('SET_FLAG'),
    key: FlagKey,
    value: Scalar,
    setBy: z.enum(['AI_APPROVED', 'GM', 'ENGINE']),
  }),
  z.object({ kind: z.literal('OBJECT_PATCH'), objectId: ObjectId, patch: z.record(z.string().max(60), Scalar) }),
  z.object({ kind: z.literal('OBJECT_VISIBLE'), objectId: ObjectId, visible: z.boolean() }),
  z.object({ kind: z.literal('OBJECT_TAKEN'), objectId: ObjectId, taken: z.boolean() }),
  z.object({
    kind: z.literal('WORLD_PATCH'),
    timeOfDay: TimeOfDay.optional(),
    weather: z.string().max(60).nullable().optional(),
    currentLocationId: LocationId.optional(),
    ambientFlags: z.record(z.string().max(60), Scalar).optional(),
  }),
  z.object({
    kind: z.literal('GRANT_KNOWLEDGE'),
    playerId: PlayerId,
    key: z.string().max(80),
    value: Scalar,
    source: KnowledgeSource,
  }),
  z.object({
    kind: z.literal('REACH_ENDING'),
    endingId: z.string().max(80),
    summary: z.string().max(2000),
    survivors: z.array(PlayerId),
  }),
]);
export type StateMutation = z.infer<typeof StateMutationSchema>;
