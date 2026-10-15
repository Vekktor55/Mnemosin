import { createHash } from 'node:crypto';

import {
  ConflictError,
  CoreError,
  TurnResolutionSchema,
  nowIso,
  type ErrorCode,
  type IdempotencyKey,
  type PlayerId,
  type SessionId,
  type TurnId,
  type TurnResolution,
} from '@mnemosin/contracts';
import {
  newTraceId,
  parseIdempotencyKey,
  resolutionHashOf,
  runCommand,
  appendOutbox,
  createEvent,
  type CommandRunner,
  type JournalService,
  type UnitOfWork,
} from '@mnemosin/core';

import {
  ApproveInputSchema,
  EditAndApproveInputSchema,
  EditAndApproveOutputSchema,
  PendingReviewsInputSchema,
  PendingReviewsOutputSchema,
  RejectInputSchema,
  RejectOutputSchema,
  RetryInputSchema,
  RetryOutputSchema,
  ReviewDecisionOutputSchema,
  type ApproveInput,
  type EditAndApproveInput,
  type EditAndApproveOutput,
  type PendingReviewsInput,
  type PendingReviewsOutput,
  type RejectInput,
  type RejectOutput,
  type RetryInput,
  type RetryOutput,
  type ReviewDecisionOutput,
} from './contract.js';

/**
 * GmReviewService — GM-ревью черновика (промпт 1.8, п.6; D119/B-09).
 *
 * Владелец перехода REVIEW→COMMITTED: approve/reject/retry делегируются
 * Turn Engine через инжектируемый структурный порт TurnEnginePort (модули не
 * импортируют друг друга — D161/D227); editAndApprove сначала сохраняет
 * правку под своим идемпотентным ключом ('editAndApprove'), затем вызывает
 * commitTurn с ПРОИЗВОДНЫМ ключом (PK idempotency_records уникален глобально —
 * одна клиентская ключевая строка не может занять две записи).
 *
 * GM_REVIEW_DECIDED физически пишется в outbox транзакциями turn-команд
 * (атомарно с решением/коммитом); декларативный владелец события — gm-review
 * (EVENT_EMITTERS, контракт модуля), см. D236.
 */

/** Consumer-side порт Turn Engine (D227): структурно совместим с TurnEngine. */
export interface TurnEnginePort {
  commitTurn(input: {
    turnId: TurnId;
    idempotencyKey: IdempotencyKey;
    traceId: string;
    gmDecision?: { gmPlayerId: PlayerId; kind: 'APPROVE' | 'EDIT_AND_APPROVE' };
  }): Promise<{ turnId: TurnId; sessionId: SessionId; version: number; replayed: boolean }>;
  rejectTurn(input: {
    turnId: TurnId;
    reason: string;
    code?: ErrorCode;
    idempotencyKey: IdempotencyKey;
    traceId: string;
    gmDecision?: { gmPlayerId: PlayerId };
  }): Promise<{ turnId: TurnId; sessionId: SessionId; status: string; replayed: boolean }>;
  retryTurn(input: {
    turnId: TurnId;
    idempotencyKey: IdempotencyKey;
    traceId: string;
    gmDecision?: { gmPlayerId: PlayerId };
  }): Promise<{
    turnId: TurnId;
    sessionId: SessionId;
    number: number;
    status: string;
    createdNewTurn: boolean;
    replayed: boolean;
  }>;
}

export interface GmReviewLog {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface GmReviewDeps {
  readonly uow: UnitOfWork;
  readonly guard: CommandRunner;
  readonly journal: JournalService;
  readonly turnEngine: TurnEnginePort;
  readonly logger?: GmReviewLog;
}

export class GmReviewService {
  constructor(private readonly deps: GmReviewDeps) {}

  /** approve → turn.commitTurn c gmDecision (PROPOSED→APPROVED внутри транзакции коммита). */
  async approve(rawInput: ApproveInput): Promise<ReviewDecisionOutput> {
    const input = ApproveInputSchema.parse(rawInput);
    const traceId = input.traceId ?? newTraceId();
    const result = await this.deps.turnEngine.commitTurn({
      turnId: input.turnId,
      idempotencyKey: input.idempotencyKey,
      traceId,
      gmDecision: { gmPlayerId: input.gmPlayerId, kind: 'APPROVE' },
    });
    this.deps.logger?.info(
      { turnId: input.turnId, version: result.version, gmPlayerId: input.gmPlayerId, traceId, event: 'gm_approved' },
      'gm_approved',
    );
    return ReviewDecisionOutputSchema.parse({
      turnId: result.turnId,
      sessionId: result.sessionId,
      version: result.version,
      replayed: result.replayed,
    });
  }

  /** reject → turn.rejectTurn (REVIEW→FAILED + TURN_FAILED + GM_REVIEW_DECIDED). */
  async reject(rawInput: RejectInput): Promise<RejectOutput> {
    const input = RejectInputSchema.parse(rawInput);
    const traceId = input.traceId ?? newTraceId();
    const result = await this.deps.turnEngine.rejectTurn({
      turnId: input.turnId,
      reason: input.reason,
      ...(input.code === undefined ? {} : { code: input.code }),
      idempotencyKey: input.idempotencyKey,
      traceId,
      gmDecision: { gmPlayerId: input.gmPlayerId },
    });
    return RejectOutputSchema.parse({
      turnId: result.turnId,
      sessionId: result.sessionId,
      status: result.status,
      replayed: result.replayed,
    });
  }

  /** retry → turn.retryTurn (REVIEW→OPEN | FAILED→новый ход, D118). */
  async retry(rawInput: RetryInput): Promise<RetryOutput> {
    const input = RetryInputSchema.parse(rawInput);
    const traceId = input.traceId ?? newTraceId();
    const result = await this.deps.turnEngine.retryTurn({
      turnId: input.turnId,
      idempotencyKey: input.idempotencyKey,
      traceId,
      gmDecision: { gmPlayerId: input.gmPlayerId },
    });
    return RetryOutputSchema.parse({
      turnId: result.turnId,
      sessionId: result.sessionId,
      number: result.number,
      status: result.status,
      createdNewTurn: result.createdNewTurn,
      replayed: result.replayed,
    });
  }

  /**
   * editAndApprove (F-3.2, A1.8): проверка baseResolutionHash → 409
   * VERSION_CONFLICT c актуальным resolution в meta при расхождении; при
   * совпадении — сохранение правки (source AI_THEN_GM_EDIT, editedAt, все
   * item'ы EDITED) → approve (commitTurn c производным ключом).
   */
  async editAndApprove(rawInput: EditAndApproveInput): Promise<EditAndApproveOutput> {
    const input = EditAndApproveInputSchema.parse(rawInput);
    const traceId = input.traceId ?? newTraceId();

    // Шаг 1 (идемпотентный, команда 'editAndApprove'): проверка hash + сохранение
    // правки. runCommand разворачивает исходы: replay → прежний результат,
    // in_flight → IDEMPOTENCY_IN_FLIGHT, failed_before → прежний errorCode (D201).
    const step1 = await runCommand(
      this.deps.guard,
      { key: String(input.idempotencyKey), command: 'editAndApprove', sessionId: null, turnId: input.turnId, traceId },
      async (scope) => {
        const turn = await scope.repos.turns.findById(input.turnId);
        if (turn === null) {
          throw new CoreError('CORE_NOT_FOUND', `ход ${input.turnId} не найден`, { entity: 'turn' });
        }
        if (turn.status !== 'REVIEW') {
          throw new CoreError(
            'CORE_INVALID_STATE_TRANSITION',
            `editAndApprove применим только к REVIEW (статус ${turn.status})`,
            { entity: 'turn', from: turn.status, to: 'REVIEW', reason: 'edit_requires_review' },
          );
        }
        const current = turn.resolution;
        if (current === null) {
          throw new ConflictError('CONFLICT', `ход ${input.turnId} в REVIEW без черновика`, {
            reason: 'no_resolution',
          });
        }
        const currentHash = current.resolutionHash ?? resolutionHashOf(current);
        if (input.baseResolutionHash !== currentHash) {
          // A1.8: 409 VERSION_CONFLICT + АКТУАЛЬНЫЙ resolution в meta.
          throw new ConflictError(
            'VERSION_CONFLICT',
            'черновик изменён после начала редактирования — сохраните правку поверх актуальной версии',
            { resolution: current, actualHash: currentHash, baseResolutionHash: input.baseResolutionHash },
          );
        }

        const edited = TurnResolutionSchema.parse(input.editedResolution);
        const at = nowIso();
        const finalResolution: TurnResolution = withFreshHash({
          ...edited,
          // Инварианты записи: принадлежность и база optimistic lock — из текущего
          // черновика; правка GM не может их «перенести» на другой ход/версию.
          turnId: turn.turnId,
          sessionId: turn.sessionId,
          baseVersion: current.baseVersion,
          aiResponseHash: current.aiResponseHash,
          source: 'AI_THEN_GM_EDIT',
          editedAt: at,
          segments: edited.segments.map((segment) => ({ ...segment, status: 'EDITED' as const, editedByGM: true })),
          privateMessages: edited.privateMessages.map((message) => ({
            ...message,
            status: 'EDITED' as const,
            editedByGM: true,
          })),
          proposedEvents: edited.proposedEvents.map((event) => ({ ...event, status: 'EDITED' as const })),
          proposedObjectChanges: edited.proposedObjectChanges.map((change) => ({
            ...change,
            status: 'EDITED' as const,
          })),
          resolutionHash: null,
        });

        await scope.repos.turns.update({ ...turn, resolution: finalResolution, updatedAt: at });
        await this.deps.journal.append(
          {
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            kind: 'gm_decision',
            payload: {
              decision: 'EDIT_AND_APPROVE',
              gmPlayerId: input.gmPlayerId,
              baseResolutionHash: input.baseResolutionHash,
              resolutionHash: finalResolution.resolutionHash,
            },
            traceId,
          },
          scope,
        );
        await appendOutbox(
          [
            createEvent(
              'GM_REVIEW_DECIDED',
              {
                sessionId: turn.sessionId,
                turnId: turn.turnId,
                gmPlayerId: input.gmPlayerId,
                decision: 'EDIT_AND_APPROVE',
              },
              traceId,
            ),
          ],
          scope,
        );
        return {
          turnId: turn.turnId,
          sessionId: turn.sessionId,
          resolutionHash: finalResolution.resolutionHash ?? resolutionHashOf(finalResolution),
        };
      },
    );

    // Коммит — отдельная идемпотентная команда с ПРОИЗВОДНЫМ ключом (D236):
    // повтор editAndApprove → replay обоих шагов → тот же {version}.
    // gmDecision НЕ передаётся: GM_REVIEW_DECIDED{EDIT_AND_APPROVE} и journal
    // 'gm_decision' уже записаны транзакцией шага 1 (иначе событие дублировалось
    // бы — at-least-once допускает повтор доставки, но не два решения GM на ход).
    const commitKey = parseIdempotencyKey(`commit:${sha1Hex(String(input.idempotencyKey))}`);
    const commit = await this.deps.turnEngine.commitTurn({
      turnId: input.turnId,
      idempotencyKey: commitKey,
      traceId,
    });

    return EditAndApproveOutputSchema.parse({
      turnId: input.turnId,
      sessionId: commit.sessionId,
      version: commit.version,
      resolutionHash: step1.value.resolutionHash,
      replayed: step1.replayed && commit.replayed,
    });
  }

  /** Очередь ревью: ходы в REVIEW с черновиками (панель GM, промпт 1.12). */
  async pendingReviews(rawInput: PendingReviewsInput): Promise<PendingReviewsOutput> {
    const input = PendingReviewsInputSchema.parse(rawInput);
    const turns = await this.deps.uow.repos().turns.listBySession(input.sessionId, 200);
    const pending = turns
      .filter((turn) => turn.status === 'REVIEW')
      .map((turn) => ({
        turnId: turn.turnId,
        number: turn.number,
        status: turn.status,
        reviewReadyAt: turn.reviewReadyAt,
        resolution: turn.resolution,
      }));
    return PendingReviewsOutputSchema.parse(pending);
  }
}

/** Пересчёт resolutionHash после нормализации правки (исключая само поле). */
function withFreshHash(resolution: TurnResolution): TurnResolution {
  const parsed = TurnResolutionSchema.parse(resolution);
  return { ...parsed, resolutionHash: resolutionHashOf(parsed) };
}

function sha1Hex(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}
