import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, type DatabaseHandle } from '@mnemosin/database';
import { runMigrations, readSchemaVersion, type SchemaVersion } from '@mnemosin/database';
import { SqlUnitOfWork } from '@mnemosin/database';
import { IdempotencyService } from '@mnemosin/database';
import { createCoreServices } from '@mnemosin/core';
import { nowIso } from '@mnemosin/contracts';
import type { SessionId, PlayerId, CharacterId, GameState, LocationId, ObjectId } from '@mnemosin/contracts';

export interface ColdTestDb {
  readonly handle: DatabaseHandle;
  readonly uow: SqlUnitOfWork;
  readonly idempotency: IdempotencyService;
  readonly version: SchemaVersion;
  readonly services: ReturnType<typeof createCoreServices>;
  readonly sessionId: SessionId;
  readonly playerId: PlayerId;
  readonly characterId: CharacterId;
  readonly close: () => Promise<void>;
}

/** Минимальная инициализация БД для cold unit-тестов: схема + миграции + пустая сессия + состояние. */
export async function openColdTestDb(label: string): Promise<ColdTestDb> {
  const dir = mkdtempSync(join(tmpdir(), `mnemosin-cold-${label}-`));
  const path = join(dir, 'test.sqlite');
  const url = `file:${path}`;

  const handle = await openDatabase({ url });
  await runMigrations(handle.db);
  const version = await readSchemaVersion(handle.db);
  const uow = new SqlUnitOfWork(handle.db, handle.reader);
  const idempotency = new IdempotencyService({ uow });

  // Создаём минимальную сессию и состояние вручную
  const at = nowIso();
  const sessionId = randomUUID() as SessionId;
  const characterId = randomUUID() as CharacterId;
  const playerId = randomUUID() as PlayerId;
  const gmCharacterId = randomUUID() as CharacterId;
  const gmPlayerId = randomUUID() as PlayerId;

  await uow.runInTx(async (scope) => {
    // Session first (FK target for characters, players, state, locations)
    await scope.repos.sessions.insert({
      sessionId,
      title: 'Cold Test Session',
      status: 'ACTIVE',
      gmPlayerId,
      currentTurnId: null,
      worldPackId: 'test-pack',
      worldPackVersion: '1.0.0',
      archivedAt: null,
      createdAt: at,
      updatedAt: at,
    });
    // GM character
    await scope.repos.characters.insert({
      characterId: gmCharacterId,
      sessionId,
      name: 'GM',
      archetype: 'gm',
      stats: {},
      createdAt: at,
    });
    // Test character
    await scope.repos.characters.insert({
      characterId,
      sessionId,
      name: 'Test Player',
      archetype: 'survivor',
      stats: { calm: 5 },
      createdAt: at,
    });
    // GM player
    await scope.repos.players.insert({
      playerId: gmPlayerId,
      sessionId,
      characterId: gmCharacterId,
      displayName: 'GM',
      isGM: true,
      status: 'ACTIVE',
      joinedAt: at,
      leftAt: null,
    });
    // Test player
    await scope.repos.players.insert({
      playerId,
      sessionId,
      characterId,
      displayName: 'Test Player',
      isGM: false,
      status: 'ACTIVE',
      joinedAt: at,
      leftAt: null,
    });

    const startLocationId = randomUUID() as LocationId;
    // Pre-populate with test objects used by cold event processor tests
    const TEST_ITEM_ID = '00000000-0000-4000-8000-000000000101' as ObjectId;
    const TEST_FILTER_ID = '00000000-0000-4000-8000-000000000200' as ObjectId;

    const objectStates: GameState['objectStates'] = {
      [TEST_ITEM_ID]: {
        objectId: TEST_ITEM_ID,
        locationId: startLocationId,
        state: {},
        visible: true,
        taken: false,
        lastChangedAtTurnId: null,
      },
      [TEST_FILTER_ID]: {
        objectId: TEST_FILTER_ID,
        locationId: startLocationId,
        state: { charge: 10 },
        visible: true,
        taken: false,
        lastChangedAtTurnId: null,
      },
    };
    const playerKnowledge: GameState['playerKnowledge'] = {};
    playerKnowledge[gmPlayerId] = { playerId: gmPlayerId, entries: [] };
    playerKnowledge[playerId] = { playerId, entries: [] };

    const state = {
      sessionId,
      worldState: {
        currentLocationId: startLocationId,
        timeOfDay: 'NIGHT' as const,
        weather: null,
        ambientFlags: {},
      },
      storyFlags: {},
      objectStates,
      playerKnowledge,
      endingState: null,
      version: 0,
      updatedAt: at,
    };
    await scope.repos.state.insert(state);
    // Location for startLocationId - minimal valid LocationDefinition
    const locationDef = {
      locationId: startLocationId,
      sessionId,
      templateSlug: null,
      name: 'Test Location',
      description: 'Test location for cold unit tests',
      atmosphere: 'test',
      objects: [],
      exits: [],
      hazards: [],
      registeredEventIds: [],
      narrativeNotes: '',
      aiGuidance: null,
      gmSecret: null,
      tags: [],
      meta: { actors: {}, items: {} },
      updatedAt: at,
    };
    await scope.repos.locations.upsert(locationDef);
  });

  const services = createCoreServices({
    uow,
    guard: idempotency,
    pack: { locations: [], startLocationId: randomUUID() as LocationId, packId: 'test-pack', version: '1.0.0' },
    limits: { maxPlayersPerSession: 12, actionsPerPlayerPerTurn: 5 },
  });

  return {
    handle,
    uow,
    idempotency,
    version,
    services,
    sessionId,
    playerId,
    characterId,
    async close(): Promise<void> {
      await handle.close();
      // Windows fix: wait for SQLite handles
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          return;
        } catch (err: unknown) {
          const code = (err as { code?: string }).code;
          if (code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY') {
            if (attempt === 4) {
              console.warn(`Failed to delete temp dir ${dir} after 5 attempts`);
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          } else {
            throw err;
          }
        }
      }
    },
  };
}
