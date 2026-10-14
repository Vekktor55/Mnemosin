import { createHash } from 'node:crypto';

import {
  AppError,
  CoreError,
  LocationDefinitionSchema,
  type Exit,
  type LocationDefinition,
  type LocationId,
  type PlayerId,
  type SessionId,
  type TurnId,
} from '@mnemosin/contracts';
import { newTraceId, runCommand } from '../domain/command.js';
import type { CommandRunner, TxScope, UnitOfWork } from '../domain/ports/index.js';
import { appendOutbox, createEvent } from '../events/outbox.js';
import type { StateService } from '../state/state-service.js';

/**
 * LocationService — локации сессии и перемещение группы (промпт 1.6, критерий A1.15).
 *
 * Данные world-pack ИНЪЕКТИРУЮТСЯ (D221): core не читает файловую систему
 * (граница слоя 1.3: core = contracts + node:crypto/util/zod). Wiring передаёт
 * pack, загруженный `loadLocationFixtures()` из @mnemosin/database —
 * в этапе 1 это tools/fixtures/locations.stage1.json с УЖЕ валидными UUID
 * (детерминированный sha256(slug), D204); таблица соответствия slug→UUID —
 * tools/fixtures/remap.stage1.json (генерируется тем же скриптом).
 *
 * loadPackToSession клонирует локации pack'а с проставленным sessionId
 * (контракт: в сессии sessionId всегда заполнен). UUID сохраняются как есть:
 * на сервере одна активная сессия (D108), коллизий id нет; настоящая
 * инстанциация с перегенерацией id (remap, аудит §8.7) — world-pack этапа 2.
 *
 * moveGroup:
 *  - единственный источник истины о положении группы — worldState.currentLocationId
 *    (F-1.16); обновление — ТОЛЬКО через StateService.apply (инвариант 13);
 *  - выход существует (kind='LOCATION', toLocationId=цель) и не locked, иначе
 *    CoreError('CORE_RULE_REJECTED') → публичный RULE_REJECTED (A1.15);
 *    если параллельных выходов в цель несколько, достаточно одного незапертого;
 *  - все playerIds принадлежат сессии и не LEFT;
 *  - идемпотентность — ДЕТЕРМИНИРОВАННЫЙ ключ (F-3.6, D217):
 *    `move:{sha1("move:{sessionId}:{turnId ?? 'naive'}:{sha1(JSON(sort(playerIds)))}:{toLocationId}")}`.
 *    Алгоритм хэша — sha1 от JSON отсортированного массива playerIds (F-3.6);
 *    внешняя композиция свёрнута вторым sha1, потому что буквальный формат
 *    (156 символов) не влезает в контракт IdempotencyKey (max 128).
 *    Следствие: повтор ЛОГИЧЕСКИ того же перемещения дедуплицируется даже без
 *    ключа от транспорта. Ключ, переданный вызывающим, игнорируется намеренно.
 *    Ограничение D201: отказ RULE_REJECTED перманентен для ключа — после
 *    разблокировки выхода повтор возможен в следующем ходу (turnId входит в ключ).
 */

export interface WorldPackData {
  readonly packId: string;
  readonly version: string;
  readonly startLocationId: LocationId;
  readonly locations: readonly LocationDefinition[];
}

export interface LocationServiceDeps {
  readonly uow: UnitOfWork;
  readonly guard: CommandRunner;
  readonly state: StateService;
  readonly pack: WorldPackData;
}

export interface MoveGroupInput {
  readonly sessionId: SessionId;
  readonly playerIds: readonly PlayerId[];
  readonly toLocationId: LocationId;
  /** Ход, в котором происходит перемещение (null — служебное перемещение GM вне хода). */
  readonly turnId?: TurnId | null;
  /** Принимается для совместимости с транспортом; guard-ключ ВСЕГДА детерминированный (D217). */
  readonly idempotencyKey?: string;
  readonly traceId?: string;
}

export interface MoveGroupResult {
  readonly sessionId: SessionId;
  readonly fromLocationId: LocationId;
  readonly toLocationId: LocationId;
  readonly playerIds: readonly PlayerId[];
  readonly version: number;
  /** true — группа уже в целевой локации: состояние не менялось (естественная идемпотентность). */
  readonly alreadyThere: boolean;
  readonly replayed: boolean;
}

/** Детерминированный ключ идемпотентности moveGroup (F-3.6, D217). См. JSDoc файла. */
export function moveIdempotencyKey(input: {
  sessionId: SessionId;
  turnId: TurnId | null;
  playerIds: readonly PlayerId[];
  toLocationId: LocationId;
}): string {
  const sorted = [...input.playerIds].sort();
  const playersHash = createHash('sha1').update(JSON.stringify(sorted)).digest('hex');
  const composite = `move:${input.sessionId}:${input.turnId ?? 'naive'}:${playersHash}:${input.toLocationId}`;
  return `move:${createHash('sha1').update(composite).digest('hex')}`;
}

export class LocationService {
  private readonly uow: UnitOfWork;
  private readonly guard: CommandRunner;
  private readonly state: StateService;
  private readonly pack: WorldPackData;

  constructor(deps: LocationServiceDeps) {
    this.uow = deps.uow;
    this.guard = deps.guard;
    this.state = deps.state;
    this.pack = deps.pack;
  }

  /** Загрузить world-pack в сессию (upsert локаций с sessionId). Идемпотентно по построению. */
  async loadPackToSession(
    input: { sessionId: SessionId },
    scope?: TxScope,
  ): Promise<{ loaded: number; startLocationId: LocationId }> {
    const load = async (tx: TxScope): Promise<number> => {
      for (const template of this.pack.locations) {
        const location = LocationDefinitionSchema.parse({ ...template, sessionId: input.sessionId });
        await tx.repos.locations.upsert(location);
      }
      return this.pack.locations.length;
    };
    const loaded = scope ? await load(scope) : await this.uow.runInTx(load);
    return { loaded, startLocationId: this.pack.startLocationId };
  }

  async get(locationId: LocationId): Promise<LocationDefinition> {
    const location = await this.uow.repos().locations.findById(locationId);
    if (!location) {
      throw new CoreError('CORE_LOCATION_NOT_FOUND', `локация ${locationId} не найдена`, {
        entity: 'location',
        locationId,
      });
    }
    return location;
  }

  /** Локации сессии (в этапе 1 — скопированные из pack при создании сессии). */
  async list(sessionId: SessionId): Promise<LocationDefinition[]> {
    const all = await this.uow.repos().locations.listAll();
    return all.filter((location) => location.sessionId === sessionId);
  }

  async exitsOf(locationId: LocationId): Promise<Exit[]> {
    return (await this.get(locationId)).exits;
  }

  /** Переместить группу: проверка выхода → StateService.apply → LOCATION_CHANGED. */
  async moveGroup(input: MoveGroupInput): Promise<MoveGroupResult> {
    const traceId = input.traceId ?? newTraceId();
    if (input.playerIds.length === 0) {
      throw new AppError('VALIDATION', 'moveGroup: пустой список playerIds', {});
    }
    const turnId = input.turnId ?? null;
    const key = moveIdempotencyKey({
      sessionId: input.sessionId,
      turnId,
      playerIds: input.playerIds,
      toLocationId: input.toLocationId,
    });
    const result = await runCommand(
      this.guard,
      { key, command: 'moveGroup', sessionId: input.sessionId, turnId, traceId },
      async (scope) => {
        const session = await scope.repos.sessions.findById(input.sessionId);
        if (!session) {
          throw new CoreError('CORE_NOT_FOUND', `сессия ${input.sessionId} не найдена`, { entity: 'session' });
        }
        if (session.status !== 'ACTIVE') {
          throw new CoreError('CORE_INVALID_STATE_TRANSITION', 'перемещение возможно только в ACTIVE-сессии', {
            entity: 'session',
            from: session.status,
            to: 'ACTIVE',
            reason: 'move_requires_active_session',
          });
        }

        const gameState = await scope.repos.state.findBySession(input.sessionId);
        if (!gameState) {
          throw new CoreError('CORE_NOT_FOUND', `состояние сессии ${input.sessionId} не найдено`, {
            entity: 'game_state',
          });
        }
        const fromLocationId = gameState.worldState.currentLocationId;

        const players = await scope.repos.players.listBySession(input.sessionId);
        const requested = [...new Set(input.playerIds)];
        for (const playerId of requested) {
          const player = players.find((p) => p.playerId === playerId);
          if (!player || player.status === 'LEFT') {
            throw new CoreError('CORE_NOT_FOUND', `игрок ${playerId} не принадлежит сессии (или покинул её)`, {
              entity: 'player',
              playerId,
            });
          }
        }

        if (fromLocationId === input.toLocationId) {
          // Группа уже в цели: no-op без подъёма версии (естественная идемпотентность).
          return {
            sessionId: input.sessionId,
            fromLocationId,
            toLocationId: input.toLocationId,
            playerIds: requested,
            version: gameState.version,
            alreadyThere: true,
          };
        }

        const current = await scope.repos.locations.findById(fromLocationId);
        if (!current) {
          throw new CoreError('CORE_LOCATION_NOT_FOUND', `текущая локация ${fromLocationId} не найдена`, {
            entity: 'location',
            locationId: fromLocationId,
          });
        }
        const target = await scope.repos.locations.findById(input.toLocationId);
        if (!target) {
          throw new CoreError('CORE_LOCATION_NOT_FOUND', `локация назначения ${input.toLocationId} не найдена`, {
            entity: 'location',
            locationId: input.toLocationId,
          });
        }

        const matches = current.exits.filter(
          (exit) => exit.kind === 'LOCATION' && exit.toLocationId === input.toLocationId,
        );
        if (matches.length === 0) {
          throw new CoreError('CORE_RULE_REJECTED', `из локации «${current.name}» нет выхода в «${target.name}»`, {
            reason: 'exit_not_found',
            from: fromLocationId,
            to: input.toLocationId,
          });
        }
        const passable = matches.find((exit) => !exit.locked);
        if (!passable) {
          const lock = matches[0]!.lock;
          throw new CoreError(
            'CORE_RULE_REJECTED',
            `выход в «${target.name}» заперт${lock.reason ? `: ${lock.reason}` : ''}`,
            {
              reason: 'exit_locked',
              from: fromLocationId,
              to: input.toLocationId,
              lockType: lock.type,
              requiresFlag: lock.requiresFlag,
            },
          );
        }

        const applied = await this.state.apply({
          sessionId: input.sessionId,
          mutations: [{ kind: 'WORLD_PATCH', currentLocationId: input.toLocationId }],
          expectedVersion: gameState.version,
          turnId,
          traceId,
          scope,
        });
        await appendOutbox(
          [
            createEvent(
              'LOCATION_CHANGED',
              {
                sessionId: input.sessionId,
                fromLocationId,
                toLocationId: input.toLocationId,
                playerIds: requested,
              },
              traceId,
            ),
          ],
          scope,
        );
        return {
          sessionId: input.sessionId,
          fromLocationId,
          toLocationId: input.toLocationId,
          playerIds: requested,
          version: applied.version,
          alreadyThere: false,
        };
      },
    );
    return { ...result.value, replayed: result.replayed };
  }
}
