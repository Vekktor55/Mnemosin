import type { z } from 'zod';
import type { AIResponse, AiUsage, DirectorContext } from '@mnemosin/contracts';

/**
 * AIPort — порт TEXT_AI-провайдера (v3 §V.1, §IV.2; патч аудита §8.10; промпт 1.7).
 *
 * Аналог tools/mock_gemini.js из v1, но на уровне порта, а не HTTP: ядро и модули
 * знают ТОЛЬКО этот интерфейс; адаптеры (ScriptedAI/EchoAI/FailingAI в этапе 1,
 * OpenRouter/LM Studio в этапе 2) живут в infrastructure/ai и импортируют порт —
 * ядро не импортирует их никогда (инварианты 1–3, критерий A1.14).
 *
 * Отличие от текста аудита §8.10 (решение D225): класс `ProviderError` здесь НЕ
 * объявляется — он реализован в @mnemosin/contracts (промпт 1.2) с теми же
 * аргументами `(code, message, providerId, meta)` и кодами PROVIDER_TIMEOUT /
 * PROVIDER_RATE_LIMIT / PROVIDER_SCHEMA / PROVIDER_UNAVAILABLE (+ расширенные
 * PROVIDER_AUTH / PROVIDER_BAD_GATEWAY / PROVIDER_BUDGET). Источник истины —
 * contracts (D112): один класс на всю таксономию, дубль в core запрещён.
 *
 * Источник истины для таймаутов и ретраев — НЕ аргументы порта, а политики
 * провайдеров (config/provider-policies.yaml → CapabilityRegistry.withPolicy,
 * F-7.2). `deadline` передаётся регистром, чтобы адаптер мог планировать свою
 * работу (например, стенд `failing` ждёт `timeoutMs + 1s`), но принудительный
 * таймаут и abort выставляет сам регистр.
 */

/** Дедлайн одной попытки: политику даёт Capability Registry (F-7.2). */
export interface AIDeadline {
  /** Таймаут попытки в мс — из ProviderPolicy.timeoutMs, не из аргументов вызова. */
  readonly timeoutMs: number;
  /** Номер попытки, начиная с 1 (ретраи даёт CapabilityRegistry.withPolicy). */
  readonly attempt: number;
}

export interface AIGenerateInput {
  /** Контекст Директора — прошедший DirectorContextSchema.parse (инвариант 16). */
  readonly context: DirectorContext;
  /**
   * Схема ответа (AIResponseSchema из contracts). Провайдер обязан проверить
   * свой результат этой схемой до возврата; заказчик (ai-director) проверяет
   * ответ повторно — доверия к провайдеру нет (F-7.4).
   * Input = unknown: branded-схемы (PlayerId/EventId) парсят небрендированный
   * ввод, `z.ZodType<AIResponse>` такие схемы не принимал бы (TS-вариантность).
   */
  readonly schema: z.ZodType<AIResponse, z.ZodTypeDef, unknown>;
  readonly deadline: AIDeadline;
  /** Сигнал отмены: регистр прерывает попытку по таймауту политики. */
  readonly signal?: AbortSignal;
}

export interface AIGenerateResult {
  readonly response: AIResponse;
  /** F-7.1: без usage cost model не наполнить. null — провайдер не отдал статистику. */
  readonly usage: AiUsage | null;
  readonly durationMs: number;
}

export interface AIPort {
  /** Строковый идентификатор, а не enum (D192): новый провайдер не меняет контракты. */
  readonly providerId: string;
  readonly capability: 'TEXT_AI';

  /**
   * Доступность провайдера БЕЗ боевого вызова (healthProbe регистра, v3 §V.11).
   * Офлайн-стенды: scripted/echo — всегда true; failing — false в режиме
   * `unavailable`. Боевые провайдеры этапа 2 — лёгкий ping/models-запрос.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Генерация решения хода. Ошибки провайдера — ТОЛЬКО ProviderError из
   * @mnemosin/contracts (инвариант 18: границы пересекает ErrorCode):
   * PROVIDER_TIMEOUT, PROVIDER_RATE_LIMIT, PROVIDER_SCHEMA, PROVIDER_UNAVAILABLE,
   * PROVIDER_AUTH, PROVIDER_BAD_GATEWAY, PROVIDER_BUDGET.
   */
  generate(input: AIGenerateInput): Promise<AIGenerateResult>;
}
