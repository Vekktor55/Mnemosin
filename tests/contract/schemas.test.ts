import { describe, expect, it } from 'vitest';
import {
  ActionIntent,
  CharacterSchema,
  ERROR_TABLE,
  ExitSchema,
  GameStateSchema,
  IdempotencyRecordSchema,
  IsoDateTime,
  JournalEntrySchema,
  PlayerActionSchema,
  SESSION_TRANSITIONS,
  SessionSchema,
  StatePathSchema,
  TURN_TRANSITIONS,
  TURN_TRANSITION_TABLE,
  TurnResolutionSchema,
  TurnSchema,
  WorldEventSchema,
  id,
  newId,
  parsePath,
  serializePath,
  SessionId,
  PlayerId,
  TurnId,
  LocationId,
  ObjectId,
  EventId,
} from '@mnemosin/contracts';

/**
 * Contract-тесты схем (промпт 1.2, критерий A1.3).
 * Каждый тест — регрессия на конкретный дефект аудита.
 */

const sid = id(SessionId, newId());
const pid = id(PlayerId, newId());
const tid = id(TurnId, newId());
const lid = id(LocationId, newId());
const oid = id(ObjectId, newId());
const eid = id(EventId, newId());
const now = '2026-10-12T10:00:00.000Z';

describe('IsoDateTime (F-1.21)', () => {
  it('принимает UTC с миллисекундами', () => {
    expect(IsoDateTime.safeParse(now).success).toBe(true);
  });
  it('отклоняет offset и формат без миллисекунд', () => {
    expect(IsoDateTime.safeParse('2026-10-12T10:00:00+03:00').success).toBe(false);
    expect(IsoDateTime.safeParse('2026-10-12T10:00:00Z').success).toBe(false);
    expect(IsoDateTime.safeParse('12.10.2026').success).toBe(false);
  });
});

describe('Branded IDs (инвариант 17, F-1.13)', () => {
  it('uuid проходит, произвольная строка — нет', () => {
    expect(SessionId.safeParse(sid).success).toBe(true);
    expect(SessionId.safeParse('not-a-uuid').success).toBe(false);
  });
  it('бренд не спасает от перепутывания на уровне значений, но ловится типом', () => {
    // runtime-проверка: SessionId не принимает PlayerId-значение семантически,
    // но оба uuid — защита обеспечивается типами (проверяется компиляцией).
    expect(SessionId.safeParse(pid).success).toBe(true);
  });
  it('IdempotencyKey: 16–128 символов', () => {
    expect(IdempotencyRecordSchema.shape.key.safeParse('a'.repeat(15)).success).toBe(false);
    expect(IdempotencyRecordSchema.shape.key.safeParse('a'.repeat(16)).success).toBe(true);
    expect(IdempotencyRecordSchema.shape.key.safeParse('a'.repeat(129)).success).toBe(false);
  });
});

describe('StatePath: serialize/parse round-trip (блокер B-03)', () => {
  const paths = [
    { kind: 'WORLD', field: 'timeOfDay' },
    { kind: 'WORLD', field: 'currentLocationId' },
    { kind: 'AMBIENT', key: 'gas_level' },
    { kind: 'FLAG', key: 'mnemosin_name_known' },
    { kind: 'FLAG', key: 'floor0_airlock.group_awake' },
    { kind: 'FLAG', key: 'doll_room.darkness' },
    { kind: 'OBJECT', objectId: oid, key: 'eyesOpen' },
    { kind: 'KNOWLEDGE', playerId: pid, key: 'plaque_read' },
  ] as const;

  it.each(paths)('round-trip: $kind', (raw) => {
    const parsed = StatePathSchema.parse(raw);
    expect(serializePath(parsed)).toBeTruthy();
    expect(parsePath(serializePath(parsed))).toEqual(parsed);
  });

  it('пути из примеров v3 валидны (§III.6, §III.8)', () => {
    // Регексп v3 их не пропускал — это и был блокер B-03.
    expect(() => parsePath('worldState.timeOfDay')).not.toThrow();
    expect(() => parsePath('worldState.currentLocationId')).not.toThrow();
    expect(() => parsePath('storyFlags.doll_room.darkness')).not.toThrow();
    expect(() => parsePath(`objectStates.${oid}.eyesOpen`)).not.toThrow();
  });

  it('отклоняет мусор', () => {
    expect(() => parsePath('gameState.foo')).toThrow();
    expect(() => parsePath('storyFlags.')).toThrow();
    expect(() => parsePath(`objectStates.not-a-uuid.key`)).toThrow();
  });

  it('ключи флагов из реальных данных проходят шаблон (D174)', () => {
    for (const key of ['mnemosin_name_known', 'descent_started', 'floor-1_locker_room.duplicate_photo_found']) {
      expect(StatePathSchema.safeParse({ kind: 'FLAG', key }).success, key).toBe(true);
    }
  });
});

describe('Машины состояний', () => {
  it('Turn: переходы совпадают с таблицей SPEC_STAGE1 §3.2', () => {
    const allowed = new Set(TURN_TRANSITION_TABLE.map((t) => `${t.from}->${t.to}`));
    expect(allowed).toEqual(
      new Set([
        'OPEN->LOCKED',
        'LOCKED->OPEN',
        'LOCKED->PROCESSING',
        'PROCESSING->REVIEW',
        'PROCESSING->FAILED',
        'REVIEW->COMMITTED',
        'REVIEW->FAILED',
        'REVIEW->OPEN',
        'OPEN->FAILED',
      ]),
    );
    for (const row of TURN_TRANSITION_TABLE) {
      expect(TURN_TRANSITIONS[row.from], `${row.from}->${row.to}`).toContain(row.to);
    }
  });

  it('Turn: COMMITTED и FAILED терминальны', () => {
    expect(TURN_TRANSITIONS.COMMITTED).toEqual([]);
    expect(TURN_TRANSITIONS.FAILED).toEqual([]);
  });

  it('Session: LOBBY→ACTIVE→PAUSED→ENDED, ENDED терминален (F-3.5)', () => {
    expect(SESSION_TRANSITIONS.LOBBY).toEqual(['ACTIVE', 'ENDED']);
    expect(SESSION_TRANSITIONS.ACTIVE).toEqual(['PAUSED', 'ENDED']);
    expect(SESSION_TRANSITIONS.PAUSED).toEqual(['ACTIVE', 'ENDED']);
    expect(SESSION_TRANSITIONS.ENDED).toEqual([]);
  });

  it('Session: currentLocationId удалён (F-1.16)', () => {
    expect(Object.keys(SessionSchema.shape)).not.toContain('currentLocationId');
  });

  it('Turn: actionIds удалён (F-1.17), failed структурирован (F-1.18)', () => {
    expect(Object.keys(TurnSchema.shape)).not.toContain('actionIds');
    expect(Object.keys(TurnSchema.shape)).not.toContain('failedReason');
    expect(TurnSchema.shape.failed.isOptional()).toBe(false); // nullable, но не optional
  });
});

describe('Доменные схемы: round-trip и негативные случаи', () => {
  const session = {
    sessionId: sid,
    title: 'Цикл 48',
    status: 'LOBBY',
    playerIds: [pid],
    gmPlayerId: pid,
    currentTurnId: null,
    worldPackId: 'mnemosin-hotel',
    worldPackVersion: '1.0.0',
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  it('Session round-trip', () => {
    const parsed = SessionSchema.parse(session);
    expect(SessionSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it('Session: >12 игроков отклоняется', () => {
    expect(SessionSchema.safeParse({ ...session, playerIds: Array.from({ length: 13 }, () => newId()) }).success).toBe(
      false,
    );
  });

  it('Character: имя задаёт игрок (D157), пустое не принимается', () => {
    const base = { characterId: newId(), sessionId: sid, name: 'Аня', archetype: null, stats: {}, createdAt: now };
    expect(CharacterSchema.parse(base).name).toBe('Аня');
    expect(CharacterSchema.safeParse({ ...base, name: '' }).success).toBe(false);
    expect(CharacterSchema.safeParse({ ...base, name: 'x'.repeat(61) }).success).toBe(false);
  });

  it('PlayerAction: intent — enum (F-4.6)', () => {
    const action = {
      actionId: newId(),
      turnId: tid,
      playerId: pid,
      sequenceId: 1,
      rawText: 'Осматриваю гермодверь.',
      meta: { intent: 'OBSERVE' },
      idempotencyKey: 'a'.repeat(20),
      createdAt: now,
    };
    expect(PlayerActionSchema.parse(action).meta.intent).toBe('OBSERVE');
    expect(PlayerActionSchema.safeParse({ ...action, meta: { intent: 'ПОСМОТРЕТЬ' } }).success).toBe(false);
    expect(ActionIntent.safeParse('USE').success).toBe(true);
  });

  it('GameState: storyFlags ключуется key, а не uuid (B-03)', () => {
    const state = {
      sessionId: sid,
      worldState: { currentLocationId: lid, timeOfDay: 'NIGHT', weather: null, ambientFlags: { gas_level: 'none' } },
      storyFlags: {
        'floor0_airlock.group_awake': {
          flagId: newId(),
          key: 'floor0_airlock.group_awake',
          value: true,
          setAtTurnId: tid,
          setBy: 'ENGINE',
        },
      },
      objectStates: {
        [oid]: {
          objectId: oid,
          locationId: lid,
          state: { eyesOpen: false },
          visible: true,
          taken: false,
          lastChangedAtTurnId: null,
        },
      },
      playerKnowledge: {
        [pid]: {
          playerId: pid,
          entries: [{ key: 'plaque_read', value: true, learnedAtTurnId: tid, source: 'OBSERVED' }],
        },
      },
      endingState: null,
      version: 3,
      updatedAt: now,
    };
    const parsed = GameStateSchema.parse(state);
    expect(Object.keys(parsed.storyFlags)).toEqual(['floor0_airlock.group_awake']);
    expect(parsed.playerKnowledge[pid]?.entries).toHaveLength(1);
  });

  it('ExitSchema: LOCATION без toLocationId отклоняется, DESCRIPTIVE — с ним (K6)', () => {
    const base = { kind: 'LOCATION', label: 'Дверь в Светлый холл', locked: false };
    expect(ExitSchema.safeParse({ ...base, toLocationId: lid }).success).toBe(true);
    expect(ExitSchema.safeParse({ ...base, toLocationId: null }).success).toBe(false);
    expect(ExitSchema.safeParse({ ...base, kind: 'DESCRIPTIVE', toLocationId: lid }).success).toBe(false);
    expect(ExitSchema.safeParse({ ...base, kind: 'DESCRIPTIVE', toLocationId: null }).success).toBe(true);
  });

  it('ExitSchema: label ≤60, description ≤200, поля v1 сохранены (K6)', () => {
    const exit = {
      kind: 'LOCATION',
      toLocationId: lid,
      label: 'Дверь в Светлый холл',
      description: 'Кабина лифта за внутренней гермодверью — единственная кнопка ведёт вниз',
      oneWay: true,
      hidden: false,
      via: 'elevator',
      locked: true,
      lock: {
        type: 'condition',
        keyRequired: null,
        requiresFlag: 'surface_door_forced',
        reason: 'Гермодверь не открывается в течение цикла',
      },
    };
    const parsed = ExitSchema.parse(exit);
    expect(parsed.lock.requiresFlag).toBe('surface_door_forced');
    expect(ExitSchema.safeParse({ ...exit, label: 'x'.repeat(61) }).success).toBe(false);
  });

  it('WorldEvent: priority, conditions[], cascadeDepth, aiGuidance (F-4.2, F-1.6c, K10)', () => {
    const event = {
      eventId: eid,
      sessionId: sid,
      templateSlug: 'evt_lights_out',
      locationId: lid,
      name: 'LIGHTS_OUT',
      category: 'scene',
      priority: 100,
      trigger: { kind: 'ENTER_ROOM', locationId: lid },
      conditions: [{ op: 'FIRST_TIME', scope: 'LOCATION', entityId: lid }],
      effects: [
        { kind: 'SET_FLAG', key: 'floor0_airlock.darkness', value: true },
        { kind: 'EMIT_NARRATIVE', text: 'Свет мигает и гаснет.', visibility: 'PUBLIC' },
        { kind: 'REQUEST_MEDIA', sceneHint: 'doll room, sudden darkness, single flicker' },
      ],
      once: true,
      fired: false,
      firedAtTurnId: null,
      cascadeDepth: 0,
      aiGuidance: { purpose: 'Задать сцену', sequence: ['темнота', 'запах'], mustNotExplain: ['номер цикла'] },
      requiresModule: null,
      tags: ['horror'],
    };
    const parsed = WorldEventSchema.parse(event);
    expect(parsed.priority).toBe(100);
    expect(parsed.conditions).toHaveLength(1);
    expect(parsed.aiGuidance?.sequence).toEqual(['темнота', 'запах']);
  });

  it('FIRST_TIME без entityId отклоняется (F-4.1)', () => {
    expect(
      WorldEventSchema.safeParse({
        eventId: eid,
        sessionId: sid,
        templateSlug: null,
        locationId: lid,
        name: 'X',
        priority: 0,
        trigger: { kind: 'ENTER_ROOM', locationId: lid },
        conditions: [{ op: 'FIRST_TIME', scope: 'LOCATION' }],
        effects: [],
        once: true,
        fired: false,
        firedAtTurnId: null,
        cascadeDepth: 0,
        aiGuidance: null,
        requiresModule: null,
        tags: [],
      }).success,
    ).toBe(false);
  });

  it('TurnResolution: baseVersion и resolutionHash обязательны (B-01, F-3.2)', () => {
    const resolution = {
      turnId: tid,
      sessionId: sid,
      source: 'AI',
      aiResponseHash: 'a'.repeat(64),
      baseVersion: 7,
      resolutionHash: 'b'.repeat(64),
      segments: [],
      privateMessages: [{ playerId: pid, text: 'Ты слышишь шёпот.', status: 'PROPOSED', editedByGM: false }],
      proposedEvents: [],
      proposedObjectChanges: [],
      proposedWorldStatePatch: {},
      visualScene: null,
      diagnostics: {
        providerId: 'scripted',
        model: 'stub',
        attempts: 1,
        schemaRepairAttempts: 0,
        usage: null,
        costUsd: null,
        durationMs: 12,
        softRejects: [],
        warnings: [],
        violations: [],
        requiresGM: false,
      },
      createdAt: now,
      editedAt: null,
    };
    const parsed = TurnResolutionSchema.parse(resolution);
    expect(parsed.baseVersion).toBe(7);
    expect(TurnResolutionSchema.safeParse({ ...resolution, baseVersion: undefined }).success).toBe(false);
  });

  it('IdempotencyRecord: resultJson обязателен для возврата ответа (B-08.4)', () => {
    const record = {
      key: 'k'.repeat(20),
      turnId: tid,
      sessionId: sid,
      command: 'commitTurn',
      status: 'DONE',
      resultJson: '{"version":8}',
      resultHash: 'c'.repeat(64),
      errorCode: null,
      traceId: 'trace-1',
      createdAt: now,
      expiresAt: now,
    };
    expect(IdempotencyRecordSchema.parse(record).resultJson).toBe('{"version":8}');
    expect(IdempotencyRecordSchema.safeParse({ ...record, command: 'finishTurn' }).success).toBe(false);
  });

  it('JournalEntry: kind из enum, traceId обязателен (F-1.10)', () => {
    const entry = {
      id: 1,
      turnId: tid,
      sessionId: sid,
      traceId: 'trace-1',
      kind: 'committed',
      payload: { version: 8 },
      createdAt: now,
    };
    expect(JournalEntrySchema.parse(entry).kind).toBe('committed');
    expect(JournalEntrySchema.safeParse({ ...entry, kind: 'whatever' }).success).toBe(false);
  });
});

describe('Error Taxonomy (инвариант 18, F-6.4)', () => {
  it('у каждого кода есть категория, HTTP и clientAction', () => {
    for (const [code, descriptor] of Object.entries(ERROR_TABLE)) {
      expect(descriptor.http, code).toBeGreaterThanOrEqual(400);
      expect(descriptor.http, code).toBeLessThan(600);
      expect(descriptor.clientAction, code).toBeTruthy();
      expect(descriptor.category, code).toBeTruthy();
      expect(descriptor.note, code).toBeTruthy();
    }
  });
  it('содержит коды, которых не было в v3', () => {
    for (const code of [
      'EVENT_EFFECT_CONFLICT',
      'CAPABILITY_UNAVAILABLE',
      'BUDGET_EXCEEDED',
      'HB_SIGNATURE_INVALID',
      'HB_REPLAY_REJECTED',
      'RECONCILE_INTERRUPTED',
      'WORKPACK_INVALID',
      'CORE_CONDITION_FAILED',
    ]) {
      expect(ERROR_TABLE, code).toHaveProperty(code);
    }
  });
});
