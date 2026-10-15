import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import {
  TurnResolutionSchema,
  type Effect,
  type ItemStatus,
  type ObjectId,
  type PlayerId,
  type TurnResolution,
} from '@mnemosin/contracts';
import {
  approveAllItems,
  applyEffects,
  buildCommitPlan,
  isKeyAllowed,
  markResolutionApplied,
} from '@mnemosin/module-turn';

/**
 * applyResolution (промпт 1.8, п.4) — чистые функции плана коммита:
 * только APPROVED/EDITED item'ы, allowlist ключей objectStates (F-9.4),
 * hook applyEffects (passthrough этапа 1), REACH_ENDING, worldStatePatch,
 * финальные статусы APPLIED/SKIPPED.
 */

const sessionId = randomUUID();
const turnId = randomUUID();
const objectId = randomUUID() as ObjectId;
const playerId = randomUUID() as PlayerId;

function baseResolution(patch: Partial<TurnResolution> = {}): TurnResolution {
  return TurnResolutionSchema.parse({
    turnId,
    sessionId,
    source: 'AI',
    aiResponseHash: 'a'.repeat(64),
    baseVersion: 0,
    resolutionHash: null,
    segments: [],
    privateMessages: [],
    proposedEvents: [],
    proposedObjectChanges: [],
    proposedWorldStatePatch: {},
    visualScene: null,
    diagnostics: { providerId: 'scripted', model: null, attempts: 1, usage: null, costUsd: null, durationMs: 1 },
    createdAt: '2026-10-14T00:00:00.000Z',
    editedAt: null,
    ...patch,
  });
}

const planCtx = { allowlist: ['*'] as readonly string[], activePlayerIds: [playerId] };

describe('buildCommitPlan · статусы item’ов', () => {
  const change = (status: ItemStatus, key = 'locked') => ({
    objectId,
    patch: { [key]: true },
    rationale: 'тест',
    status,
    ruleResults: [],
    gmComment: null,
  });

  it('APPROVED и EDITED применяются; PROPOSED, REJECTED, SKIPPED — нет', () => {
    const resolution = baseResolution({
      proposedObjectChanges: [
        change('APPROVED', 'k1'),
        change('EDITED', 'k2'),
        change('PROPOSED', 'k3'),
        change('REJECTED', 'k4'),
        change('SKIPPED', 'k5'),
      ],
    });
    const plan = buildCommitPlan(resolution, planCtx);
    const patched = plan.mutations.filter((m) => m.kind === 'OBJECT_PATCH');
    expect(patched).toHaveLength(2);
    expect(plan.appliedObjectChangeIds).toHaveLength(2);
  });

  it('allowlist фильтрует ключи patch (F-9.4): разрешённые проходят, остальные — в skippedObjectKeys', () => {
    const resolution = baseResolution({
      proposedObjectChanges: [
        {
          objectId,
          patch: { locked: false, secretCode: '1234', power: true },
          rationale: 'смешанный patch',
          status: 'APPROVED',
          ruleResults: [],
          gmComment: null,
        },
      ],
    });
    const plan = buildCommitPlan(resolution, { ...planCtx, allowlist: ['locked', 'power'] });
    const patch = plan.mutations.find((m) => m.kind === 'OBJECT_PATCH');
    expect(patch?.kind === 'OBJECT_PATCH' ? patch.patch : null).toEqual({ locked: false, power: true });
    expect(plan.skippedObjectKeys).toEqual([{ objectId, keys: ['secretCode'] }]);
  });

  it('полностью отфильтрованное изменение не даёт мутации и помечается SKIPPED', () => {
    const resolution = baseResolution({
      proposedObjectChanges: [
        { ...{ objectId, patch: { secret: 1 }, rationale: 'x', status: 'APPROVED', ruleResults: [], gmComment: null } },
      ],
    });
    const plan = buildCommitPlan(resolution, { ...planCtx, allowlist: ['locked'] });
    expect(plan.mutations).toEqual([]);
    expect(plan.appliedObjectChangeIds).toEqual([]);
    const marked = markResolutionApplied(resolution, plan);
    expect(marked.proposedObjectChanges[0]?.status).toBe('SKIPPED');
  });

  it('isKeyAllowed: «*» разрешает всё, иначе точное совпадение', () => {
    expect(isKeyAllowed('anything', ['*'])).toBe(true);
    expect(isKeyAllowed('locked', ['locked', 'power'])).toBe(true);
    expect(isKeyAllowed('secret', ['locked'])).toBe(false);
  });
});

describe('buildCommitPlan · segments/privateMessages/worldStatePatch', () => {
  it('сегменты и приватные сообщения не дают мутаций (доставка — chat по TURN_COMMITTED, D238), но учитываются', () => {
    const resolution = baseResolution({
      segments: [
        {
          segmentId: randomUUID(),
          text: 'Публичный сегмент',
          audience: { kind: 'ALL' },
          editedByGM: false,
          status: 'APPROVED',
        },
        {
          segmentId: randomUUID(),
          text: 'Сегмент GM',
          audience: { kind: 'GM' },
          editedByGM: false,
          status: 'APPROVED',
        },
      ],
      privateMessages: [{ playerId, text: 'Только тебе', status: 'EDITED', editedByGM: true }],
    });
    const plan = buildCommitPlan(resolution, planCtx);
    expect(plan.mutations).toEqual([]);
    expect(plan.appliedSegmentCount).toBe(2);
    expect(plan.appliedPrivateMessageCount).toBe(1);
  });

  it('proposedWorldStatePatch → WORLD_PATCH; пустой патч мутации не даёт', () => {
    const withPatch = baseResolution({
      proposedWorldStatePatch: { timeOfDay: 'NIGHT', weather: 'дождь', ambientFlags: { alarm: true } },
    });
    const plan = buildCommitPlan(withPatch, planCtx);
    const world = plan.mutations.find((m) => m.kind === 'WORLD_PATCH');
    expect(world).toBeDefined();
    expect(world?.kind === 'WORLD_PATCH' ? world.timeOfDay : null).toBe('NIGHT');

    const empty = buildCommitPlan(baseResolution({ proposedWorldStatePatch: {} }), planCtx);
    expect(empty.mutations).toEqual([]);
  });

  it('visualScene → только флаг для журнала (media-модуля в этапе 1 нет)', () => {
    const resolution = baseResolution({
      visualScene: {
        locationId: randomUUID(),
        mood: 'тревога',
        subjects: ['дверь'],
        style: 'нуар',
        cameraHint: null,
      },
    });
    const plan = buildCommitPlan(resolution, planCtx);
    expect(plan.hasVisualScene).toBe(true);
    expect(plan.mutations).toEqual([]);
  });
});

describe('applyEffects · hook passthrough (этап 1; DSL — 2.1)', () => {
  const effectCtx = { allowlist: ['*'] as readonly string[], activePlayerIds: [playerId] };

  it('SET_FLAG / CHANGE_OBJECT_STATE / REVEAL_OBJECT / GRANT_KNOWLEDGE → мутации StateService', () => {
    const effects: Effect[] = [
      { kind: 'SET_FLAG', key: 'alarm_on', value: true },
      { kind: 'CHANGE_OBJECT_STATE', objectId, patch: { locked: false } },
      { kind: 'REVEAL_OBJECT', objectId },
      { kind: 'GRANT_KNOWLEDGE', playerId, key: 'code_4', value: '4', source: 'DISCOVERED' },
    ];
    const { mutations, deferred } = applyEffects(effects, effectCtx);
    expect(deferred).toEqual([]);
    expect(mutations.map((m) => m.kind)).toEqual(['SET_FLAG', 'OBJECT_PATCH', 'OBJECT_VISIBLE', 'GRANT_KNOWLEDGE']);
    const flag = mutations[0];
    expect(flag?.kind === 'SET_FLAG' ? flag.setBy : null).toBe('AI_APPROVED');
  });

  it('REACH_ENDING → мутация + endingReached; summary/survivors достраивает движок (F-4.9)', () => {
    const { mutations, endingReached } = applyEffects([{ kind: 'REACH_ENDING', endingId: 'end_cold' }], effectCtx);
    expect(endingReached).toBe('end_cold');
    const ending = mutations[0];
    expect(ending?.kind === 'REACH_ENDING' ? ending.survivors : null).toEqual([playerId]);
    expect(ending?.kind === 'REACH_ENDING' ? ending.summary.length > 0 : false).toBe(true);
  });

  it('эффекты вне этапа 1 → deferred с причиной (журнал effects_deferred)', () => {
    const effects: Effect[] = [
      { kind: 'USE_OBJECT', objectId },
      { kind: 'TELEPORT', toLocationId: randomUUID() },
      { kind: 'EMIT_NARRATIVE', text: '…', visibility: 'PUBLIC' },
      { kind: 'REQUEST_MEDIA', sceneHint: 'туман' },
      { kind: 'REQUEST_AUDIO', text: 'гул' },
      { kind: 'GIVE_ITEM', itemSlug: 'keycard' },
    ];
    const { mutations, deferred } = applyEffects(effects, effectCtx);
    expect(mutations).toEqual([]);
    expect(deferred.map((d) => d.reason)).toEqual([
      'no_stage1_state_semantics',
      'teleport_not_allowed_stage1',
      'chat_delivery_stage2_dsl',
      'media_director_stage2',
      'audio_director_stage3',
      'inventory_module_absent',
    ]);
  });

  it('proposedEvents со статусом APPROVED дают мутации эффектов; PROPOSED — игнорируются', () => {
    const eventId = randomUUID();
    const approved = baseResolution({
      proposedEvents: [
        {
          eventId: randomUUID(),
          rationale: 'ok',
          effects: [{ kind: 'SET_FLAG', key: 'door_open', value: true }],
          status: 'APPROVED',
          ruleResults: [],
          gmComment: null,
        },
        {
          eventId,
          rationale: 'не решено',
          effects: [{ kind: 'SET_FLAG', key: 'should_not_apply', value: true }],
          status: 'PROPOSED',
          ruleResults: [],
          gmComment: null,
        },
      ],
    });
    const plan = buildCommitPlan(approved, planCtx);
    expect(plan.appliedEventCount).toBe(1);
    expect(plan.mutations).toHaveLength(1);
    expect(plan.mutations[0]?.kind === 'SET_FLAG' ? plan.mutations[0].key : null).toBe('door_open');
  });
});

describe('approveAllItems / markResolutionApplied · статусный цикл', () => {
  it('approve: PROPOSED→APPROVED, EDITED/REJECTED/SKIPPED не трогает', () => {
    const resolution = baseResolution({
      segments: [
        { segmentId: randomUUID(), text: 'a', audience: { kind: 'ALL' }, editedByGM: false, status: 'PROPOSED' },
        { segmentId: randomUUID(), text: 'b', audience: { kind: 'GM' }, editedByGM: true, status: 'EDITED' },
      ],
      privateMessages: [{ playerId, text: 'c', status: 'PROPOSED', editedByGM: false }],
      proposedObjectChanges: [
        { objectId, patch: { x: 1 }, rationale: 'r', status: 'REJECTED', ruleResults: [], gmComment: 'нет' },
      ],
    });
    const approved = approveAllItems(resolution);
    expect(approved.segments.map((s) => s.status)).toEqual(['APPROVED', 'EDITED']);
    expect(approved.privateMessages[0]?.status).toBe('APPROVED');
    expect(approved.proposedObjectChanges[0]?.status).toBe('REJECTED');
  });

  it('mark: применённые → APPLIED, PROPOSED без решения → SKIPPED, REJECTED остаётся', () => {
    const resolution = baseResolution({
      segments: [
        { segmentId: randomUUID(), text: 'a', audience: { kind: 'ALL' }, editedByGM: false, status: 'APPROVED' },
      ],
      privateMessages: [{ playerId, text: 'c', status: 'PROPOSED', editedByGM: false }],
      proposedObjectChanges: [
        { objectId, patch: { x: 1 }, rationale: 'r', status: 'EDITED', ruleResults: [], gmComment: null },
      ],
    });
    const plan = buildCommitPlan(resolution, planCtx);
    const marked = markResolutionApplied(resolution, plan);
    expect(marked.segments[0]?.status).toBe('APPLIED');
    expect(marked.privateMessages[0]?.status).toBe('SKIPPED');
    expect(marked.proposedObjectChanges[0]?.status).toBe('APPLIED');
    expect(TurnResolutionSchema.safeParse(marked).success).toBe(true);
  });
});
