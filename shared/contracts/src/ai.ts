import { z } from 'zod';
import { FlagKey, ObjectId, PlayerId, Scalar, SessionId, TurnId } from './ids.js';
import { AiLocationViewSchema } from './transport/views.js';
import { PlayerActionSchema } from './domain/action.js';
import { VisualSceneDescriptionSchema } from './domain/visual.js';
import { EffectSchema } from './dsl/effects.js';
import { TimeOfDay } from './domain/state.js';

/**
 * AI-контракт (v3 §IV.4–IV.5, §V.1) + поправки:
 *  K13 — `characterNames` и `namePolicy` (D173: имя в нарративе только после
 *        флага `remembered_name.<playerId>`);
 *  F-7.1 — `usage` в результате генерации (без него cost model не наполнить);
 *  F-1.2 — `objectStates` типизированы, `z.any()` из v3 убран.
 */

export const NamePolicy = z.enum(['WITHHELD', 'PARTIAL', 'ALL']);
export type NamePolicy = z.infer<typeof NamePolicy>;

export const CharacterNameSchema = z.object({
  playerId: PlayerId,
  name: z.string().min(1).max(60),
});
export type CharacterName = z.infer<typeof CharacterNameSchema>;

export const DirectorContextSchema = z.object({
  sessionId: SessionId,
  turnId: TurnId,
  turnNumber: z.number().int().nonnegative(),
  currentLocation: AiLocationViewSchema,
  visiblePlayerActions: z.array(PlayerActionSchema),
  relevantState: z.object({
    timeOfDay: TimeOfDay,
    weather: z.string().max(60).nullable(),
    activeFlags: z.record(FlagKey, Scalar),
    objectStates: z.array(
      z.object({
        objectId: ObjectId,
        locationId: z.string().uuid(),
        visible: z.boolean(),
        taken: z.boolean(),
        state: z.record(z.string().max(60), Scalar),
      }),
    ),
  }),
  /** Только зарегистрированные события текущей локации (инвариант v2 §26). */
  allowedEventIds: z.array(z.string().uuid()),
  allowedEvents: z.array(
    z.object({
      eventId: z.string().uuid(),
      name: z.string().max(120),
      /** Указания модели по событию (K10) — только для разрешённых событий. */
      aiGuidance: z.record(z.string().max(40), z.unknown()).nullable(),
    }),
  ),
  storyFacts: z.array(z.string().max(300)),
  gmNotesForAI: z.array(z.string().max(500)),
  directorInstructions: z.string().max(6000),
  /** K13/D173. */
  characterNames: z.array(CharacterNameSchema),
  namePolicy: NamePolicy,
  /** Для тримминга и учёта (промпт 2.5). */
  tokensEstimate: z.number().int().nonnegative().nullable(),
});
export type DirectorContext = z.infer<typeof DirectorContextSchema>;

// ---------------------------------------------------------------- AIResponse

export const ProposedEventSchema = z.object({
  eventId: z.string().uuid(),
  rationale: z.string().max(400),
  effects: z.array(EffectSchema),
});
export type ProposedEvent = z.infer<typeof ProposedEventSchema>;

export const ProposedObjectChangeSchema = z.object({
  objectId: ObjectId,
  patch: z.record(z.string().max(60), Scalar),
  rationale: z.string().max(300),
});
export type ProposedObjectChange = z.infer<typeof ProposedObjectChangeSchema>;

export const AIResponseSchema = z.object({
  narrative: z.string().min(1).max(6000),
  privateMessages: z.array(z.object({ playerId: PlayerId, text: z.string().min(1).max(1500) })),
  proposedEvents: z.array(ProposedEventSchema),
  proposedObjectChanges: z.array(ProposedObjectChangeSchema),
  visualSceneDescription: VisualSceneDescriptionSchema.nullable(),
});
export type AIResponse = z.infer<typeof AIResponseSchema>;

export const AIGenerationResultSchema = z.object({
  response: AIResponseSchema,
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      model: z.string().max(120),
    })
    .nullable(),
  durationMs: z.number().int().nonnegative(),
  providerId: z.string().max(64),
});
export type AIGenerationResult = z.infer<typeof AIGenerationResultSchema>;

/** Визуальный промпт (v3 §V.9). */
export const VisualPromptResultSchema = z.object({
  prompt: z.string().min(1).max(4000),
  negativePrompt: z.string().max(2000).nullable(),
  providerId: z.string().max(64),
});
export type VisualPromptResult = z.infer<typeof VisualPromptResultSchema>;
