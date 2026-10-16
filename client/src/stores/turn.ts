import { writable } from 'svelte/store';
import type { DirectorContext, ResolutionSummaryView, TurnResolution, TurnView } from '@mnemosin/contracts';

import type { DescribedError } from '../lib/errors.js';

/** Оптимистично отправленное действие игрока (reconcile — ACTION_ACK / ERROR). */
export interface SubmittedAction {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly rawText: string;
  readonly turnId: string;
  readonly status: 'PENDING' | 'ACKED' | 'FAILED';
  readonly actionId: string | null;
  readonly sequenceId: number | null;
  readonly error: DescribedError | null;
  readonly sentAt: string;
}

/**
 * GM-операция в полёте (SPEC §5: повтор с тем же idempotencyKey безопасен —
 * envelope сохраняется для retry). GM_COMMIT_TURN — БЕЗ оптимизма (v3 §VII.8):
 * статус BUSY до GM_ACTION_ACK/ERROR, состояние хода меняет только серверный
 * TURN_UPDATE/TURN_COMMITTED.
 */
export interface GmOperation {
  readonly requestId: string;
  readonly action: string;
  readonly idempotencyKey: string;
  readonly envelope: { readonly type: string; readonly payload: Record<string, unknown> };
  readonly status: 'BUSY' | 'OK' | 'ERROR';
  readonly error: DescribedError | null;
  readonly startedAt: string;
}

export interface CommittedTurn {
  readonly turnId: string;
  readonly version: number;
  readonly segments: readonly { readonly segmentId: string; readonly text: string }[];
}

export interface TurnState {
  /** Последний TURN_UPDATE — read-only срез текущего хода. */
  readonly turn: TurnView | null;
  /** Отправленные действия текущего хода by requestId. */
  readonly submittedActions: Readonly<Record<string, SubmittedAction>>;
  /** TURN_COMMITTED: публичные сегменты нарратива (SystemFeed). */
  readonly committed: CommittedTurn | null;
  /** TURN_PRIVATE_RESOLUTION by turnId — дедупликация по turnId (D269). */
  readonly privateResolutions: Readonly<Record<string, { readonly turnId: string; readonly text: string }>>;
  readonly failed: { readonly turnId: string; readonly errorCode: string; readonly message: string } | null;
  /** GM: TURN_DRAFT_READY (сводка) и TURN_RESOLUTION_GM (полный черновик). */
  readonly draftSummary: ResolutionSummaryView | null;
  readonly draft: TurnResolution | null;
  /** 409 VERSION_CONFLICT при Edit&Approve: черновик изменён — требуется обновление. */
  readonly draftStale: boolean;
  readonly gmOps: Readonly<Record<string, GmOperation>>;
  /** GM_AI_CONTEXT / POST /gm/inspect/context (Inspect-вкладка). */
  readonly aiContext: DirectorContext | null;
}

export const EMPTY_TURN: TurnState = Object.freeze({
  turn: null,
  submittedActions: {},
  committed: null,
  privateResolutions: {},
  failed: null,
  draftSummary: null,
  draft: null,
  draftStale: false,
  gmOps: {},
  aiContext: null,
});

export const turnStore = writable<TurnState>(EMPTY_TURN);

// ---------------------------------------------------------------- turn views

export function setTurnView(view: TurnView): void {
  turnStore.update((state) => {
    // Новый ход: pendings прежнего хода больше не reconcile'ятся — сброс.
    const isNewTurn = state.turn === null || state.turn.turnId !== view.turnId;
    return Object.freeze({
      ...state,
      turn: view,
      submittedActions: isNewTurn ? {} : state.submittedActions,
      ...(isNewTurn ? { committed: null, failed: null } : {}),
    });
  });
}

export function setTurnFailed(turnId: string, errorCode: string, message: string): void {
  turnStore.update((state) =>
    Object.freeze({
      ...state,
      failed: Object.freeze({ turnId, errorCode, message }),
      // TURN_FAILED — финальный статус хода: обновляем и read-only срез,
      // иначе UI держит устаревший PROCESSING до следующего TURN_UPDATE.
      turn:
        state.turn !== null && state.turn.turnId === turnId
          ? Object.freeze({
              ...state.turn,
              status: 'FAILED' as const,
              failed: Object.freeze({ code: errorCode, message }),
            })
          : state.turn,
    }),
  );
}

export function setCommitted(committed: CommittedTurn): void {
  turnStore.update((state) =>
    Object.freeze({
      ...state,
      committed: Object.freeze(committed),
      // COMMITTED не сопровождается TURN_UPDATE (broadcast идёт только на
      // OPEN/LOCKED/UNLOCKED/PROCESSING) — согласуем read-only срез хода здесь,
      // иначе TurnStatus держит устаревший REVIEW после commit.
      turn:
        state.turn !== null && state.turn.turnId === committed.turnId
          ? Object.freeze({ ...state.turn, status: 'COMMITTED' as const, committedAt: new Date().toISOString() })
          : state.turn,
      // ACKED-действия стали частью истории хода — чистим (FAILED оставляем видимыми).
      submittedActions: Object.freeze(
        Object.fromEntries(Object.entries(state.submittedActions).filter(([, action]) => action.status === 'FAILED')),
      ),
    }),
  );
}

/** D269: TURN_PRIVATE_RESOLUTION дедуплицируется по turnId; true — если новая. */
export function addPrivateResolution(turnId: string, text: string): boolean {
  let isNew = false;
  turnStore.update((state) => {
    if (state.privateResolutions[turnId] !== undefined) return state;
    isNew = true;
    return Object.freeze({
      ...state,
      privateResolutions: Object.freeze({ ...state.privateResolutions, [turnId]: Object.freeze({ turnId, text }) }),
    });
  });
  return isNew;
}

// ------------------------------------------------------- optimistic actions

export function addSubmittedAction(action: SubmittedAction): void {
  turnStore.update((state) =>
    Object.freeze({
      ...state,
      submittedActions: Object.freeze({ ...state.submittedActions, [action.requestId]: action }),
    }),
  );
}

export function ackSubmittedAction(requestId: string, actionId: string, sequenceId: number): void {
  turnStore.update((state) => {
    const existing = state.submittedActions[requestId];
    if (existing === undefined) return state;
    return Object.freeze({
      ...state,
      submittedActions: Object.freeze({
        ...state.submittedActions,
        [requestId]: Object.freeze({ ...existing, status: 'ACKED' as const, actionId, sequenceId, error: null }),
      }),
    });
  });
}

export function failSubmittedAction(requestId: string, error: DescribedError): void {
  turnStore.update((state) => {
    const existing = state.submittedActions[requestId];
    if (existing === undefined) return state;
    return Object.freeze({
      ...state,
      submittedActions: Object.freeze({
        ...state.submittedActions,
        [requestId]: Object.freeze({ ...existing, status: 'FAILED' as const, error }),
      }),
    });
  });
}

/** Откат оптимистичного действия (SPEC §4: при ERROR — откат с причиной). */
export function dropSubmittedAction(requestId: string): void {
  turnStore.update((state) => {
    if (state.submittedActions[requestId] === undefined) return state;
    const next = { ...state.submittedActions };
    delete next[requestId];
    return Object.freeze({ ...state, submittedActions: Object.freeze(next) });
  });
}

// -------------------------------------------------------------------- GM ops

export function addGmOperation(op: GmOperation): void {
  turnStore.update((state) =>
    Object.freeze({ ...state, gmOps: Object.freeze({ ...state.gmOps, [op.requestId]: op }) }),
  );
}

export function updateGmOperation(requestId: string, patch: Partial<GmOperation>): void {
  turnStore.update((state) => {
    const existing = state.gmOps[requestId];
    if (existing === undefined) return state;
    return Object.freeze({
      ...state,
      gmOps: Object.freeze({ ...state.gmOps, [requestId]: Object.freeze({ ...existing, ...patch }) }),
    });
  });
}

export function setDraft(summary: ResolutionSummaryView | null, resolution: TurnResolution | null): void {
  turnStore.update((state) =>
    Object.freeze({
      ...state,
      ...(summary === null ? {} : { draftSummary: summary }),
      ...(resolution === null ? {} : { draft: resolution }),
      draftStale: false,
    }),
  );
}

/** 409 при Edit&Approve: актуальный черновик из meta (SPEC §5) + флаг stale. */
export function setDraftFromConflict(resolution: TurnResolution): void {
  turnStore.update((state) => Object.freeze({ ...state, draft: resolution, draftStale: true }));
}

export function acknowledgeDraftStale(): void {
  turnStore.update((state) => Object.freeze({ ...state, draftStale: false }));
}

export function setAiContext(context: DirectorContext | null): void {
  turnStore.update((state) => Object.freeze({ ...state, aiContext: context }));
}

export function resetTurnStore(): void {
  turnStore.set(EMPTY_TURN);
}
