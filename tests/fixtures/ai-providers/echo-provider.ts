import { ProviderError, type AIResponse } from '@mnemosin/contracts';
import type { AIGenerateInput, AIGenerateResult, AIPort } from '@mnemosin/core/domain/ports';

/**
 * EchoAI — офлайн-стенд №2 (промпт 1.7, F-7.3).
 *
 * Второй провайдер для проверки fallback-цепочки (A1.12/A1.14): собирает
 * narrative из rawText действий игроков в порядке sequenceId по шаблону
 * «Вы делаете: …». privateMessages / proposedEvents / proposedObjectChanges —
 * пустые, visualSceneDescription — null. НИКАКИХ внешних вызовов.
 */

export const ECHO_MODEL = 'mnemosin-echo-v1';

/** narrative ≤ 6000 (AIResponseSchema): склейка действий обязана влезть. */
const NARRATIVE_MAX = 6000;
const ELLIPSIS = ' …';

export interface EchoAIOptions {
  /** Default 'echo' (идентификатор из capabilities.yaml). */
  readonly providerId?: string;
}

export class EchoAI implements AIPort {
  readonly providerId: string;
  readonly capability = 'TEXT_AI' as const;

  constructor(options: EchoAIOptions = {}) {
    this.providerId = options.providerId ?? 'echo';
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async generate(input: AIGenerateInput): Promise<AIGenerateResult> {
    const startedAt = Date.now();
    if (input.signal?.aborted) {
      throw new ProviderError('PROVIDER_TIMEOUT', 'echo: генерация отменена до старта', this.providerId, {
        reason: 'aborted',
      });
    }

    const actions = [...input.context.visiblePlayerActions].sort((a, b) => a.sequenceId - b.sequenceId);
    const response: AIResponse = {
      narrative: echoNarrative(actions.map((action) => action.rawText)),
      privateMessages: [],
      proposedEvents: [],
      proposedObjectChanges: [],
      visualSceneDescription: null,
    };

    // Самопроверка схемой заказчика (F-7.4).
    const parsed = input.schema.parse(response);

    return {
      response: parsed,
      usage: {
        inputTokens: Math.ceil(JSON.stringify(input.context).length / 4),
        outputTokens: Math.ceil(JSON.stringify(parsed).length / 4),
        model: ECHO_MODEL,
      },
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  }
}

/** «Вы делаете: действие 1; действие 2; …» с обрезкой по лимиту схемы (6000). */
export function echoNarrative(rawTexts: readonly string[]): string {
  const fallback = 'Вы делаете: ничего. В тамбуре слышно только гул вентиляции.';
  const prefix = 'Вы делаете: ';
  const texts = rawTexts.map((raw) => raw.trim()).filter((text) => text.length > 0);
  if (texts.length === 0) return fallback;

  // Резерв: prefix + завершающий символ ('.' или ' …') — narrative обязан влезть в 6000.
  const budget = NARRATIVE_MAX - prefix.length - ELLIPSIS.length;
  const parts: string[] = [];
  let used = 0;
  let truncated = false;
  for (const text of texts) {
    const extra = parts.length === 0 ? text.length : text.length + 2; // «; » между действиями
    if (used + extra > budget) {
      truncated = true;
      break;
    }
    parts.push(text);
    used += extra;
  }
  if (parts.length === 0) return fallback;
  return `${prefix}${parts.join('; ')}${truncated ? ELLIPSIS : '.'}`;
}
