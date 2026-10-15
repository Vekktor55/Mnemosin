import { readFileSync } from 'node:fs';

import { AIResponseSchema, ProviderError, type AIResponse } from '@mnemosin/contracts';
import type { AIGenerateInput, AIGenerateResult, AIPort } from '@mnemosin/core/domain/ports';

/**
 * ScriptedAI — офлайн-стенд №1 (промпт 1.7, F-7.3).
 *
 * Аналог tools/mock_gemini.js из v1, но на уровне порта: читает фикстуру
 * AI_SCRIPTED_FIXTURE (default tools/fixtures/resolution.ok.json) и возвращает
 * валидный AIResponse. НИКАКИХ внешних вызовов и чтения состояния партии сверх
 * переданного context (детерминизм — основа contract-тестов и приёмки A1.12).
 *
 * Связь со входом (чтобы сценарий приёмки видел «нарратив из фикстуры + вход»):
 *  - маркер `{actionCount}` в narrative заменяется числом действий из context;
 *  - плейсхолдер-playerId `00000000-0000-4000-8000-0000000000NN` в
 *    privateMessages заменяется на playerId из context.characterNames по
 *    индексу (round-robin) — приватные сообщения стенда доставимы в 1.8+.
 *
 * usage — детерминированные псевдозначения: inputTokens = ⌈|JSON(context)|/4⌉.
 */

/** Маркер числа действий в narrative фикстуры. */
export const ACTION_COUNT_MARKER = '{actionCount}';

/** Префикс плейсхолдер-playerId фикстуры (полные id: …-000000000001…006). */
export const PLACEHOLDER_PLAYER_PREFIX = '00000000-0000-4000-8000-';

export const SCRIPTED_MODEL = 'mnemosin-scripted-v1';

export interface ScriptedAIOptions {
  /** Абсолютный или относительный путь к фикстуре (env AI_SCRIPTED_FIXTURE). */
  readonly fixturePath: string;
  /** Default 'scripted' (идентификатор из capabilities.yaml). */
  readonly providerId?: string;
}

export class ScriptedAI implements AIPort {
  readonly providerId: string;
  readonly capability = 'TEXT_AI' as const;

  /** Фикстура валидируется при старте (fail-fast): битый файл не даст серверу подняться. */
  private readonly fixture: AIResponse;

  constructor(options: ScriptedAIOptions) {
    this.providerId = options.providerId ?? 'scripted';
    const raw = readFileSync(options.fixturePath, 'utf8');
    this.fixture = AIResponseSchema.parse(JSON.parse(raw));
  }

  async isAvailable(): Promise<boolean> {
    // Фикстура уже загружена и валидна — стенд доступен всегда (офлайн).
    return true;
  }

  async generate(input: AIGenerateInput): Promise<AIGenerateResult> {
    const startedAt = Date.now();
    if (input.signal?.aborted) {
      throw new ProviderError('PROVIDER_TIMEOUT', 'scripted: генерация отменена до старта', this.providerId, {
        reason: 'aborted',
      });
    }

    const actionCount = input.context.visiblePlayerActions.length;
    const names = input.context.characterNames;

    const response: AIResponse = {
      ...this.fixture,
      narrative: this.fixture.narrative.replaceAll(ACTION_COUNT_MARKER, String(actionCount)),
      privateMessages: this.fixture.privateMessages.map((message, index) => {
        if (!message.playerId.startsWith(PLACEHOLDER_PLAYER_PREFIX) || names.length === 0) return message;
        const remapped = names[index % names.length];
        if (remapped === undefined) return message;
        return { ...message, playerId: remapped.playerId };
      }),
    };

    // Самопроверка схемой заказчика (F-7.4): стенд обязан возвращать валидный ответ.
    const parsed = input.schema.parse(response);

    return {
      response: parsed,
      usage: {
        inputTokens: Math.ceil(JSON.stringify(input.context).length / 4),
        outputTokens: Math.ceil(JSON.stringify(parsed).length / 4),
        model: SCRIPTED_MODEL,
      },
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  }
}
