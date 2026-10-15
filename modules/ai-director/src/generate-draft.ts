import { createHash, randomUUID } from 'node:crypto';

import {
  AIResponseSchema,
  DirectorContextSchema,
  EventId,
  ProviderError,
  TurnResolutionSchema,
  nowIso,
  type AIResponse,
  type AiUsage,
  type DirectorContext,
  type DomainEvent,
  type ErrorCode,
  type SessionId,
  type TurnId,
  type TurnResolution,
} from '@mnemosin/contracts';
import type { AIPort, EventBus, MetricsSink, UnitOfWork } from '@mnemosin/core';

import {
  GenerateDraftInputSchema,
  GenerateDraftOutputSchema,
  GetDraftInputSchema,
  GetDraftOutputSchema,
  type GenerateDraftInput,
  type GenerateDraftOutput,
  type GetDraftInput,
  type GetDraftOutput,
} from './contract.js';
import { buildDirectorContext } from './context.js';

/**
 * AiDirectorService — генерация черновика решения хода (промпт 1.7, п.7).
 *
 * Поток: buildDirectorContext → registry.resolve('TEXT_AI') → для каждого
 * провайдера цепочки withPolicy(generate) → AIResponseSchema.parse → при
 * PROVIDER_SCHEMA одна попытка repair (повторный вызов с дополненными
 * directorInstructions) → TurnResolution (все item'ы PROPOSED) → ai_decisions
 * → AI_DRAFT_PROPOSED. При исчерпании цепочки — AI_GENERATION_FAILED и
 * ProviderError('PROVIDER_UNAVAILABLE') (в 1.8 turn engine превратит его
 * в TURN_FAILED{errorCode} — коды таксономии ErrorCode, инвариант 18).
 *
 * D115/B-09: сервис вызывается КОМАНДОЙ из Turn Engine (resolveTurn, промпт 1.8)
 * под его идемпотентным ключом `resolve:{turnId}` — собственного ключа нет.
 * Долгий AI-вызов — СТРОГО вне db.transaction (общее правило этапа 1).
 *
 * D227: модуль НЕ импортирует infrastructure/ai — registry инжектируется через
 * consumer-side интерфейс AIProviderRegistry (структурно совместим с
 * CapabilityRegistry); AIPort — из портов core. Wiring — apps/server (D161).
 */

/** Контекст одной попытки, как в CapabilityRegistry.withPolicy (F-7.2). */
export interface PolicyAttemptContext {
  readonly attempt: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/** Consumer-side интерфейс реестра провайдеров (D227): модуль знает порт, не реализацию. */
export interface AIProviderRegistry {
  resolve(capability: 'TEXT_AI'): Promise<AIPort[]>;
  withPolicy<T>(providerId: string, fn: (ctx: PolicyAttemptContext) => Promise<T>): Promise<T>;
}

export interface AiDirectorLog {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export interface AiDirectorDeps {
  readonly uow: UnitOfWork;
  readonly registry: AIProviderRegistry;
  readonly bus: EventBus;
  readonly metrics?: MetricsSink;
  readonly logger?: AiDirectorLog;
  /** Базовые указания Директору из config (limits.aiDirectorInstructions). */
  readonly directorInstructions: string;
  /** default 1 (limits.aiSchemaRepairAttempts): одна попытка repair на провайдера. */
  readonly schemaRepairAttempts?: number;
}

interface DraftCacheEntry {
  readonly context: DirectorContext;
  readonly resolution: TurnResolution;
  readonly cachedAt: string;
}

interface ProviderCallResult {
  readonly response: AIResponse;
  readonly usage: AiUsage | null;
  readonly durationMs: number;
  readonly attempts: number;
  readonly repairsUsed: number;
}

/** narrative ≤6000 → сегменты ≤2000 (NarrativeSegmentSchema). */
const SEGMENT_MAX = 2000;
/** Лимит directorInstructions в схеме — repair-добавка обязана влезть. */
const INSTRUCTIONS_MAX = 6000;
/** Кэш черновиков: одна активная сессия (D108), но держим запас на ретраи. */
const DRAFT_CACHE_MAX = 64;

export class AiDirectorService {
  private readonly deps: AiDirectorDeps;
  private readonly repairBudget: number;
  private readonly drafts = new Map<TurnId, DraftCacheEntry>();

  constructor(deps: AiDirectorDeps) {
    this.deps = deps;
    this.repairBudget = deps.schemaRepairAttempts ?? 1;
  }

  // ---------------------------------------------------------------- команда

  async generateDraft(rawInput: GenerateDraftInput): Promise<GenerateDraftOutput> {
    const input = GenerateDraftInputSchema.parse(rawInput);
    const startedReal = Date.now();

    const built = await buildDirectorContext(
      { uow: this.deps.uow },
      { turnId: input.turnId, directorInstructions: this.deps.directorInstructions },
    );
    const { sessionId } = built.context;

    // D121 (промпт 1.9): последний собранный контекст — в журнал 'ai_context_built'
    // (читает gm.inspectAIContext). Отказ записи не прерывает генерацию.
    await this.appendContextJournal({
      sessionId,
      turnId: input.turnId,
      context: built.context,
      traceId: input.traceId,
    });

    const chain = await this.deps.registry.resolve('TEXT_AI');
    if (chain.length === 0) {
      await this.publishFailure(sessionId, input.turnId, 'PROVIDER_UNAVAILABLE', null, input.traceId);
      throw new ProviderError(
        'PROVIDER_UNAVAILABLE',
        'нет доступных провайдеров TEXT_AI (цепочка пуста: все провайдеры недоступны или breaker OPEN)',
        'capability-registry',
        { turnId: input.turnId },
      );
    }

    const failures: Array<{ providerId: string; code: ErrorCode }> = [];
    let attemptsTotal = 0;

    for (const port of chain) {
      const providerStarted = Date.now();
      try {
        const call = await this.callProvider(port, built.context, input.traceId);
        attemptsTotal += call.attempts;

        const resolution = buildResolution({
          turnId: input.turnId,
          sessionId,
          response: call.response,
          baseVersion: built.baseVersion,
          providerId: port.providerId,
          usage: call.usage,
          attempts: attemptsTotal,
          repairsUsed: call.repairsUsed,
          durationMs: Date.now() - startedReal,
        });

        await this.appendDecision({
          sessionId,
          turnId: input.turnId,
          providerId: port.providerId,
          model: call.usage?.model ?? 'unknown',
          status: 'OK',
          context: built.context,
          response: call.response,
          latencyMs: call.durationMs,
          errorCode: null,
          traceId: input.traceId,
        });
        this.cacheDraft(input.turnId, built.context, resolution);
        this.deps.metrics?.timing('ai.duration_ms', Date.now() - startedReal, { providerId: port.providerId });

        const proposalHash = resolution.aiResponseHash ?? sha256(stableStringify(call.response));
        await this.publish({
          type: 'AI_DRAFT_PROPOSED',
          payload: { sessionId, turnId: input.turnId, proposalHash },
          emittedAt: nowIso(),
          traceId: input.traceId,
        });
        this.deps.logger?.info(
          { turnId: input.turnId, providerId: port.providerId, attempts: attemptsTotal, event: 'ai_draft_proposed' },
          'ai_draft_proposed',
        );

        return GenerateDraftOutputSchema.parse({ turnId: input.turnId, sessionId, resolution });
      } catch (cause) {
        if (!(cause instanceof ProviderError)) throw cause; // дефект кода — не деградация провайдера
        attemptsTotal += 1;
        failures.push({ providerId: port.providerId, code: cause.code });
        await this.appendDecision({
          sessionId,
          turnId: input.turnId,
          providerId: port.providerId,
          model: 'unknown',
          status: cause.code === 'PROVIDER_TIMEOUT' ? 'TIMEOUT' : 'FAILED',
          context: built.context,
          response: null,
          latencyMs: Date.now() - providerStarted,
          errorCode: cause.code,
          traceId: input.traceId,
        });
        this.deps.logger?.warn(
          { turnId: input.turnId, providerId: port.providerId, code: cause.code, event: 'ai_provider_failed' },
          'ai_provider_failed',
        );
        // Следующий провайдер цепочки (fallback, v3 §IV.2).
      }
    }

    // Цепочка исчерпана (промпт 1.7, п.7): событие + ошибка с ErrorCode.
    // Примечание D225: текст промта говорит «CoreError('PROVIDER_UNAVAILABLE')»,
    // но CoreError в contracts типизирован CoreErrorCode (без PROVIDER_*);
    // PROVIDER_UNAVAILABLE — код категории provider, поэтому бросается
    // ProviderError (тот же AppError, таксономия едина — инвариант 18).
    const last = failures.at(-1);
    const errorCode: ErrorCode = last?.code ?? 'PROVIDER_UNAVAILABLE';
    await this.publishFailure(sessionId, input.turnId, errorCode, last?.providerId ?? null, input.traceId);
    throw new ProviderError(
      'PROVIDER_UNAVAILABLE',
      `цепочка TEXT_AI исчерпана: ${failures.map((f) => `${f.providerId}(${f.code})`).join(', ')}`,
      last?.providerId ?? 'capability-registry',
      { turnId: input.turnId, failures },
    );
  }

  // ---------------------------------------------------------------- запрос

  async getDraft(rawInput: GetDraftInput): Promise<GetDraftOutput> {
    const input = GetDraftInputSchema.parse(rawInput);
    const cached = this.drafts.get(input.turnId);
    if (cached !== undefined) {
      return GetDraftOutputSchema.parse({
        turnId: input.turnId,
        found: true,
        resolution: cached.resolution,
        context: cached.context,
        source: 'MEMORY',
      });
    }
    // Черновик, сохранённый turn engine (промпт 1.8: turns.resolution_json).
    const turn = await this.deps.uow.repos().turns.findById(input.turnId);
    if (turn !== null && turn.resolution !== null) {
      return GetDraftOutputSchema.parse({
        turnId: input.turnId,
        found: true,
        resolution: turn.resolution,
        context: null,
        source: 'TURN_RECORD',
      });
    }
    return GetDraftOutputSchema.parse({
      turnId: input.turnId,
      found: false,
      resolution: null,
      context: null,
      source: null,
    });
  }

  // ---------------------------------------------------------------- внутреннее

  /**
   * Вызов провайдера под политикой регистра + проверка ответа схемой.
   * При невалидном ответе — repair: ровно `repairBudget` повторных вызовов
   * с добавлением в directorInstructions строки о нарушении схемы и текста
   * ошибки (промпт 1.7, п.7). Исчерпан бюджет → ProviderError('PROVIDER_SCHEMA').
   */
  private async callProvider(port: AIPort, context: DirectorContext, traceId: string): Promise<ProviderCallResult> {
    let currentContext = context;
    let lastIssues: string[] = [];
    let attempts = 0;
    let repairsUsed = 0;

    for (let round = 0; round <= this.repairBudget; round++) {
      if (round > 0) {
        repairsUsed += 1;
        this.deps.metrics?.counter('ai.schema_errors_total', 1, { providerId: port.providerId });
        currentContext = withRepairInstructions(context, lastIssues);
        this.deps.logger?.warn(
          {
            providerId: port.providerId,
            repair: repairsUsed,
            issues: lastIssues.slice(0, 5),
            traceId,
            event: 'ai_schema_repair',
          },
          'ai_schema_repair',
        );
      }
      const contextForCall = currentContext;
      const result = await this.deps.registry.withPolicy(port.providerId, (attemptCtx) =>
        port.generate({
          context: contextForCall,
          schema: AIResponseSchema,
          deadline: { timeoutMs: attemptCtx.timeoutMs, attempt: attemptCtx.attempt },
          signal: attemptCtx.signal,
        }),
      );
      attempts += 1;

      const parsed = AIResponseSchema.safeParse(result.response);
      if (parsed.success) {
        return {
          response: parsed.data,
          usage: result.usage,
          durationMs: result.durationMs,
          attempts,
          repairsUsed,
        };
      }
      lastIssues = parsed.error.issues
        .slice(0, 8)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }

    throw new ProviderError(
      'PROVIDER_SCHEMA',
      `ответ провайдера не соответствует AIResponse (repair-попыток: ${repairsUsed})`,
      port.providerId,
      { issues: lastIssues.slice(0, 5), repairsUsed },
    );
  }

  private cacheDraft(turnId: TurnId, context: DirectorContext, resolution: TurnResolution): void {
    this.drafts.set(turnId, { context, resolution, cachedAt: nowIso() });
    while (this.drafts.size > DRAFT_CACHE_MAX) {
      const oldest = this.drafts.keys().next();
      if (oldest.done === true) break;
      this.drafts.delete(oldest.value);
    }
  }

  /** Журнал вызовов AI (ai_decisions, порт из 1.4). Отказ записи не ломает генерацию. */
  private async appendDecision(input: {
    sessionId: SessionId;
    turnId: TurnId;
    providerId: string;
    model: string;
    status: 'OK' | 'FAILED' | 'TIMEOUT';
    context: DirectorContext;
    response: AIResponse | null;
    latencyMs: number;
    errorCode: string | null;
    traceId: string;
  }): Promise<void> {
    try {
      await this.deps.uow.repos().aiDecisions.append({
        sessionId: input.sessionId,
        turnId: input.turnId,
        providerId: input.providerId,
        model: input.model,
        status: input.status,
        promptHash: sha256(stableStringify(input.context)),
        responseJson: input.response === null ? null : JSON.stringify(input.response),
        violationsCount: 0,
        latencyMs: Math.max(0, Math.round(input.latencyMs)),
        errorCode: input.errorCode,
        traceId: input.traceId,
        createdAt: nowIso(),
      });
    } catch (cause) {
      this.deps.logger?.error(
        { err: cause, turnId: input.turnId, event: 'ai_decision_append_failed' },
        'ai_decision_append_failed',
      );
      this.deps.metrics?.counter('ai.decision_append_failed_total', 1, { providerId: input.providerId });
    }
  }

  /** D121: журнал последнего собранного контекста (best-effort, вне транзакции). */
  private async appendContextJournal(input: {
    sessionId: SessionId;
    turnId: TurnId;
    context: DirectorContext;
    traceId: string;
  }): Promise<void> {
    try {
      await this.deps.uow.repos().journal.append({
        turnId: input.turnId,
        sessionId: input.sessionId,
        traceId: input.traceId.slice(0, 64),
        kind: 'ai_context_built',
        payload: {
          context: input.context as unknown as Record<string, unknown>,
          contextHash: sha256(stableStringify(input.context)),
          tokensEstimate: input.context.tokensEstimate,
        },
        createdAt: nowIso(),
      });
    } catch (cause) {
      this.deps.logger?.error(
        { err: cause, turnId: input.turnId, event: 'ai_context_journal_failed' },
        'ai_context_journal_failed',
      );
    }
  }

  private async publish(event: DomainEvent): Promise<void> {
    const report = await this.deps.bus.publish(event);
    if (report.failed > 0) {
      this.deps.logger?.warn(
        { eventType: event.type, ...report, event: 'event_handlers_failed' },
        'event_handlers_failed',
      );
    }
  }

  private async publishFailure(
    sessionId: SessionId,
    turnId: TurnId,
    errorCode: ErrorCode,
    providerId: string | null,
    traceId: string,
  ): Promise<void> {
    this.deps.metrics?.counter('ai.generation_failed_total', 1, { code: errorCode });
    await this.publish({
      type: 'AI_GENERATION_FAILED',
      payload: { sessionId, turnId, errorCode, providerId },
      emittedAt: nowIso(),
      traceId,
    });
  }
}

// ---------------------------------------------------------------- helpers

/**
 * Repair-контекст: к directorInstructions добавляется строка о нарушении схемы
 * и текст ошибок (промпт 1.7, п.7). Общая длина — в лимите схемы (6000).
 */
export function withRepairInstructions(context: DirectorContext, issues: readonly string[]): DirectorContext {
  const note = `\n\nВНИМАНИЕ: предыдущий ответ нарушил выходную схему AIResponse. Ошибки: ${issues.join('; ')}. Верни ответ, строго соответствующий схеме: narrative (непустая строка), privateMessages/proposedEvents/proposedObjectChanges — массивы, visualSceneDescription — объект или null.`;
  const budget = INSTRUCTIONS_MAX - note.length;
  const base = context.directorInstructions.slice(0, Math.max(0, budget));
  const repaired = { ...context, directorInstructions: `${base}${note}`, tokensEstimate: null };
  const parsed = DirectorContextSchema.safeParse(repaired);
  if (!parsed.success) return { ...context, directorInstructions: `${base}${note}`.slice(0, INSTRUCTIONS_MAX) };
  return parsed.data;
}

export interface BuildResolutionInput {
  readonly turnId: TurnId;
  readonly sessionId: SessionId;
  readonly response: AIResponse;
  readonly baseVersion: number;
  readonly providerId: string;
  readonly usage: AiUsage | null;
  readonly attempts: number;
  readonly repairsUsed: number;
  readonly durationMs: number;
}

/** AIResponse → TurnResolution: все item'ы PROPOSED, source='AI' (промпт 1.7, п.7). */
export function buildResolution(input: BuildResolutionInput): TurnResolution {
  const resolution: TurnResolution = {
    turnId: input.turnId,
    sessionId: input.sessionId,
    source: 'AI',
    aiResponseHash: sha256(stableStringify(input.response)),
    baseVersion: input.baseVersion,
    // Хэш сохранённого resolution считает владелец записи — turn engine (1.8, F-3.2).
    resolutionHash: null,
    segments: chunkNarrative(input.response.narrative).map((text) => ({
      segmentId: randomUUID(),
      text,
      audience: { kind: 'ALL' as const },
      editedByGM: false,
      status: 'PROPOSED' as const,
    })),
    privateMessages: input.response.privateMessages.map((message) => ({
      playerId: message.playerId,
      text: message.text,
      status: 'PROPOSED' as const,
      editedByGM: false,
    })),
    proposedEvents: input.response.proposedEvents.map((proposed) => ({
      // ProposedEventSchema.eventId — небрендированный uuid; resolution хранит
      // EventId (инвариант 17). Конвертация валидацией, не кастом.
      eventId: EventId.parse(proposed.eventId),
      rationale: proposed.rationale,
      effects: proposed.effects,
      status: 'PROPOSED' as const,
      ruleResults: [],
      gmComment: null,
    })),
    proposedObjectChanges: input.response.proposedObjectChanges.map((change) => ({
      objectId: change.objectId,
      patch: change.patch,
      rationale: change.rationale,
      status: 'PROPOSED' as const,
      ruleResults: [],
      gmComment: null,
    })),
    proposedWorldStatePatch: {},
    visualScene: input.response.visualSceneDescription,
    diagnostics: {
      providerId: input.providerId,
      model: input.usage?.model ?? null,
      attempts: input.attempts,
      schemaRepairAttempts: input.repairsUsed,
      usage: input.usage,
      // costUsd: null — цены неизвестны (UNKNOWN#5); cost model — этап 2 (2.8).
      costUsd: null,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      softRejects: [],
      warnings: [],
      violations: [],
      requiresGM: false,
    },
    createdAt: nowIso(),
    editedAt: null,
  };
  return TurnResolutionSchema.parse(resolution);
}

/** narrative (≤6000) → сегменты ≤2000: границы абзацев, затем предложений. */
export function chunkNarrative(narrative: string): string[] {
  const chunks: string[] = [];
  for (const paragraph of splitKeep(narrative, '\n')) {
    if (paragraph.length <= SEGMENT_MAX) {
      if (paragraph.trim().length > 0) chunks.push(paragraph.trim());
      continue;
    }
    for (const sentence of splitKeep(paragraph, '. ')) {
      if (sentence.length <= SEGMENT_MAX) {
        chunks.push(sentence);
        continue;
      }
      // pathological case: one "sentence" longer than the limit — hard split.
      for (let start = 0; start < sentence.length; start += SEGMENT_MAX) {
        chunks.push(sentence.slice(start, start + SEGMENT_MAX));
      }
    }
  }
  // Склеиваем соседние мелкие части, чтобы не плодить сегменты по одному предложению.
  const merged: string[] = [];
  for (const chunk of chunks) {
    const last = merged.at(-1);
    if (last !== undefined && `${last} ${chunk}`.length <= SEGMENT_MAX) {
      merged[merged.length - 1] = `${last} ${chunk}`;
    } else {
      merged.push(chunk);
    }
  }
  const result = merged.map((chunk) => chunk.trim()).filter((chunk) => chunk.length > 0);
  return result.length > 0 ? result : [narrative.slice(0, SEGMENT_MAX)];
}

/** Разбивает по разделителю, сохраняя разделитель у предыдущей части. */
function splitKeep(text: string, separator: string): string[] {
  const parts: string[] = [];
  let rest = text;
  for (;;) {
    const index = rest.indexOf(separator);
    if (index < 0) {
      parts.push(rest);
      break;
    }
    parts.push(rest.slice(0, index + separator.length));
    rest = rest.slice(index + separator.length);
  }
  return parts.filter((part) => part.length > 0);
}

/** Канонический JSON (ключи отсортированы) — хэш стабилен между прогонами (D-требование aiResponseHash). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortDeep(source[key]);
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
