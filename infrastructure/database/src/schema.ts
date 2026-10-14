import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Схема БД Stage 1 (промпт 1.4).
 *
 * ПРИНЦИП ХРАНЕНИЯ (решение D199, см. docs/ARCHITECTURE.md):
 *   строка = «запрашиваемые колонки» (id, FK, статус, версия, время) + `body_json` с ЦЕЛЫМ
 *   агрегатом из @mnemosin/contracts. На чтении body_json прогоняется через Zod-схему.
 *
 * Почему так, а не полная нормализация каждого поля:
 *   1. Контракты — источник истины (D112), а они в Stage 1 менялись 16 раз (K1–K16) и ещё
 *      будут меняться при импорте 42 комнат. Нормализованная схема ломалась бы на каждом
 *      изменении миграцией; body_json — нет.
 *   2. Round-trip становится проверяемым: записали GameState → прочитали → GameStateSchema.parse
 *      даёт глубоко равный объект (тест mappers round-trip, критерий A1.4).
 *   3. Всё, по чему реально идут запросы (session_id, turn_id, status, version, created_at,
 *      idempotency key), — отдельные колонки с индексами; производительность не страдает.
 *   Полная нормализация полей — задача Stage 3 (переезд на Postgres, когда известны запросы).
 *
 * Все FK объявлены через .references() (критерий A1.4: «FK действительно работают» —
 * проверяется тестом на вставку сироты при включённом PRAGMA foreign_keys).
 */

// ───────────────────────────── Сессия и участники ─────────────────────────────

export const sessions = sqliteTable(
  'sessions',
  {
    sessionId: text('session_id').primaryKey(),
    title: text('title').notNull(),
    status: text('status').notNull(), // SessionStatus
    gmPlayerId: text('gm_player_id').notNull(), // FK не ставим: цикл sessions↔players (см. D199a)
    currentTurnId: text('current_turn_id'),
    worldPackId: text('world_pack_id'),
    worldPackVersion: text('world_pack_version'),
    archivedAt: text('archived_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    bodyJson: text('body_json', { mode: 'json' }).notNull(),
  },
  (t) => [index('idx_sessions_status').on(t.status), index('idx_sessions_updated').on(t.updatedAt)],
);

export const players = sqliteTable(
  'players',
  {
    playerId: text('player_id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    characterId: text('character_id').notNull(),
    displayName: text('display_name').notNull(),
    isGm: integer('is_gm', { mode: 'boolean' }).notNull(),
    status: text('status').notNull(), // PlayerStatus
    joinedAt: text('joined_at').notNull(),
    leftAt: text('left_at'),
    bodyJson: text('body_json', { mode: 'json' }).notNull(),
  },
  (t) => [
    index('idx_players_session').on(t.sessionId),
    uniqueIndex('uq_players_session_character').on(t.sessionId, t.characterId),
  ],
);

export const characters = sqliteTable(
  'characters',
  {
    characterId: text('character_id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    archetype: text('archetype'),
    createdAt: text('created_at').notNull(),
    bodyJson: text('body_json', { mode: 'json' }).notNull(),
  },
  (t) => [index('idx_characters_session').on(t.sessionId)],
);

// ───────────────────────────── Ходы и действия ─────────────────────────────

export const turns = sqliteTable(
  'turns',
  {
    turnId: text('turn_id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    status: text('status').notNull(), // TurnStatus
    lockedAt: text('locked_at'),
    processingStartedAt: text('processing_started_at'),
    reviewReadyAt: text('review_ready_at'),
    committedAt: text('committed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    bodyJson: text('body_json', { mode: 'json' }).notNull(),
  },
  (t) => [
    uniqueIndex('uq_turns_session_number').on(t.sessionId, t.number),
    index('idx_turns_session_status').on(t.sessionId, t.status),
  ],
);

export const actions = sqliteTable(
  'actions',
  {
    actionId: text('action_id').primaryKey(),
    turnId: text('turn_id')
      .notNull()
      .references(() => turns.turnId, { onDelete: 'cascade' }),
    playerId: text('player_id')
      .notNull()
      .references(() => players.playerId, { onDelete: 'cascade' }),
    sequenceId: integer('sequence_id').notNull(),
    intent: text('intent'), // ActionIntent | null
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: text('created_at').notNull(),
    bodyJson: text('body_json', { mode: 'json' }).notNull(),
  },
  (t) => [
    uniqueIndex('uq_actions_idempotency').on(t.idempotencyKey),
    uniqueIndex('uq_actions_turn_sequence').on(t.turnId, t.sequenceId),
    index('idx_actions_player').on(t.playerId),
  ],
);

// ───────────────────────────── Состояние мира ─────────────────────────────

export const gameState = sqliteTable('game_state', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => sessions.sessionId, { onDelete: 'cascade' }),
  /** Оптимистичная блокировка (критерий A1.5): UPDATE ... WHERE version = expected. */
  version: integer('version').notNull(),
  currentLocationId: text('current_location_id').notNull(),
  timeOfDay: text('time_of_day').notNull(),
  endingReached: integer('ending_reached', { mode: 'boolean' }).notNull().default(false),
  updatedAt: text('updated_at').notNull(),
  bodyJson: text('body_json', { mode: 'json' }).notNull(),
});

export const stateHistory = sqliteTable(
  'state_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    turnId: text('turn_id'),
    fromVersion: integer('from_version').notNull(),
    toVersion: integer('to_version').notNull(),
    mutationsJson: text('mutations_json', { mode: 'json' }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_state_history_session').on(t.sessionId, t.toVersion)],
);

/**
 * Отдельная строка версии мира — чтобы поднять версию, не переписывая всё состояние.
 * Используется как «часы» для кэшей проекций (Stage 2).
 */
export const worldStateVersion = sqliteTable('world_state_version', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => sessions.sessionId, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const locations = sqliteTable(
  'locations',
  {
    locationId: text('location_id').primaryKey(),
    packId: text('pack_id'),
    templateSlug: text('template_slug'),
    name: text('name').notNull(),
    /** gmSecret НИКОГДА не покидает БД в сторону AI/игрока (K7) — лежит внутри body_json, */
    /** а в broadcast-проекции вырезается (WS_PRIVACY_POLICY, промпт 1.9). */
    exitsCount: integer('exits_count').notNull().default(0),
    objectsCount: integer('objects_count').notNull().default(0),
    hasGmSecret: integer('has_gm_secret', { mode: 'boolean' }).notNull().default(false),
    updatedAt: text('updated_at'),
    bodyJson: text('body_json', { mode: 'json' }).notNull(),
  },
  (t) => [index('idx_locations_pack').on(t.packId)],
);

// ───────────────────────────── Чат и GM ─────────────────────────────

export const chatMessages = sqliteTable(
  'chat_messages',
  {
    messageId: text('message_id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    turnId: text('turn_id'),
    visibility: text('visibility').notNull(), // ChatVisibility
    fromPlayerId: text('from_player_id'),
    toPlayerId: text('to_player_id'),
    createdAt: text('created_at').notNull(),
    bodyJson: text('body_json', { mode: 'json' }).notNull(),
  },
  (t) => [
    index('idx_chat_session_created').on(t.sessionId, t.createdAt),
    index('idx_chat_visibility').on(t.sessionId, t.visibility),
  ],
);

export const gmNotes = sqliteTable(
  'gm_notes',
  {
    noteId: text('note_id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    turnId: text('turn_id'),
    visibility: text('visibility').notNull(), // GMNoteVisibility
    createdAt: text('created_at').notNull(),
    bodyJson: text('body_json', { mode: 'json' }).notNull(),
  },
  (t) => [index('idx_gm_notes_session').on(t.sessionId, t.createdAt)],
);

export const gmAuditLog = sqliteTable(
  'gm_audit_log',
  {
    auditId: integer('audit_id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    gmPlayerId: text('gm_player_id').notNull(),
    action: text('action').notNull(), // GmActionKind
    traceId: text('trace_id').notNull(),
    idempotencyKey: text('idempotency_key'),
    at: text('at').notNull(),
    bodyJson: text('body_json', { mode: 'json' }).notNull(),
  },
  (t) => [index('idx_gm_audit_session').on(t.sessionId, t.at), index('idx_gm_audit_action').on(t.action)],
);

// ───────────────────────────── Журнал, outbox, снапшоты ─────────────────────────────

export const journalEntries = sqliteTable(
  'journal_entries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    turnId: text('turn_id').notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    traceId: text('trace_id').notNull(),
    kind: text('kind').notNull(), // JournalKind
    payloadJson: text('payload_json', { mode: 'json' }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_journal_turn').on(t.turnId), index('idx_journal_session').on(t.sessionId, t.id)],
);

/**
 * Outbox: запись события в ту же транзакцию, что и изменение состояния.
 * Публикатор (промпт 1.5) забирает PENDING и помечает PUBLISHED/DEAD.
 */
export const eventOutbox = sqliteTable(
  'event_outbox',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventName: text('event_name').notNull(),
    /** Строка, а не json-колонка: контракт OutboxRecord.payloadJson — z.string() (промпт 1.2). */
    payloadJson: text('payload_json').notNull(),
    traceId: text('trace_id').notNull(),
    status: text('status').notNull().default('PENDING'), // OutboxStatus
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    emittedAt: text('emitted_at').notNull(),
    publishedAt: text('published_at'),
  },
  (t) => [index('idx_outbox_status').on(t.status, t.id), index('idx_outbox_event').on(t.eventName)],
);

export const snapshots = sqliteTable(
  'snapshots',
  {
    snapshotId: text('snapshot_id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    turnNumber: integer('turn_number').notNull(),
    createdByTurnId: text('created_by_turn_id'),
    createdBy: text('created_by').notNull(), // 'GM' | 'SYSTEM'
    checksum: text('checksum').notNull(),
    createdAt: text('created_at').notNull(),
    stateJson: text('state_json', { mode: 'json' }).notNull(),
  },
  (t) => [index('idx_snapshots_session').on(t.sessionId, t.turnNumber)],
);

// ───────────────────────────── Идемпотентность и AI ─────────────────────────────

/**
 * Идемпотентность команд (критерий A1.4).
 * Захват ключа — ОДНИМ атомарным запросом:
 *   INSERT INTO idempotency_records(...) VALUES(...) ON CONFLICT(key) DO NOTHING
 * rowsAffected=1 → мы владельцы (proceed). rowsAffected=0 → ключ уже есть, читаем и
 * возвращаем cached / in_flight / failed_before. Никаких «select потом insert» — это гонка.
 */
export const idempotencyRecords = sqliteTable(
  'idempotency_records',
  {
    key: text('key').primaryKey(),
    turnId: text('turn_id'),
    sessionId: text('session_id'),
    command: text('command').notNull(), // CommandName
    status: text('status').notNull(), // IdempotencyStatus
    resultJson: text('result_json'),
    resultHash: text('result_hash').notNull(),
    errorCode: text('error_code'),
    traceId: text('trace_id').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => [index('idx_idempotency_expires').on(t.expiresAt), index('idx_idempotency_session').on(t.sessionId)],
);

export const aiDecisions = sqliteTable(
  'ai_decisions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    turnId: text('turn_id'),
    providerId: text('provider_id').notNull(),
    model: text('model').notNull(),
    status: text('status').notNull(), // AiDecisionStatus
    promptHash: text('prompt_hash'),
    responseJson: text('response_json', { mode: 'json' }),
    violationsCount: integer('violations_count').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    errorCode: text('error_code'),
    traceId: text('trace_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_ai_decisions_turn').on(t.turnId), index('idx_ai_decisions_session').on(t.sessionId, t.id)],
);

export const SCHEMA_TABLES = {
  sessions,
  players,
  characters,
  turns,
  actions,
  gameState,
  stateHistory,
  worldStateVersion,
  locations,
  chatMessages,
  gmNotes,
  gmAuditLog,
  journalEntries,
  eventOutbox,
  snapshots,
  idempotencyRecords,
  aiDecisions,
} as const;

export type SchemaTables = typeof SCHEMA_TABLES;
