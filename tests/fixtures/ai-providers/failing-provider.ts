import { z } from 'zod';

import { ProviderError, type AIResponse } from '@mnemosin/contracts';
import type { AIGenerateInput, AIGenerateResult, AIPort } from '@mnemosin/core/domain/ports';

/**
 * FailingAI — офлайн-стенд №3 (промпт 1.7, F-7.3).
 *
 * Стенд отказов: проверяет fallback-цепочку, circuit breaker, repair при
 * PROVIDER_SCHEMA и деградацию CAPABILITY_CHANGED (A1.12/A1.13). Режим —
 * env AI_FAILING_MODE:
 *  - timeout     — ждёт deadline.timeoutMs + 1s (прерывается signal) и бросает
 *                  ProviderError('PROVIDER_TIMEOUT'). На практике первым
 *                  успевает таймаут политики CapabilityRegistry.withPolicy —
 *                  код тот же (F-7.2: источник истины — политика);
 *  - schema      — возвращает заведомо невалидный «JSON» (проверяется схемой
 *                  в ai-director → repair → PROVIDER_SCHEMA);
 *  - rate_limit  — немедленно ProviderError('PROVIDER_RATE_LIMIT');
 *  - unavailable — isAvailable() → false (провайдер исключается из resolve()).
 */

export const FailingModeSchema = z.enum(['timeout', 'schema', 'rate_limit', 'unavailable']);
export type FailingMode = z.infer<typeof FailingModeSchema>;

export interface FailingAIOptions {
  readonly mode: FailingMode;
  /** Default 'failing'. */
  readonly providerId?: string;
}

/**
 * Заведомо невалидный ответ (schema-режим): narrative пуст, privateMessages —
 * строка вместо массива, proposedEvents — число. ai-director обязан поймать это
 * AIResponseSchema.safeParse и уйти в repair/PROVIDER_SCHEMA.
 */
const INVALID_RESPONSE = Object.freeze({
  narrative: '',
  privateMessages: 'это не массив',
  proposedEvents: 42,
  proposedObjectChanges: null,
  visualSceneDescription: 'не объект',
});

export class FailingAI implements AIPort {
  readonly providerId: string;
  readonly capability = 'TEXT_AI' as const;
  readonly mode: FailingMode;

  constructor(options: FailingAIOptions) {
    this.providerId = options.providerId ?? 'failing';
    this.mode = options.mode;
  }

  async isAvailable(): Promise<boolean> {
    return this.mode !== 'unavailable';
  }

  async generate(input: AIGenerateInput): Promise<AIGenerateResult> {
    const startedAt = Date.now();
    switch (this.mode) {
      case 'unavailable':
        throw new ProviderError('PROVIDER_UNAVAILABLE', 'failing: режим unavailable', this.providerId, {
          mode: this.mode,
        });
      case 'rate_limit':
        throw new ProviderError('PROVIDER_RATE_LIMIT', 'failing: режим rate_limit', this.providerId, {
          mode: this.mode,
        });
      case 'schema':
        // Стенд НАМЕРЕННО не проверяет ответ input.schema: смысл режима — отдать
        // невалидные данные и проверить схему заказчика (ai-director, F-7.4).
        return {
          response: INVALID_RESPONSE as unknown as AIResponse,
          usage: null,
          durationMs: Math.max(0, Date.now() - startedAt),
        };
      case 'timeout': {
        const waitMs = input.deadline.timeoutMs + 1000;
        const aborted = await abortableDelay(waitMs, input.signal);
        throw new ProviderError(
          'PROVIDER_TIMEOUT',
          aborted ? `failing: попытка прервана по signal (ожидалось ${waitMs} мс)` : `failing: истекли ${waitMs} мс`,
          this.providerId,
          { mode: this.mode, waitedMs: aborted ? null : waitMs, aborted },
        );
      }
    }
  }
}

/** Ждёт ms; возвращает true, если прервано сигналом (signal respect — A1.12). */
async function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve(true);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
