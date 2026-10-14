import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  CharacterSchema,
  GameStateSchema,
  LocationDefinitionSchema,
  PlayerSchema,
  SessionSchema,
  nowIso,
  type Character,
  type CharacterId,
  type GameState,
  type LocationDefinition,
  type LocationId,
  type ObjectState,
  type Player,
  type PlayerId,
  type SessionId,
} from '@mnemosin/contracts';

import { openDatabase, type DatabaseHandle, type DbLogger } from './client.js';
import { IdempotencyService } from './idempotency.js';
import { readSchemaVersion, runMigrations, type SchemaVersion } from './migrate.js';
import { SqlUnitOfWork } from './tx.js';

/**
 * Bootstrap БД (промпт 1.4).
 *
 * Порядок: открыть соединение → применить PRAGMA → применить миграции → (опционально)
 * посеять dev-сессию. Любой шаг, который не сошёлся, бросает исключение: сервер с
 * полумигрированной схемой стартовать не должен (fail-fast, как в config).
 */

export interface LocationPackFixture {
  readonly packId: string;
  readonly version: string;
  readonly startLocationId: LocationId;
  readonly locations: LocationDefinition[];
}

export function defaultFixturesPath(): string {
  return fileURLToPath(new URL('../../../tools/fixtures/locations.stage1.json', import.meta.url));
}

/** Читает и ВАЛИДИРУЕТ фикстуры локаций. Молча подменить данные не получится. */
export function loadLocationFixtures(path: string = defaultFixturesPath()): LocationPackFixture {
  if (!existsSync(path)) {
    throw new Error(`[database] файл фикстур локаций не найден: ${path}. Сгенерируйте его: npm run gen:fixtures`);
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const locationsRaw = Array.isArray(raw['locations']) ? raw['locations'] : [];
  const locations = locationsRaw.map((item, i) => {
    const parsed = LocationDefinitionSchema.safeParse(item);
    if (!parsed.success) {
      throw new Error(
        `[database] locations[${i}] не проходит LocationDefinitionSchema: ` +
          parsed.error.issues
            .slice(0, 3)
            .map((iss) => `${iss.path.join('.')}: ${iss.message}`)
            .join('; '),
      );
    }
    return parsed.data;
  });
  const startLocationId = raw['startLocationId'];
  if (typeof startLocationId !== 'string' || !locations.some((l) => l.locationId === startLocationId)) {
    throw new Error('[database] startLocationId отсутствует или не указывает ни на одну локацию фикстур');
  }
  return {
    packId: String(raw['packId'] ?? 'stage1-dev'),
    version: String(raw['version'] ?? '0.0.0'),
    startLocationId: startLocationId as LocationId,
    locations,
  };
}

export interface DevSessionSeed {
  readonly title: string;
  readonly gmName: string;
  readonly playerNames: readonly string[];
}

export const DEFAULT_DEV_SEED: DevSessionSeed = Object.freeze({
  title: 'МНЕМОСИН — dev-сессия',
  gmName: 'Ведущий',
  // Имена-заглушки для разработки: настоящие задаются в лобби (промпт 1.10) и в D157.
  playerNames: Object.freeze(['Игрок 1', 'Игрок 2', 'Игрок 3', 'Игрок 4', 'Игрок 5', 'Игрок 6']),
});

export interface CreateDevSessionResult {
  readonly sessionId: SessionId;
  readonly gmPlayerId: PlayerId;
  readonly players: Player[];
  readonly characters: Character[];
  readonly state: GameState;
  readonly locations: number;
}

/**
 * Создаёт dev-сессию: локации из фикстур, GM + 6 игроков с персонажами, стартовое состояние.
 * Всё — ОДНОЙ транзакцией: частичный посев (сессия без состояния) невозможен.
 */
export async function createDevSession(
  uow: SqlUnitOfWork,
  pack: LocationPackFixture,
  seed: DevSessionSeed = DEFAULT_DEV_SEED,
): Promise<CreateDevSessionResult> {
  const at = nowIso();
  const sessionId = randomUUID() as SessionId;

  const makePair = (name: string, isGM: boolean): { player: Player; character: Character } => {
    const characterId = randomUUID() as CharacterId;
    const playerId = randomUUID() as PlayerId;
    const character = CharacterSchema.parse({
      characterId,
      sessionId,
      name,
      archetype: isGM ? 'gm' : 'survivor',
      stats: {},
      createdAt: at,
    });
    const player = PlayerSchema.parse({
      playerId,
      sessionId,
      characterId,
      displayName: name,
      isGM,
      status: 'ACTIVE',
      revokedBefore: null,
      joinedAt: at,
      leftAt: null,
    });
    return { player, character };
  };

  const gm = makePair(seed.gmName, true);
  const others = seed.playerNames.map((name) => makePair(name, false));
  const players = [gm.player, ...others.map((p) => p.player)];
  const characters = [gm.character, ...others.map((p) => p.character)];

  const session = SessionSchema.parse({
    sessionId,
    title: seed.title,
    status: 'ACTIVE',
    playerIds: players.map((p) => p.playerId),
    gmPlayerId: gm.player.playerId,
    currentTurnId: null,
    worldPackId: pack.packId,
    worldPackVersion: pack.version,
    archivedAt: null,
    createdAt: at,
    updatedAt: at,
  });

  const objectStates: Record<string, ObjectState> = {};
  for (const location of pack.locations) {
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

  const playerKnowledge: Record<string, { playerId: PlayerId; entries: never[] }> = {};
  for (const player of players) playerKnowledge[player.playerId] = { playerId: player.playerId, entries: [] };

  const state = GameStateSchema.parse({
    sessionId,
    worldState: {
      currentLocationId: pack.startLocationId,
      // Q1 (время старта и стартовые флаги) ещё не закрыт заказчиком — берём NIGHT и пустые
      // флаги как нейтральный вариант. Изменение = правка этого объекта, не схемы.
      timeOfDay: 'NIGHT',
      weather: null,
      ambientFlags: {},
    },
    storyFlags: {},
    objectStates,
    playerKnowledge,
    endingState: null,
    version: 0,
    updatedAt: at,
  });

  await uow.runInTx(async (scope) => {
    for (const location of pack.locations) await scope.repos.locations.upsert(location);
    await scope.repos.sessions.insert(session);
    for (const character of characters) await scope.repos.characters.insert(character);
    for (const player of players) await scope.repos.players.insert(player);
    await scope.repos.state.insert(state);
  });

  return {
    sessionId,
    gmPlayerId: gm.player.playerId,
    players,
    characters,
    state,
    locations: pack.locations.length,
  };
}

export interface SeedResult {
  readonly created: boolean;
  readonly sessionId: SessionId | null;
  readonly reason: string;
  readonly locations: number;
  readonly players: number;
}

export interface BootstrapOptions {
  readonly url: string;
  readonly logger?: DbLogger;
  /** Применить миграции (по умолчанию да; отключается только в тестах с уже готовой БД). */
  readonly migrate?: boolean;
  /** Посеять dev-сессию, если БД пустая (по умолчанию да в development, нет в production). */
  readonly seed?: boolean;
  readonly fixturesPath?: string;
  readonly seedConfig?: DevSessionSeed;
}

export interface BootstrapResult {
  readonly handle: DatabaseHandle;
  readonly uow: SqlUnitOfWork;
  readonly idempotency: IdempotencyService;
  readonly version: SchemaVersion;
  readonly seed: SeedResult;
  close(): Promise<void>;
}

export async function bootstrapDatabase(options: BootstrapOptions): Promise<BootstrapResult> {
  const handle = await openDatabase({ url: options.url, ...(options.logger ? { logger: options.logger } : {}) });
  const migrateResult = options.migrate === false ? null : await runMigrations(handle.db);
  const version = migrateResult?.version ?? (await readSchemaVersion(handle.db));
  const uow = new SqlUnitOfWork(handle.db, handle.reader);
  const idempotency = new IdempotencyService({ uow, ...(options.logger ? { logger: options.logger } : {}) });

  let seed: SeedResult = { created: false, sessionId: null, reason: 'seed отключён', locations: 0, players: 0 };
  if (options.seed !== false) {
    const existing = await uow.repos().sessions.listAll();
    if (existing.length > 0) {
      seed = {
        created: false,
        sessionId: existing[0]!.sessionId,
        reason: `в БД уже есть сессий: ${existing.length} (D108 — одна активная сессия, посев пропущен)`,
        locations: await uow.repos().locations.count(),
        players: 0,
      };
    } else {
      const pack = loadLocationFixtures(options.fixturesPath);
      const created = await createDevSession(uow, pack, options.seedConfig);
      seed = {
        created: true,
        sessionId: created.sessionId,
        reason: 'посеяна dev-сессия из фикстур',
        locations: created.locations,
        players: created.players.length,
      };
      options.logger?.info(
        { sessionId: created.sessionId, locations: created.locations, players: created.players.length },
        'dev session seeded',
      );
    }
  }

  return {
    handle,
    uow,
    idempotency,
    version,
    seed,
    async close(): Promise<void> {
      await handle.close();
    },
  };
}
