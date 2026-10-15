import {
  FlagKey,
  ObjectId,
  type Effect,
  type ItemStatus,
  type PlayerId,
  type Scalar,
  type StateMutation,
  type TurnResolution,
} from '@mnemosin/contracts';

/**
 * Применение TurnResolution к GameState (промпт 1.8, п.4).
 *
 * Правила:
 *  - применяются ТОЛЬКО item'ы со статусом APPROVED/EDITED (PROPOSED без
 *    решения GM и REJECTED — не применяются; после коммита применённые
 *    становятся APPLIED, неприменённые PROPOSED — SKIPPED);
 *  - proposedObjectChanges — patch ТОЛЬКО по ключам из allowlist'а
 *    limits.aiMutable.objectStateKeys (F-9.4/F-4.8; `['*']` в этапе 1);
 *  - proposedEvents — в этапе 1 применяется список эффектов, прошедший rules
 *    (проверка — в resolveTurn); DSL-движок появится в 2.1, здесь hook
 *    applyEffects: отображение Effect→StateMutation «passthrough» — что умеет
 *    StateService этапа 1, то применяется, остальное — effects_deferred (журнал);
 *  - proposedWorldStatePatch → WORLD_PATCH (timeOfDay/weather/ambientFlags);
 *  - visualScene → в этапе 1 только журнал (media-модуля нет; событие-заявка —
 *    VISUAL_SCENE_REQUESTED появится с media-director в этапе 2);
 *  - REACH_ENDING → endingState (мутация StateService) + журнал 'ending_reached';
 *    endSession — этап 3;
 *  - segments/privateMessages → доставку выполняет chat-модуль (промпт 1.9)
 *    по подписке на TURN_COMMITTED (D238): движок только помечает APPLIED.
 */

/** Статусы, которые применяются к состоянию. */
export function isApplicable(status: ItemStatus): boolean {
  return status === 'APPROVED' || status === 'EDITED';
}

export interface CommitPlanContext {
  /** Allowlist ключей objectStates (limits.aiMutable.objectStateKeys; ['*'] = все). */
  readonly allowlist: readonly string[];
  /** Активные игроки сессии — survivors по умолчанию для REACH_ENDING (F-4.9). */
  readonly activePlayerIds: readonly PlayerId[];
}

export interface DeferredNote {
  /** Что отложено: вид эффекта или 'VISUAL_SCENE'. */
  readonly kind: string;
  readonly reason: string;
  /** objectId/eventId — для диагностики (в журнал, без значений). */
  readonly subject: string | null;
}

export interface CommitPlan {
  readonly mutations: readonly StateMutation[];
  /** endingId, если применён REACH_ENDING (журнал 'ending_reached'). */
  readonly endingReached: string | null;
  readonly deferred: readonly DeferredNote[];
  /** objectId'ы изменений, применённых полностью или частично. */
  readonly appliedObjectChangeIds: readonly string[];
  /** Отфильтрованные allowlist'ом ключи (журнал/диагностика). */
  readonly skippedObjectKeys: ReadonlyArray<{ objectId: string; keys: readonly string[] }>;
  readonly appliedEventCount: number;
  readonly appliedEffectCount: number;
  readonly appliedSegmentCount: number;
  readonly appliedPrivateMessageCount: number;
  readonly hasVisualScene: boolean;
}

const EMPTY_PLAN: CommitPlan = {
  mutations: [],
  endingReached: null,
  deferred: [],
  appliedObjectChangeIds: [],
  skippedObjectKeys: [],
  appliedEventCount: 0,
  appliedEffectCount: 0,
  appliedSegmentCount: 0,
  appliedPrivateMessageCount: 0,
  hasVisualScene: false,
};

/** Собирает план мутаций из resolution (чистая функция — тестируется без БД). */
export function buildCommitPlan(resolution: TurnResolution, ctx: CommitPlanContext): CommitPlan {
  const mutations: StateMutation[] = [];
  const deferred: DeferredNote[] = [];
  const appliedObjectChangeIds: string[] = [];
  const skippedObjectKeys: Array<{ objectId: string; keys: readonly string[] }> = [];
  let endingReached: string | null = null;
  let appliedEventCount = 0;
  let appliedEffectCount = 0;

  // ── proposedObjectChanges: patch по ключам из allowlist'а (F-9.4) ────────
  for (const change of resolution.proposedObjectChanges) {
    if (!isApplicable(change.status)) continue;
    const entries = Object.entries(change.patch);
    const allowed = entries.filter(([key]) => isKeyAllowed(key, ctx.allowlist));
    const rejected = entries.filter(([key]) => !isKeyAllowed(key, ctx.allowlist)).map(([key]) => key);
    if (rejected.length > 0) {
      skippedObjectKeys.push({ objectId: change.objectId, keys: rejected });
    }
    if (allowed.length > 0) {
      mutations.push({
        kind: 'OBJECT_PATCH',
        objectId: change.objectId,
        patch: Object.fromEntries(allowed) as Record<string, Scalar>,
      });
      appliedObjectChangeIds.push(change.objectId);
    }
  }

  // ── proposedEvents: applyEffects (hook, passthrough в StateService) ──────
  for (const proposed of resolution.proposedEvents) {
    if (!isApplicable(proposed.status)) continue;
    appliedEventCount += 1;
    for (const effect of proposed.effects) {
      const mapped = applyEffects([effect], { ...ctx, eventId: proposed.eventId });
      mutations.push(...mapped.mutations);
      deferred.push(...mapped.deferred);
      appliedEffectCount += mapped.mutations.length;
      if (mapped.endingReached !== null) endingReached = mapped.endingReached;
    }
  }

  // ── proposedWorldStatePatch → WORLD_PATCH ────────────────────────────────
  const patch = resolution.proposedWorldStatePatch;
  const worldPatch: {
    kind: 'WORLD_PATCH';
    timeOfDay?: typeof patch.timeOfDay;
    weather?: string | null;
    ambientFlags?: Record<string, Scalar>;
  } = { kind: 'WORLD_PATCH' };
  let hasWorldPatch = false;
  if (patch.timeOfDay !== undefined) {
    worldPatch.timeOfDay = patch.timeOfDay;
    hasWorldPatch = true;
  }
  if (patch.weather !== undefined) {
    worldPatch.weather = patch.weather;
    hasWorldPatch = true;
  }
  if (patch.ambientFlags !== undefined && Object.keys(patch.ambientFlags).length > 0) {
    worldPatch.ambientFlags = patch.ambientFlags;
    hasWorldPatch = true;
  }
  if (hasWorldPatch) mutations.push(worldPatch);

  return {
    ...EMPTY_PLAN,
    mutations,
    endingReached,
    deferred,
    appliedObjectChangeIds,
    skippedObjectKeys,
    appliedEventCount,
    appliedEffectCount,
    appliedSegmentCount: resolution.segments.filter((segment) => isApplicable(segment.status)).length,
    appliedPrivateMessageCount: resolution.privateMessages.filter((message) => isApplicable(message.status)).length,
    hasVisualScene: resolution.visualScene !== null,
  };
}

/** Ключ разрешён, если allowlist содержит '*' или точное имя ключа. */
export function isKeyAllowed(key: string, allowlist: readonly string[]): boolean {
  return allowlist.includes('*') || allowlist.includes(key);
}

/**
 * Hook applyEffects(effects[], ctx) — этап 1: passthrough-отображение Effect →
 * StateMutation для видов, которые StateService уже умеет; прочие — deferred
 * (журнал 'effects_deferred'), полноценный DSL-движок — промпт 2.1.
 */
export function applyEffects(
  effects: readonly Effect[],
  ctx: CommitPlanContext & { eventId?: string },
): { mutations: StateMutation[]; deferred: DeferredNote[]; endingReached: string | null } {
  const mutations: StateMutation[] = [];
  const deferred: DeferredNote[] = [];
  let endingReached: string | null = null;
  const subject = ctx.eventId ?? null;

  for (const effect of effects) {
    switch (effect.kind) {
      case 'SET_FLAG': {
        const key = FlagKey.safeParse(effect.key);
        if (!key.success) {
          deferred.push({ kind: effect.kind, reason: 'invalid_flag_key', subject });
          break;
        }
        mutations.push({ kind: 'SET_FLAG', key: key.data, value: effect.value, setBy: 'AI_APPROVED' });
        break;
      }
      case 'CHANGE_OBJECT_STATE': {
        const objectId = ObjectId.safeParse(effect.objectId);
        if (!objectId.success) {
          deferred.push({ kind: effect.kind, reason: 'invalid_object_id', subject });
          break;
        }
        const allowed = Object.entries(effect.patch).filter(([key]) => isKeyAllowed(key, ctx.allowlist));
        if (allowed.length === 0) {
          deferred.push({ kind: effect.kind, reason: 'object_key_not_allowed', subject: objectId.data });
          break;
        }
        mutations.push({
          kind: 'OBJECT_PATCH',
          objectId: objectId.data,
          patch: Object.fromEntries(allowed) as Record<string, Scalar>,
        });
        break;
      }
      case 'REVEAL_OBJECT': {
        const objectId = ObjectId.safeParse(effect.objectId);
        if (!objectId.success) {
          deferred.push({ kind: effect.kind, reason: 'invalid_object_id', subject });
          break;
        }
        mutations.push({ kind: 'OBJECT_VISIBLE', objectId: objectId.data, visible: true });
        break;
      }
      case 'GRANT_KNOWLEDGE':
        mutations.push({
          kind: 'GRANT_KNOWLEDGE',
          playerId: effect.playerId,
          key: effect.key,
          value: effect.value,
          source: effect.source,
        });
        break;
      case 'REACH_ENDING':
        // F-4.9: summary/survivors заполняет движок, если AI/GM их не задал.
        mutations.push({
          kind: 'REACH_ENDING',
          endingId: effect.endingId,
          summary: effect.summary ?? `Финал «${effect.endingId}» достигнут по решению Директора.`,
          survivors: effect.survivors ?? [...ctx.activePlayerIds],
        });
        endingReached = effect.endingId;
        break;
      case 'USE_OBJECT':
        deferred.push({ kind: effect.kind, reason: 'no_stage1_state_semantics', subject: effect.objectId });
        break;
      case 'TELEPORT':
        // limits.aiMutable.teleportAllowed=false в этапе 1 — перемещения только moveGroup GM.
        deferred.push({ kind: effect.kind, reason: 'teleport_not_allowed_stage1', subject });
        break;
      case 'EMIT_NARRATIVE':
        deferred.push({ kind: effect.kind, reason: 'chat_delivery_stage2_dsl', subject });
        break;
      case 'REQUEST_MEDIA':
        deferred.push({ kind: effect.kind, reason: 'media_director_stage2', subject });
        break;
      case 'REQUEST_AUDIO':
        deferred.push({ kind: effect.kind, reason: 'audio_director_stage3', subject });
        break;
      case 'GIVE_ITEM':
        deferred.push({ kind: effect.kind, reason: 'inventory_module_absent', subject });
        break;
    }
  }
  return { mutations, deferred, endingReached };
}

/**
 * Финальные статусы item'ов после коммита: применённые → APPLIED,
 * PROPOSED (без решения GM) → SKIPPED, REJECTED/SKIPPED — без изменений.
 */
export function markResolutionApplied(resolution: TurnResolution, plan: CommitPlan): TurnResolution {
  const appliedObjects = new Set(plan.appliedObjectChangeIds);
  const nextStatus = (status: ItemStatus, applied: boolean): ItemStatus => {
    if (status === 'APPLIED' || status === 'REJECTED' || status === 'SKIPPED') return status;
    if (!isApplicable(status)) return 'SKIPPED'; // PROPOSED без решения GM
    return applied ? 'APPLIED' : 'SKIPPED';
  };
  return {
    ...resolution,
    segments: resolution.segments.map((segment) => ({
      ...segment,
      status: nextStatus(segment.status, true), // доставку выполняет chat по TURN_COMMITTED (D238)
    })),
    privateMessages: resolution.privateMessages.map((message) => ({
      ...message,
      status: nextStatus(message.status, true),
    })),
    proposedEvents: resolution.proposedEvents.map((event) => ({
      ...event,
      status: nextStatus(event.status, true),
    })),
    proposedObjectChanges: resolution.proposedObjectChanges.map((change) => ({
      ...change,
      status: nextStatus(change.status, appliedObjects.has(change.objectId)),
    })),
  };
}

/**
 * PROPOSED → APPROVED для всех item'ов (approve в gm-review/commitTurn c
 * gmDecision). EDITED сохраняется как есть; REJECTED/SKIPPED — тоже (решение
 * GM уже зафиксировано).
 */
export function approveAllItems(resolution: TurnResolution): TurnResolution {
  const approve = <T extends { status: ItemStatus }>(item: T): T =>
    item.status === 'PROPOSED' ? ({ ...item, status: 'APPROVED' } as T) : item;
  return {
    ...resolution,
    segments: resolution.segments.map(approve),
    privateMessages: resolution.privateMessages.map(approve),
    proposedEvents: resolution.proposedEvents.map(approve),
    proposedObjectChanges: resolution.proposedObjectChanges.map(approve),
  };
}
