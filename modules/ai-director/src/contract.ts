import { z } from 'zod';
import { DirectorContextSchema, SessionId, TurnId, TurnResolutionSchema, defineModule } from '@mnemosin/contracts';

/**
 * Контракт модуля ai-director (v3 §IV.2, §V.1; промпт 1.7, п.6).
 *
 * D115 (SPEC_STAGE1 §13, блокер B-09): AI-Директор вызывается ТОЛЬКО командой
 * `generateDraft` из Turn Engine (промпт 1.8). Подписки на TURN_LOCKED НЕТ —
 * иначе два движка (событийный и командный) владели бы одним переходом.
 * `GM_NOTE_ADDED` в subscribes: заметки visibility='AI_DIRECTOR' влияют на
 * контекст СЛЕДУЮЩЕЙ генерации; в этапе 1 подписка декларативна (контекст
 * собирается из БД на каждый вызов), boot-подписка — в modules-registry (1.9).
 *
 * dependencies: [] — D161: модули не импортируют друг друга; Turn Engine
 * получает AiDirectorService инъекцией через wiring (apps/server).
 */

export const GenerateDraftInputSchema = z.object({
  turnId: TurnId,
  /** traceId вызывающей команды (журнал, ai_decisions, события). */
  traceId: z.string().min(1).max(64),
});
export type GenerateDraftInput = z.infer<typeof GenerateDraftInputSchema>;

export const GenerateDraftOutputSchema = z.object({
  turnId: TurnId,
  sessionId: SessionId,
  /** Черновик решения: все item'ы PROPOSED, source='AI' (сохраняет turn engine, 1.8). */
  resolution: TurnResolutionSchema,
});
export type GenerateDraftOutput = z.infer<typeof GenerateDraftOutputSchema>;

export const GetDraftInputSchema = z.object({ turnId: TurnId });
export type GetDraftInput = z.infer<typeof GetDraftInputSchema>;

export const GetDraftOutputSchema = z.object({
  turnId: TurnId,
  found: z.boolean(),
  resolution: TurnResolutionSchema.nullable(),
  /**
   * Последний собранный DirectorContext — из памяти процесса (одна активная
   * сессия, D108). Персистентное хранилище ai_contexts — решение D121,
   * реализуется в промпте 1.9 (gm.inspectAIContext).
   */
  context: DirectorContextSchema.nullable(),
  source: z.enum(['MEMORY', 'TURN_RECORD']).nullable(),
});
export type GetDraftOutput = z.infer<typeof GetDraftOutputSchema>;

export const aiDirectorContract = defineModule({
  moduleId: 'ai-director',
  purpose: 'AI-Директор: сборка DirectorContext и генерация черновика решения хода через TEXT_AI-провайдеров (v3 §V.1)',
  version: '0.1.0',
  commands: {
    generateDraft: { input: GenerateDraftInputSchema, output: GenerateDraftOutputSchema },
  },
  queries: {
    getDraft: { input: GetDraftInputSchema, output: GetDraftOutputSchema },
  },
  // Вызов generateDraft идемпотентен ключом ВЛАДЕЛЬЦА — turn.resolveTurn
  // (`resolve:{turnId}`, B-08/D115): собственный ключ команде не нужен.
  idempotentCommands: [],
  emits: ['AI_DRAFT_PROPOSED', 'AI_GENERATION_FAILED'],
  subscribes: ['GM_NOTE_ADDED'], // D115: НЕ TURN_LOCKED
  ports: ['AIPort'],
  dependencies: [], // D161
  capabilities: ['TEXT_AI'],
});
