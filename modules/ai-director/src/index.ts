/**
 * @mnemosin/module-ai-director — AI-Директор (промпт 1.7).
 *
 *  - contract.ts — ModuleContract (defineModule): commands.generateDraft({turnId}),
 *    queries.getDraft({turnId}); emits AI_DRAFT_PROPOSED / AI_GENERATION_FAILED;
 *    subscribes GM_NOTE_ADDED (НЕ TURN_LOCKED — D115/B-09: вызов только командой
 *    из Turn Engine); ports ['AIPort']; capabilities ['TEXT_AI'];
 *  - context.ts — buildDirectorContext: упрощённая сборка этапа 1
 *    (токен-бюджет/тримминг истории — промпт 2.5);
 *  - generate-draft.ts — AiDirectorService: цепочка провайдеров через
 *    AIProviderRegistry (D227), repair при PROVIDER_SCHEMA, TurnResolution
 *    (все item'ы PROPOSED), ai_decisions, метрики ai.duration_ms и
 *    ai.schema_errors_total.
 *
 * Границы (правило 1.3): модуль импортирует только @mnemosin/contracts,
 * @mnemosin/core, zod и node:crypto. Реестр провайдеров (infrastructure/ai)
 * инжектируется wiring'ом apps/server через структурный интерфейс.
 */
export {
  aiDirectorContract,
  GenerateDraftInputSchema,
  GenerateDraftOutputSchema,
  GetDraftInputSchema,
  GetDraftOutputSchema,
  type GenerateDraftInput,
  type GenerateDraftOutput,
  type GetDraftInput,
  type GetDraftOutput,
} from './contract.js';
export {
  buildDirectorContext,
  toAiLocationView,
  type BuildContextDeps,
  type BuildContextInput,
  type BuiltContext,
} from './context.js';
export {
  AiDirectorService,
  buildResolution,
  chunkNarrative,
  sha256,
  stableStringify,
  withRepairInstructions,
  type AIProviderRegistry,
  type AiDirectorDeps,
  type AiDirectorLog,
  type BuildResolutionInput,
  type PolicyAttemptContext,
} from './generate-draft.js';

export const PACKAGE_ID = '@mnemosin/module-ai-director';
export const IMPLEMENTED_IN_PROMPT = '1.7';
