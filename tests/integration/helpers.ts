import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCoreServices, type CoreServices } from '@mnemosin/core';

import {
  nowIso,
  plusMs,
  type ActionId,
  type Character,
  type CharacterId,
  type ChatMessage,
  type GameState,
  type GMNote,
  type IdempotencyKey,
  type IdempotencyRecord,
  type LocationDefinition,
  type MessageId,
  type NoteId,
  type Player,
  type PlayerAction,
  type PlayerId,
  type Session,
  type SessionId,
  type Snapshot,
  type Turn,
  type TurnId,
} from '@mnemosin/contracts';
import { bootstrapDatabase, loadLocationFixtures, type BootstrapResult } from '@mnemosin/database';

/**
 * Общие фабрики и временные БД для интеграционных тестов (промпт 1.4).
 *
 * Каждая тест-файл получает СВОЮ БД в temp-каталоге: тесты не мешают друг другу,
 * а «краш» одного не ломает остальные. Файлы удаляются в afterAll.
 */

export interface TempDb {
  readonly boot: BootstrapResult;
  readonly url: string;
  readonly dir: string;
  readonly path: string;
  close(): Promise<void>;
}

/**
 * Безопасная очистка temp-каталога (промпт 1.13, Windows-fix): SQLite WAL/SHM и
 * каталоги под OneDrive/антивирусом могут держать handles доли секунд — EPERM.
 * Ретраи + best-effort: уборка не должна ронять прошедшие тесты.
 */
export function rmSafe(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
  } catch {
    /* best-effort: temp-каталог уберёт ОС */
  }
}

export async function openTempDb(label: string, options: { seed?: boolean } = {}): Promise<TempDb> {
  const dir = mkdtempSync(join(tmpdir(), `mnemosin-${label}-`));
  const path = join(dir, 'test.sqlite');
  const url = `file:${path}`;
  const boot = await bootstrapDatabase({ url, ...(options.seed === undefined ? {} : { seed: options.seed }) });
  return {
    boot,
    url,
    dir,
    path,
    async close(): Promise<void> {
      await boot.close();
      rmSafe(dir);
    },
  };
}

export const fixtures = loadLocationFixtures();
export const startLocationId = fixtures.startLocationId;

export interface SampleWorld {
  readonly session: Session;
  readonly gm: Player;
  readonly gmCharacter: Character;
  readonly players: Player[];
  readonly characters: Character[];
  readonly state: GameState;
}

/** Полностью валидный (по контрактам) набор «сессия + GM + 6 игроков + состояние». */
export function makeWorld(at: string = nowIso()): SampleWorld {
  const sessionId = randomUUID() as SessionId;
  const gmCharacterId = randomUUID() as CharacterId;
  const gmPlayerId = randomUUID() as PlayerId;

  const gmCharacter: Character = {
    characterId: gmCharacterId,
    sessionId,
    name: 'Ведущий',
    archetype: 'gm',
    stats: {},
    createdAt: at,
  };
  const gm: Player = {
    playerId: gmPlayerId,
    sessionId,
    characterId: gmCharacterId,
    displayName: 'Ведущий',
    isGM: true,
    status: 'ACTIVE',
    revokedBefore: null,
    joinedAt: at,
    leftAt: null,
  };

  const players: Player[] = [gm];
  const characters: Character[] = [gmCharacter];
  for (let i = 1; i <= 6; i += 1) {
    const characterId = randomUUID() as CharacterId;
    const playerId = randomUUID() as PlayerId;
    characters.push({
      characterId,
      sessionId,
      name: `Игрок ${i}`,
      archetype: 'survivor',
      stats: { calm: i },
      createdAt: at,
    });
    players.push({
      playerId,
      sessionId,
      characterId,
      displayName: `Игрок ${i}`,
      isGM: false,
      status: 'ACTIVE',
      revokedBefore: null,
      joinedAt: at,
      leftAt: null,
    });
  }

  const session: Session = {
    sessionId,
    title: 'Тестовая сессия',
    status: 'ACTIVE',
    playerIds: players.map((p) => p.playerId),
    gmPlayerId,
    currentTurnId: null,
    worldPackId: fixtures.packId,
    worldPackVersion: fixtures.version,
    archivedAt: null,
    createdAt: at,
    updatedAt: at,
  };

  const objectStates: GameState['objectStates'] = {};
  for (const location of fixtures.locations) {
    for (const object of location.objects) {
      objectStates[object.objectId] = {
        objectId: object.objectId,
        locationId: location.locationId,
        state: {},
        visible: true,
        taken: false,
        lastChangedAtTurnId: null,
      };
    }
  }

  const playerKnowledge: GameState['playerKnowledge'] = {};
  for (const player of players) playerKnowledge[player.playerId] = { playerId: player.playerId, entries: [] };

  const state: GameState = {
    sessionId,
    worldState: { currentLocationId: startLocationId, timeOfDay: 'NIGHT', weather: null, ambientFlags: {} },
    storyFlags: {},
    objectStates,
    playerKnowledge,
    endingState: null,
    version: 0,
    updatedAt: at,
  };

  return { session, gm, gmCharacter, players, characters, state };
}

/** Записывает мир в БД одной транзакцией и возвращает его. */
export async function seedWorld(db: TempDb, at: string = nowIso()): Promise<SampleWorld> {
  const world = makeWorld(at);
  await db.boot.uow.runInTx(async (scope) => {
    for (const location of fixtures.locations) await scope.repos.locations.upsert(location);
    await scope.repos.sessions.insert(world.session);
    for (const character of world.characters) await scope.repos.characters.insert(character);
    for (const player of world.players) await scope.repos.players.insert(player);
    await scope.repos.state.insert(world.state);
  });
  return world;
}

export function makeTurn(sessionId: SessionId, number: number, at: string = nowIso()): Turn {
  return {
    turnId: randomUUID() as TurnId,
    sessionId,
    number,
    status: 'OPEN',
    resolution: null,
    lockedAt: null,
    processingStartedAt: null,
    reviewReadyAt: null,
    committedAt: null,
    failed: null,
    createdAt: at,
    updatedAt: at,
  };
}

export function makeAction(
  turnId: TurnId,
  playerId: PlayerId,
  sequenceId: number,
  at: string = nowIso(),
): PlayerAction {
  return {
    actionId: randomUUID() as ActionId,
    turnId,
    playerId,
    sequenceId,
    rawText: `Действие №${sequenceId}: осматриваюсь`,
    meta: { targetObjectId: null, targetPlayerId: null, intent: 'OBSERVE', customLabel: null },
    idempotencyKey: `act-${randomUUID()}` as IdempotencyKey,
    createdAt: at,
  };
}

export function makeChat(sessionId: SessionId, fromPlayerId: PlayerId | null, at: string = nowIso()): ChatMessage {
  return {
    messageId: randomUUID() as MessageId,
    sessionId,
    turnId: null,
    visibility: fromPlayerId === null ? 'SYSTEM' : 'PUBLIC',
    fromPlayerId,
    toPlayerId: null,
    fromDisplayName: fromPlayerId === null ? null : 'Игрок',
    text: 'Проверка связи',
    createdAt: at,
  };
}

export function makeNote(sessionId: SessionId, at: string = nowIso()): GMNote {
  return {
    noteId: randomUUID() as NoteId,
    sessionId,
    turnId: null,
    visibility: 'GM_ONLY',
    text: 'Заметка ведущего: не выдавать до третьего хода',
    createdAt: at,
  };
}

export function makeIdempotencyRecord(key: string, at: string = nowIso()): IdempotencyRecord {
  return {
    key: key as IdempotencyKey,
    turnId: null,
    sessionId: null,
    command: 'submitAction',
    status: 'IN_FLIGHT',
    resultJson: null,
    resultHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    errorCode: null,
    traceId: 'trace-test',
    createdAt: at,
    expiresAt: plusMs(at, 60_000),
  };
}

export function makeSnapshot(
  sessionId: SessionId,
  state: GameState,
  turnNumber: number,
  at: string = nowIso(),
): Snapshot {
  return {
    id: randomUUID() as Snapshot['id'],
    sessionId,
    label: `Снимок хода ${turnNumber}`,
    turnNumber,
    createdByTurnId: null,
    createdBy: 'SYSTEM',
    state: { ...state, version: turnNumber },
    checksum: 'a'.repeat(64),
    createdAt: at,
  };
}

export function makeLocation(patch: Partial<LocationDefinition> = {}): LocationDefinition {
  const base = fixtures.locations[0]!;
  return {
    ...base,
    locationId: (patch.locationId ?? randomUUID()) as LocationDefinition['locationId'],
    templateSlug: patch.templateSlug ?? null,
    name: patch.name ?? 'Тестовая локация',
    ...patch,
  };
}

// ---------------------------------------------------------------- промпт 1.6

/**
 * Сборка доменных сервисов core на временной БД (промпт 1.6).
 * guard — IdempotencyService из bootstrap (порт CommandRunner, D216);
 * pack — те же фикстуры, что использует bootstrap dev-сессии.
 */
export function buildTestServices(
  db: TempDb,
  limits: { maxPlayersPerSession?: number; actionsPerPlayerPerTurn?: number } = {},
): CoreServices {
  return createCoreServices({
    uow: db.boot.uow,
    guard: db.boot.idempotency,
    pack: fixtures,
    limits: {
      maxPlayersPerSession: limits.maxPlayersPerSession ?? 12,
      actionsPerPlayerPerTurn: limits.actionsPerPlayerPerTurn ?? 5,
    },
  });
}

let keySeq = 0;

/** Уникальный ключ идемпотентности ≥16 символов (контракт IdempotencyKey). */
export function testKey(prefix: string): string {
  keySeq += 1;
  return `${prefix}-${keySeq}-${randomUUID()}`.slice(0, 128);
}

export interface LobbyWorld {
  readonly sessionId: SessionId;
  readonly gmPlayerId: PlayerId;
  readonly playerIds: PlayerId[];
  readonly turnId: TurnId | null;
}

/**
 * Полный путь лобби: createSession → join × N → startSession (открывает ход №1).
 * Возвращает id сессии, GM, игроков и первого хода.
 */
export async function bootLobby(
  services: CoreServices,
  options: { players?: number; start?: boolean; title?: string } = {},
): Promise<LobbyWorld> {
  const playerCount = options.players ?? 3;
  const created = await services.sessions.createSession({
    title: options.title ?? 'Тестовая сессия',
    gmDisplayName: 'Ведущий',
    idempotencyKey: testKey('create'),
  });
  const playerIds: PlayerId[] = [];
  for (let i = 1; i <= playerCount; i += 1) {
    const joined = await services.sessions.joinSession({
      sessionId: created.sessionId,
      displayName: `Игрок ${i}`,
      idempotencyKey: testKey('join'),
    });
    playerIds.push(joined.playerId);
  }
  let turnId: TurnId | null = null;
  if (options.start !== false) {
    const started = await services.sessions.startSession({
      sessionId: created.sessionId,
      idempotencyKey: testKey('start'),
    });
    turnId = started.turnId as TurnId;
  }
  return { sessionId: created.sessionId, gmPlayerId: created.gmPlayerId, playerIds, turnId };
}

export interface OutboxEventView {
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
}

/** Все ещё не опубликованные события outbox (в тестах публикатор не запускается). */
export async function outboxEvents(db: TempDb): Promise<OutboxEventView[]> {
  const records = await db.boot.uow.repos().outbox.listPending(1000);
  return records.map((r) => ({
    eventName: r.eventName,
    payload: JSON.parse(r.payloadJson) as Record<string, unknown>,
  }));
}

/** Счётчик событий outbox по именам. */
export async function outboxCounts(db: TempDb): Promise<Record<string, number>> {
  const events = await outboxEvents(db);
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.eventName] = (counts[event.eventName] ?? 0) + 1;
  return counts;
}

/** Код ошибки (AppError/CoreError) или null, если вызов прошёл. */
export async function errorCodeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === 'string' ? code : 'UNKNOWN';
  }
}
