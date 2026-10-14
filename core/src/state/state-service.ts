import { randomUUID } from 'node:crypto';

import {
  AppError,
  CoreError,
  GameStateSchema,
  StateMutationSchema,
  nowIso,
  type GameState,
  type ObjectId,
  type ObjectState,
  type PlayerId,
  type PlayerKnowledge,
  type SessionId,
  type StateMutation,
  type StoryFlag,
  type TurnId,
} from '@mnemosin/contracts';
import type { TxScope, UnitOfWork } from '../domain/ports/index.js';
import { appendOutbox, createEvent } from '../events/outbox.js';
import type { JournalService } from '../turns/journal.js';

/**
 * StateService — ЕДИНСТВЕННЫЙ путь мутации GameState (промпт 1.6;
 * инварианты 7–8, 13: AI и Media не пишут состояние напрямую, модули —
 * только через core-команды turn commit / moveGroup).
 *
 * Контракт apply():
 *  - мутации — только `StateMutation` из contracts (SET_FLAG, OBJECT_PATCH,
 *    OBJECT_VISIBLE, OBJECT_TAKEN, WORLD_PATCH, GRANT_KNOWLEDGE, REACH_ENDING).
 *    В этапе 1 это функции, а не DSL (он появится в этапе 2 — v3 §IV);
 *  - optimistic lock (A1.5): запись через `StateRepository.updateWithVersion`,
 *    расход версии → `CoreError('CORE_VERSION_CONFLICT')` с фактической версией;
 *  - атомарность: состояние + state_history + журнал + outbox(STATE_COMMITTED) —
 *    одна транзакция. Вызывающий может передать свой `scope` (тогда apply
 *    присоединяется к его транзакции), иначе открывается своя;
 *  - журнал `state_applied` пишется только когда turnId известен (журнал
 *    turn-scoped: FK journal_entries.turn_id); история state_history пишется всегда.
 *
 * Доступ: ТОЛЬКО через barrel `@mnemosin/core` (экспорта из подпутей нет);
 * разрешённые потребители проверяются architecture-тестом
 * `tests/arch/state-service-access.test.ts` (D219).
 */

export interface StateServiceDeps {
  readonly uow: UnitOfWork;
  readonly journal: JournalService;
}

export interface ApplyStateInput {
  readonly sessionId: SessionId;
  readonly mutations: readonly StateMutation[];
  /** Версия, которую ожидает вызывающий; запись возможна только если она текущая. */
  readonly expectedVersion: number;
  /** Ход, в контексте которого применяется мутация (null — вне хода, например moveGroup GM). */
  readonly turnId?: TurnId | null;
  readonly traceId: string;
  /** Транзакция вызывающего (turn commit, moveGroup): apply присоединяется к ней. */
  readonly scope?: TxScope;
}

export interface ApplyStateResult {
  readonly version: number;
  readonly changedKeys: readonly string[];
  readonly state: GameState;
}

/** Предел длины changedKey в STATE_COMMITTED (контракт: z.string().max(120)). */
const CHANGED_KEY_MAX = 120;

export class StateService {
  private readonly uow: UnitOfWork;
  private readonly journal: JournalService;

  constructor(deps: StateServiceDeps) {
    this.uow = deps.uow;
    this.journal = deps.journal;
  }

  /** Текущее состояние сессии (парсится GameStateSchema на границе чтения). */
  async get(sessionId: SessionId): Promise<GameState> {
    const state = await this.uow.repos().state.findBySession(sessionId);
    if (!state) {
      throw new CoreError('CORE_NOT_FOUND', `состояние сессии ${sessionId} не найдено`, {
        entity: 'game_state',
        sessionId,
      });
    }
    return state;
  }

  /** Применить мутации: version+1, history, journal, STATE_COMMITTED — одной транзакцией. */
  async apply(input: ApplyStateInput): Promise<ApplyStateResult> {
    const parsedMutations = input.mutations.map((mutation) => {
      const result = StateMutationSchema.safeParse(mutation);
      if (!result.success) {
        throw new AppError('VALIDATION', 'мутация состояния не прошла StateMutationSchema', {
          issues: result.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`),
        });
      }
      return result.data;
    });
    // Пустой список допустим: commitTurn хода без эффектов (один нарратив) всё равно
    // поднимает версию — вызывающему не нужно ветвиться на «есть ли мутации».

    const turnId = input.turnId ?? null;
    const run = async (scope: TxScope): Promise<ApplyStateResult> => {
      const current = await scope.repos.state.findBySession(input.sessionId);
      if (!current) {
        throw new CoreError('CORE_NOT_FOUND', `состояние сессии ${input.sessionId} не найдено`, {
          entity: 'game_state',
        });
      }
      if (current.version !== input.expectedVersion) {
        throw new CoreError(
          'CORE_VERSION_CONFLICT',
          `ожидалась версия ${input.expectedVersion}, фактическая ${current.version}`,
          { expectedVersion: input.expectedVersion, actualVersion: current.version },
        );
      }

      const next: GameState = {
        ...current,
        worldState: { ...current.worldState, ambientFlags: { ...current.worldState.ambientFlags } },
        storyFlags: { ...current.storyFlags },
        objectStates: copyObjectStates(current.objectStates),
        playerKnowledge: copyPlayerKnowledge(current.playerKnowledge),
        version: current.version + 1,
        updatedAt: nowIso(),
      };
      const changedKeys: string[] = [];
      for (const mutation of parsedMutations) {
        applyMutation(next, mutation, turnId, changedKeys);
      }
      GameStateSchema.parse(next); // инвариант 16 на границе записи

      const write = await scope.repos.state.updateWithVersion(next, input.expectedVersion);
      if (write.kind === 'conflict') {
        throw new CoreError(
          'CORE_VERSION_CONFLICT',
          `состояние изменилось под транзакцией: фактическая версия ${write.actualVersion}`,
          { expectedVersion: input.expectedVersion, actualVersion: write.actualVersion, race: true },
        );
      }

      await scope.repos.state.appendHistory({
        sessionId: input.sessionId,
        turnId,
        fromVersion: current.version,
        toVersion: next.version,
        mutations: parsedMutations,
        createdAt: next.updatedAt,
      });

      if (turnId) {
        await this.journal.append(
          {
            sessionId: input.sessionId,
            turnId,
            kind: 'state_applied',
            payload: {
              fromVersion: current.version,
              toVersion: next.version,
              mutations: parsedMutations.length,
              changedKeys: changedKeys.slice(0, 20),
            },
            traceId: input.traceId,
          },
          scope,
        );
      }

      await appendOutbox(
        [
          createEvent(
            'STATE_COMMITTED',
            {
              sessionId: input.sessionId,
              version: next.version,
              changedKeys: changedKeys.map((k) => k.slice(0, CHANGED_KEY_MAX)),
            },
            input.traceId,
          ),
        ],
        scope,
      );

      return { version: next.version, changedKeys, state: next };
    };

    return input.scope ? run(input.scope) : this.uow.runInTx(run);
  }
}

/**
 * Применение одной мутации к `next` (in-place) со сбором changedKeys.
 * Функции, а не DSL этапа 2: порядок и семантика совпадут с Effect-резолвером
 * v3 §IV, но без триггеров/условий — они появятся вместе с Event Engine.
 */
function applyMutation(next: GameState, mutation: StateMutation, turnId: TurnId | null, changedKeys: string[]): void {
  switch (mutation.kind) {
    case 'SET_FLAG': {
      const flag: StoryFlag = {
        flagId: randomUUID(),
        key: mutation.key,
        value: mutation.value,
        setAtTurnId: turnId,
        setBy: mutation.setBy,
      };
      next.storyFlags[mutation.key] = flag;
      changedKeys.push(`storyFlags.${mutation.key}`);
      return;
    }
    case 'OBJECT_PATCH': {
      const objectState = requireObject(next, mutation.objectId);
      objectState.state = { ...objectState.state, ...mutation.patch };
      objectState.lastChangedAtTurnId = turnId;
      for (const key of Object.keys(mutation.patch)) {
        changedKeys.push(`objectStates.${mutation.objectId}.state.${key}`);
      }
      return;
    }
    case 'OBJECT_VISIBLE': {
      const objectState = requireObject(next, mutation.objectId);
      objectState.visible = mutation.visible;
      objectState.lastChangedAtTurnId = turnId;
      changedKeys.push(`objectStates.${mutation.objectId}.visible`);
      return;
    }
    case 'OBJECT_TAKEN': {
      const objectState = requireObject(next, mutation.objectId);
      objectState.taken = mutation.taken;
      objectState.lastChangedAtTurnId = turnId;
      changedKeys.push(`objectStates.${mutation.objectId}.taken`);
      return;
    }
    case 'WORLD_PATCH': {
      if (mutation.timeOfDay !== undefined) {
        next.worldState.timeOfDay = mutation.timeOfDay;
        changedKeys.push('worldState.timeOfDay');
      }
      if (mutation.weather !== undefined) {
        next.worldState.weather = mutation.weather;
        changedKeys.push('worldState.weather');
      }
      if (mutation.currentLocationId !== undefined) {
        next.worldState.currentLocationId = mutation.currentLocationId;
        changedKeys.push('worldState.currentLocationId');
      }
      if (mutation.ambientFlags !== undefined) {
        next.worldState.ambientFlags = { ...next.worldState.ambientFlags, ...mutation.ambientFlags };
        for (const key of Object.keys(mutation.ambientFlags)) {
          changedKeys.push(`worldState.ambientFlags.${key}`);
        }
      }
      return;
    }
    case 'GRANT_KNOWLEDGE': {
      let knowledge: PlayerKnowledge | undefined = next.playerKnowledge[mutation.playerId];
      if (!knowledge) {
        knowledge = { playerId: mutation.playerId, entries: [] };
        next.playerKnowledge[mutation.playerId] = knowledge;
      }
      const existing = knowledge.entries.find((entry) => entry.key === mutation.key);
      if (existing) {
        existing.value = mutation.value;
        existing.learnedAtTurnId = turnId;
        existing.source = mutation.source;
      } else {
        knowledge.entries.push({
          key: mutation.key,
          value: mutation.value,
          learnedAtTurnId: turnId,
          source: mutation.source,
        });
      }
      changedKeys.push(`playerKnowledge.${mutation.playerId}.${mutation.key}`);
      return;
    }
    case 'REACH_ENDING': {
      if (!turnId) {
        // EndingState.reachedAtTurnId по контракту не nullable: финал всегда привязан к ходу.
        throw new AppError('VALIDATION', 'REACH_ENDING требует turnId (контракт EndingState)', {});
      }
      next.endingState = {
        endingId: mutation.endingId,
        reachedAtTurnId: turnId,
        summary: mutation.summary,
        survivors: mutation.survivors,
      };
      changedKeys.push('endingState');
      return;
    }
  }
}

function requireObject(next: GameState, objectId: ObjectId): ObjectState {
  const objectState = next.objectStates[objectId];
  if (!objectState) {
    throw new CoreError('CORE_NOT_FOUND', `объект ${objectId} отсутствует в состоянии сессии`, {
      entity: 'object',
      objectId,
    });
  }
  return objectState;
}

/**
 * Глубокие копии record'ов состояния: брендовые ключи (zod выводит
 * `Partial<Record<ObjectId, …>>`) не позволяют Object.fromEntries без потери
 * типа, а копирование обязательно — apply() не мутирует прочитанный агрегат.
 */
function copyObjectStates(source: GameState['objectStates']): GameState['objectStates'] {
  const out: GameState['objectStates'] = {};
  for (const [key, value] of Object.entries(source)) {
    if (value) out[key as ObjectId] = { ...value, state: { ...value.state } };
  }
  return out;
}

function copyPlayerKnowledge(source: GameState['playerKnowledge']): GameState['playerKnowledge'] {
  const out: GameState['playerKnowledge'] = {};
  for (const [key, value] of Object.entries(source)) {
    if (value) out[key as PlayerId] = { ...value, entries: value.entries.map((entry) => ({ ...entry })) };
  }
  return out;
}
