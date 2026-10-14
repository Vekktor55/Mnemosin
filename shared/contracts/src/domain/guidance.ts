import { z } from 'zod';

/**
 * Указания модели (поправки K10, K11).
 *
 * В данных мира v1 это `ai_guidance` комнаты и `narrative_guidance` события.
 * Ключевое свойство: это содержимое **для модели, не для игрока** — поэтому оно
 * входит в AiLocationView и DirectorContext, но никогда в PublicLocationView.
 * Третий уровень (`.gm.json`) не виден и модели — см. LocationGmSecretSchema.
 */

/** `narrative_guidance` события: 13 ключей, встречающихся в реальных данных. */
export const EventAiGuidanceSchema = z
  .object({
    purpose: z.string().max(500).nullable(),
    sequence: z.array(z.string().max(200)).max(12),
    mustNotExplain: z.array(z.string().max(200)).max(12),
    // По фактическим данным (7 комнат): allowed_revelation — всегда массив (42 случая),
    // forbidden_revelation — всегда массив (36), forbidden — массив (11) ИЛИ строка (1).
    allowedRevelation: z.array(z.string().max(400)).nullable(),
    forbiddenRevelation: z.array(z.string().max(400)).nullable(),
    effect: z.string().max(500).nullable(),
    mechanicalConsequence: z.string().max(500).nullable(),
    important: z.string().max(500).nullable(),
    forbidden: z.union([z.string().max(500), z.array(z.string().max(400))]).nullable(),
    // добавлены по данным этажа −1 (2026-10-12):
    consequence: z.string().max(500).nullable(),
    // В данных (1 случай, RECEPTION_MONITOR_UNLOCKED) это свободный текст-указание,
    // а не enum: «Счётчик цикла не должен читаться… пока GM явно не решит иначе».
    defaultVisibility: z.string().max(500).nullable(),
    frequency: z.string().max(200).nullable(),
    secretRole: z.string().max(500).nullable(),
    // 14-й ключ — найден в floor-1_hidden_vestibule (DESCENT_TO_FLOOR_MINUS_2);
    // contract-тест на реальных данных поймал его автоматически (D191).
    conditionNote: z.string().max(500).nullable(),
  })
  .partial();
export type EventAiGuidance = z.infer<typeof EventAiGuidanceSchema>;

/** `ai_guidance` локации (v1: role, core_instruction, revelation_pacing, …). */
export const LocationAiGuidanceSchema = z.object({
  role: z.string().max(300).nullable(),
  coreInstruction: z.string().max(2000).nullable(),
  revelationPacing: z.array(z.string().max(400)).max(20),
  forbiddenKnowledgeReveal: z.array(z.string().max(400)).max(20),
  supernaturalLimit: z
    .object({
      manifestations: z.string().max(500).nullable(),
      useCount: z.number().int().min(0),
    })
    .nullable(),
});
export type LocationAiGuidance = z.infer<typeof LocationAiGuidanceSchema>;

/**
 * GM-only блок (K7). Источник — `*.gm.json` v1 с `meta.sensitive: true`.
 *
 * ЖЁСТКОЕ ПРАВИЛО: не попадает ни в DirectorContext, ни в PublicLocationView,
 * ни в PublicGameStateView, ни в WS-broadcast. Нарушение = дефект уровня B-10.
 * Проверяется тестом с маркером (аналог v1-критерия приёмки №9).
 */
export const LocationGmSecretSchema = z.object({
  truth: z.string().max(4000).nullable(),
  futureConnections: z.string().max(4000).nullable(),
  staticNotes: z.string().max(4000).nullable(),
  secretValues: z.record(z.string().max(80), z.union([z.boolean(), z.string().max(500), z.number()])),
  puzzleSolutions: z.record(z.string().max(80), z.string().max(2000)),
  manualControls: z.array(z.string().max(120)),
  noiseNote: z.string().max(1000).nullable(),
});
export type LocationGmSecret = z.infer<typeof LocationGmSecretSchema>;
