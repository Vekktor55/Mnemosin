import {
  AppError,
  CoreError,
  ProviderError,
  TurnResolutionSchema,
  nowIso,
  plusMs,
  type ErrorCode,
  type GameState,
  type IdempotencyRecord,
  type JournalKind,
  type PlayerAction,
  type RuleResult,
  type RuleSubject,
  type SessionId,
  type TurnId,
  type TurnResolution,
} from '@mnemosin/contracts';
import {
  appendOutbox,
  createEvent,
  newTraceId,
  parseIdempotencyKey,
  resolutionHashOf,
  sha256Hex,
  type TxScope,
} from '@mnemosin/core';

import {
  ResolveTurnInputSchema,
  ResolveTurnOutputSchema,
  type ResolveTurnInput,
  type ResolveTurnOutput,
} from './contract.js';
import type { TurnEngineDeps } from './deps.js';

/**
 * resolveTurn — шаги v3 §III.1 с поправками аудита (промпт 1.8, п.2).
 *
 * Порядок:
 *   1) загрузка turn/session/actions/state;  2) проверка status===LOCKED;
 *   3) идемпотентность `resolve:{turnId}` — детерминированный СЕРВЕРНЫЙ ключ (B-08);
 *   4) транзакция №1: → PROCESSING + journal 'processing_started' + outbox
 *      TURN_PROCESSING_STARTED;
 *   5) ПОСЛЕ commit транзакции — ai-director.generateDraft КОМАНДОЙ (D115);
 *   6) RulesPort.evaluate по всем subject;  7) REJECT → FAILED + TURN_FAILED
 *      {CORE_RULE_REJECTED}; SOFT_REJECT/WARN → diagnostics + requiresGM=true;
 *   8) транзакция №2: сохранение TurnResolution + → REVIEW + reviewReadyAt +
 *      journal 'draft_ready' + outbox TURN_DRAFT_READY + AI_DRAFT_PROPOSED;
 *   9) ProviderError/AI_GENERATION_FAILED → FAILED + journal 'ai_call_failed' +
 *      TURN_FAILED{errorCode}, GM может retryTurn;  10) метрики turn.duration_ms
 *      (ai.duration_ms пишет ai-director, промпт 1.7).
 * resolveTurn НЕ применяет состояние и НЕ коммитит (v3 §III.1).
 *
 * D234: идемпотентность — РУЧНАЯ оркестрация записи (tryAcquire/finish/fail/
 * release через порт IdempotencyRepository), а не CommandRunner.run: тот держит
 * ОДНУ транзакцию вокруг всей работы, а AI-вызов строго ВНЕ db.transaction
 * (общее правило 1.8). Семантика сохранена: конкурентный повтор → IN_FLIGHT,
 * успешный повтор → прежний результат (B-08.4), перманентный отказ (rules) →
 * failed_before (D201), временный → release, повтор разрешён.
 */

const RESOLVE_TTL_MS_DEFAULT = 24 * 60 * 60 * 1000;

export async function resolveTurn(deps: TurnEngineDeps, rawInput: ResolveTurnInput): Promise<ResolveTurnOutput> {
  const input = ResolveTurnInputSchema.parse(rawInput);
  const traceId = input.traceId ?? newTraceId();
  const startedAt = Date.now();
  const { turnId } = input;

  // 1) Предзагрузка хода — sessionId нужен для записи идемпотентности.
  const turn0 = await deps.uow.repos().turns.findById(turnId);
  if (turn0 === null) {
    throw new CoreError('CORE_NOT_FOUND', `ход ${turnId} не найден`, { entity: 'turn', turnId });
  }
  const sessionId = turn0.sessionId;

  // 3) Детерминированный серверный ключ `resolve:{turnId}` (B-08) — НЕ случайный uuid.
  const key = parseIdempotencyKey(`resolve:${turnId}`);
  const createdAt = nowIso();
  const record: IdempotencyRecord = {
    key,
    turnId,
    sessionId,
    command: 'resolveTurn',
    status: 'IN_FLIGHT',
    resultJson: null,
    resultHash: sha256Hex(''),
    errorCode: null,
    traceId: traceId.slice(0, 64),
    createdAt,
    expiresAt: plusMs(createdAt, deps.idempotencyTtlMs ?? RESOLVE_TTL_MS_DEFAULT),
  };
  const acquired = await deps.uow.repos().idempotency.tryAcquire(record);
  switch (acquired.kind) {
    case 'cached': {
      const cached = ResolveTurnOutputSchema.parse(JSON.parse(acquired.resultJson));
      return { ...cached, replayed: true };
    }
    case 'in_flight':
      throw new AppError('IDEMPOTENCY_IN_FLIGHT', `resolveTurn для хода ${turnId} уже выполняется`, {
        command: 'resolveTurn',
      });
    case 'failed_before':
      throw new AppError(
        acquired.errorCode,
        `resolveTurn уже отклонён (${acquired.errorCode}); повтор не выполняется (D201)`,
        { command: 'resolveTurn' },
      );
    case 'proceed':
      break;
  }

  /** Временный отказ: запись освобождается, повтор разрешён (D201/D234). */
  const releaseKey = async (): Promise<void> => {
    try {
      await deps.uow.repos().idempotency.release(key);
    } catch (cause) {
      deps.logger?.error({ err: cause, turnId, event: 'idempotency_release_failed' }, 'idempotency_release_failed');
    }
  };

  let permanentRecorded = false;
  try {
    // 1–2, 4) Транзакция №1: валидация LOCKED → PROCESSING + журнал + outbox.
    const loaded = await deps.uow.runInTx(async (scope) => {
      const turn = await turnIn(scope, turnId);
      if (turn.status !== 'LOCKED') {
        throw new CoreError(
          'CORE_INVALID_STATE_TRANSITION',
          `resolveTurn применим только к LOCKED-ходу (фактический статус ${turn.status})`,
          { entity: 'turn', from: turn.status, to: 'PROCESSING', reason: 'resolve_requires_locked' },
        );
      }
      const session = await scope.repos.sessions.findById(sessionId);
      if (session === null) {
        throw new CoreError('CORE_NOT_FOUND', `сессия ${sessionId} не найдена`, { entity: 'session' });
      }
      const state = await scope.repos.state.findBySession(sessionId);
      if (state === null) {
        throw new CoreError('CORE_NOT_FOUND', `состояние сессии ${sessionId} не найдено`, { entity: 'game_state' });
      }
      const actions = (await scope.repos.actions.listByTurn(turnId)).sort((a, b) => a.sequenceId - b.sequenceId);

      // transition присоединяется к транзакции через ALS: статус (CAS) +
      // processingStartedAt + journal 'processing_started' (D223).
      await deps.services.turns.transition({ turnId, trigger: 'startProcessing', traceId });
      await appendOutbox([createEvent('TURN_PROCESSING_STARTED', { sessionId, turnId }, traceId)], scope);
      return { state, actions };
    });

    // 5) AI-вызов — СТРОГО вне транзакции, командой (D115).
    await journal(deps, sessionId, turnId, 'ai_call_started', traceId);
    let draft: TurnResolution;
    try {
      const generated = await deps.aiDirector.generateDraft({ turnId, traceId });
      draft = generated.resolution;
      await journal(deps, sessionId, turnId, 'ai_call_finished', traceId, {
        providerId: draft.diagnostics.providerId,
        durationMs: draft.diagnostics.durationMs,
      });
    } catch (cause) {
      // 9) Сбой провайдера → FAILED + journal 'ai_call_failed' + TURN_FAILED{errorCode}.
      const code = providerCodeOf(cause);
      const message = truncate(cause instanceof Error ? cause.message : String(cause), 500);
      await failTurn(deps, { turnId, sessionId, code, message, journalKind: 'ai_call_failed', traceId });
      await releaseKey();
      deps.metrics?.timing('turn.duration_ms', Date.now() - startedAt, { outcome: 'ai_failed' });
      throw cause instanceof Error ? cause : new AppError(code, message, { turnId });
    }

    // 6) Rules Engine: subject'ы — действия, изменения объектов, события.
    const rulesCtx = { sessionId, turnId, state: loaded.state, actions: loaded.actions };
    const evaluated = await evaluateRules(deps, rulesCtx, draft);
    await journal(deps, sessionId, turnId, 'rules_evaluated', traceId, {
      rejects: evaluated.rejects.length,
      softRejects: evaluated.softRejects.length,
      warnings: evaluated.warnings.length,
    });

    // 7) Любой REJECT → FAILED + TURN_FAILED{CORE_RULE_REJECTED} (перманентно, D201).
    if (evaluated.rejects.length > 0) {
      const message = truncate(
        `правила отклонили ход: ${evaluated.rejects.map((r) => `${r.checkId}: ${r.message ?? 'REJECT'}`).join('; ')}`,
        500,
      );
      await failTurn(deps, { turnId, sessionId, code: 'CORE_RULE_REJECTED', message, journalKind: 'failed', traceId });
      await deps.uow.repos().idempotency.fail({
        key,
        errorCode: 'CORE_RULE_REJECTED',
        resultHash: sha256Hex(JSON.stringify({ code: 'CORE_RULE_REJECTED' })),
      });
      permanentRecorded = true;
      deps.metrics?.timing('turn.duration_ms', Date.now() - startedAt, { outcome: 'rejected' });
      throw new CoreError('CORE_RULE_REJECTED', message, {
        entity: 'turn',
        turnId,
        rejects: evaluated.rejects.map((r) => r.checkId),
      });
    }

    // SOFT_REJECT/WARN → diagnostics + requiresGM (ход всё равно уходит в REVIEW).
    const requiresGM = evaluated.softRejects.length > 0 || evaluated.warnings.some((warning) => warning.requiresGM);
    const finalResolution: TurnResolution = TurnResolutionSchema.parse({
      ...draft,
      proposedEvents: draft.proposedEvents.map((event) => ({
        ...event,
        ruleResults: evaluated.byEvent.get(event.eventId) ?? event.ruleResults,
      })),
      proposedObjectChanges: draft.proposedObjectChanges.map((change) => ({
        ...change,
        ruleResults: evaluated.byObject.get(change.objectId) ?? change.ruleResults,
      })),
      diagnostics: {
        ...draft.diagnostics,
        softRejects: evaluated.softRejects,
        warnings: evaluated.warnings,
        requiresGM,
      },
    });
    const resolutionHash = resolutionHashOf(finalResolution);
    const stored: TurnResolution = { ...finalResolution, resolutionHash };

    // 8) Транзакция №2: черновик → REVIEW + reviewReadyAt + журнал + outbox.
    await deps.uow.runInTx(async (scope) => {
      const turn = await turnIn(scope, turnId);
      if (turn.status !== 'PROCESSING') {
        // Например, GM отменил ход во время AI-вызова — черновик не сохраняется.
        throw new CoreError(
          'CORE_INVALID_STATE_TRANSITION',
          `черновик сохраняется только в PROCESSING (фактический статус ${turn.status})`,
          { entity: 'turn', from: turn.status, to: 'REVIEW', reason: 'draft_requires_processing' },
        );
      }
      await deps.services.turns.transition({ turnId, trigger: 'draftReady', traceId });
      const stamped = await turnIn(scope, turnId);
      await scope.repos.turns.update({ ...stamped, resolution: stored, updatedAt: nowIso() });
      await appendOutbox(
        [
          createEvent('TURN_DRAFT_READY', { sessionId, turnId }, traceId),
          createEvent(
            'AI_DRAFT_PROPOSED',
            { sessionId, turnId, proposalHash: stored.aiResponseHash ?? resolutionHash },
            traceId,
          ),
        ],
        scope,
      );
    });

    const output = ResolveTurnOutputSchema.parse({
      turnId,
      sessionId,
      status: 'REVIEW',
      resolutionHash,
      requiresGM,
      replayed: false,
    });
    await deps.uow.repos().idempotency.finish({
      key,
      resultJson: JSON.stringify(output),
      resultHash: sha256Hex(JSON.stringify(output)),
    });
    deps.metrics?.timing('turn.duration_ms', Date.now() - startedAt, { outcome: 'review' });
    deps.logger?.info({ turnId, sessionId, requiresGM, traceId, event: 'turn_resolved' }, 'turn_resolved');
    return output;
  } catch (error) {
    // Временные ошибки: запись освобождается, повтор разрешён. Перманентный отказ
    // (rules) уже зафиксирован fail() — его запись трогать нельзя.
    if (!permanentRecorded) await releaseKey();
    deps.metrics?.counter('turn.resolve_failed_total', 1, { code: codeOf(error) });
    throw error;
  }
}

// ------------------------------------------------------------------ хелперы

/** Переход в FAILED + журнал + outbox TURN_FAILED — одной транзакцией. */
async function failTurn(
  deps: TurnEngineDeps,
  input: {
    turnId: TurnId;
    sessionId: SessionId;
    code: ErrorCode;
    message: string;
    journalKind: Extract<JournalKind, 'ai_call_failed' | 'failed'>;
    traceId: string;
  },
): Promise<void> {
  await deps.uow.runInTx(async (scope) => {
    await deps.services.turns.transition({
      turnId: input.turnId,
      trigger: 'processingFailed',
      failed: { code: input.code, message: input.message, meta: {} },
      traceId: input.traceId,
    });
    await deps.services.journal.append(
      {
        sessionId: input.sessionId,
        turnId: input.turnId,
        kind: input.journalKind,
        payload: { errorCode: input.code, message: input.message },
        traceId: input.traceId,
      },
      scope,
    );
    await appendOutbox(
      [
        createEvent(
          'TURN_FAILED',
          { sessionId: input.sessionId, turnId: input.turnId, errorCode: input.code, message: input.message },
          input.traceId,
        ),
      ],
      scope,
    );
  });
}

interface EvaluatedRules {
  readonly rejects: RuleResult[];
  readonly softRejects: RuleResult[];
  readonly warnings: RuleResult[];
  readonly byEvent: Map<string, RuleResult[]>;
  readonly byObject: Map<string, RuleResult[]>;
}

/** 6) RulesPort.evaluate по всем subject: действия, objectChanges, события. */
async function evaluateRules(
  deps: TurnEngineDeps,
  ctx: { sessionId: SessionId; turnId: TurnId; state: GameState; actions: readonly PlayerAction[] },
  draft: TurnResolution,
): Promise<EvaluatedRules> {
  const rejects: RuleResult[] = [];
  const softRejects: RuleResult[] = [];
  const warnings: RuleResult[] = [];
  const byEvent = new Map<string, RuleResult[]>();
  const byObject = new Map<string, RuleResult[]>();

  const collect = (results: RuleResult[]): void => {
    for (const result of results) {
      if (result.outcome === 'REJECT') rejects.push(result);
      else if (result.outcome === 'SOFT_REJECT') softRejects.push(result);
      else if (result.outcome === 'WARN') warnings.push(result);
    }
  };

  for (const action of ctx.actions) {
    const subject: RuleSubject = {
      kind: 'ACTION',
      actionId: action.actionId,
      playerId: action.playerId,
      intent: action.meta.intent,
      targetObjectId: action.meta.targetObjectId,
      rawText: action.rawText,
    };
    collect(await deps.rules.evaluate(subject, ctx));
  }
  for (const change of draft.proposedObjectChanges) {
    const subject: RuleSubject = {
      kind: 'OBJECT_CHANGE',
      objectId: change.objectId,
      patchKeys: Object.keys(change.patch),
    };
    const results = await deps.rules.evaluate(subject, ctx);
    byObject.set(change.objectId, [...(byObject.get(change.objectId) ?? []), ...results]);
    collect(results);
  }
  for (const event of draft.proposedEvents) {
    const subject: RuleSubject = { kind: 'EVENT_TRIGGER', eventId: event.eventId };
    const results = await deps.rules.evaluate(subject, ctx);
    byEvent.set(event.eventId, [...(byEvent.get(event.eventId) ?? []), ...results]);
    collect(results);
  }
  return { rejects, softRejects, warnings, byEvent, byObject };
}

function providerCodeOf(cause: unknown): ErrorCode {
  if (cause instanceof ProviderError) {
    // Исчерпание цепочки ai-director отдаёт как PROVIDER_UNAVAILABLE c корнем
    // в meta.failures (промпт 1.7). В TURN_FAILED уходит КОРНЕВОЙ код провайдера
    // (PROVIDER_TIMEOUT и т.п.) — он же в AI_GENERATION_FAILED (промпт 1.8, п.9).
    if (cause.code === 'PROVIDER_UNAVAILABLE') {
      const failures = (cause.meta as { failures?: ReadonlyArray<{ code?: unknown }> }).failures;
      const last = Array.isArray(failures) ? failures.at(-1)?.code : undefined;
      if (typeof last === 'string' && last.startsWith('PROVIDER_')) return last as ErrorCode;
    }
    return cause.code;
  }
  const code = (cause as { code?: unknown })?.code;
  if (typeof code === 'string' && code.startsWith('PROVIDER_')) return code as ErrorCode;
  return 'INTERNAL';
}

function codeOf(cause: unknown): string {
  const code = (cause as { code?: unknown })?.code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

async function turnIn(scope: TxScope, turnId: TurnId) {
  const turn = await scope.repos.turns.findById(turnId);
  if (turn === null) {
    throw new CoreError('CORE_NOT_FOUND', `ход ${turnId} не найден`, { entity: 'turn', turnId });
  }
  return turn;
}

async function journal(
  deps: TurnEngineDeps,
  sessionId: SessionId,
  turnId: TurnId,
  kind: Extract<JournalKind, 'ai_call_started' | 'ai_call_finished' | 'rules_evaluated'>,
  traceId: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  // Вне транзакции (одиночная запись): диагностика не должна держать блокировку.
  await deps.services.journal.append({ sessionId, turnId, kind, payload, traceId });
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
