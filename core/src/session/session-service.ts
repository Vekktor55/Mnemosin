import { randomUUID } from 'node:crypto';

import {
  AppError,
  CharacterSchema,
  CoreError,
  GameStateSchema,
  PlayerSchema,
  SessionSchema,
  nowIso,
  type Character,
  type CharacterId,
  type GameState,
  type Player,
  type PlayerId,
  type Session,
  type SessionId,
  type TurnId,
} from '@mnemosin/contracts';
import { newTraceId, parseIdempotencyKey, runCommand } from '../domain/command.js';
import type { CommandRunner, TxScope, UnitOfWork } from '../domain/ports/index.js';
import { assertTransition } from '../domain/transition.js';
import { appendOutbox, createEvent } from '../events/outbox.js';
import type { LocationService, WorldPackData } from '../locations/location-service.js';
import type { TurnService } from '../turns/turn-service.js';

/**
 * SessionService — жизненный цикл сессии и партии (промпт 1.6; v3 §II.2–II.3).
 *
 * Машина состояний сессии — `SESSION_TRANSITIONS` (SPEC §3.3, закрывает F-3.5):
 *   LOBBY → ACTIVE → PAUSED ⇄ ACTIVE; любой незавершённый статус → ENDED.
 * Нарушение → CoreError('CORE_INVALID_STATE_TRANSITION', meta:{entity:'session', from, to}).
 *
 * Правила:
 *  - createSession: сессия в LOBBY + GM (игрок+персонаж) + локации pack'а +
 *    GameState version 0 (currentLocationId = startLocationId pack'а); событие
 *    SESSION_CREATED. timeOfDay='UNKNOWN' — канон стартового времени суток не
 *    утверждён (вопрос Q1 заказчику; не изобретаем);
 *  - D108 (одна активная сессия на сервер): createSession отклоняется, пока
 *    существует сессия в статусе LOBBY/ACTIVE/PAUSED;
 *  - joinSession: только LOBBY; состав ≤ limits.maxPlayersPerSession (12);
 *    displayName уникален среди неушедших игроков сессии; персонаж — новый
 *    (имя = displayName, D157) или существующий свободный characterId;
 *  - startSession: LOBBY→ACTIVE, требует GM и ≥1 игрока НЕ-GM (D222),
 *    открывает ход №1 через TurnService.openTurn (в той же транзакции —
 *    вложенный runInTx присоединяется через ALS);
 *  - endSession: любой→ENDED + archivedAt (D108: завершённая сессия уходит
 *    в архив, а не удаляется); события SESSION_STATUS_CHANGED + SESSION_ENDED;
 *  - removePlayer (GM) / leaveSession (сам игрок): статус LEFT + исключение из
 *    playerIds + PLAYER_LEFT{reason:'KICKED'|'LEFT'}. GM нельзя удалить/уйти —
 *    партия без ведущего неиграбельна, выход — endSession (D222);
 *  - журнал не пишется: journal_entries turn-scoped (FK turn_id), у сессионных
 *    команд хода нет. Аудит сессионных действий — outbox-события (и gm-audit, 1.9).
 *
 * createCharacter (минимально в этапе 1): свободный персонаж сессии без игрока;
 * stats пустые — характеристики не в Core (F-1.20, инвариант 1).
 */

export interface SessionServiceDeps {
  readonly uow: UnitOfWork;
  readonly guard: CommandRunner;
  readonly turns: TurnService;
  readonly locations: LocationService;
  readonly pack: WorldPackData;
  readonly limits: { readonly maxPlayersPerSession: number };
}

export interface CreateSessionResult {
  readonly sessionId: SessionId;
  readonly gmPlayerId: PlayerId;
  readonly gmCharacterId: CharacterId;
  readonly status: Session['status'];
  readonly replayed: boolean;
}

export interface JoinSessionResult {
  readonly sessionId: SessionId;
  readonly playerId: PlayerId;
  readonly characterId: CharacterId;
  readonly displayName: string;
  readonly replayed: boolean;
}

export interface StartSessionResult {
  readonly sessionId: SessionId;
  readonly status: Session['status'];
  readonly turnId: TurnId;
  readonly turnNumber: number;
  readonly replayed: boolean;
}

export class SessionService {
  private readonly uow: UnitOfWork;
  private readonly guard: CommandRunner;
  private readonly turns: TurnService;
  private readonly locations: LocationService;
  private readonly pack: WorldPackData;
  private readonly maxPlayersPerSession: number;

  constructor(deps: SessionServiceDeps) {
    this.uow = deps.uow;
    this.guard = deps.guard;
    this.turns = deps.turns;
    this.locations = deps.locations;
    this.pack = deps.pack;
    this.maxPlayersPerSession = deps.limits.maxPlayersPerSession;
  }

  // ------------------------------------------------------------------ чтение

  async getSession(sessionId: SessionId): Promise<Session> {
    const session = await this.uow.repos().sessions.findById(sessionId);
    if (!session) {
      throw new CoreError('CORE_NOT_FOUND', `сессия ${sessionId} не найдена`, { entity: 'session', sessionId });
    }
    return session;
  }

  async listPlayers(sessionId: SessionId): Promise<Player[]> {
    return this.uow.repos().players.listBySession(sessionId);
  }

  // ------------------------------------------------------------------ команды

  /** Создать сессию в LOBBY: GM, локации pack'а, GameState version 0. */
  async createSession(input: {
    title: string;
    gmDisplayName: string;
    /** D157: имя персонажа GM задаёт сам; по умолчанию — displayName. */
    characterName?: string;
    idempotencyKey: string;
    traceId?: string;
  }): Promise<CreateSessionResult> {
    const traceId = input.traceId ?? newTraceId();
    const key = parseIdempotencyKey(input.idempotencyKey);
    const result = await runCommand(
      this.guard,
      { key, command: 'createSession', sessionId: null, turnId: null, traceId },
      async (scope) => {
        // D108: одна активная сессия на сервер.
        const existing = await scope.repos.sessions.listAll();
        const live = existing.find((s) => s.status === 'LOBBY' || s.status === 'ACTIVE' || s.status === 'PAUSED');
        if (live) {
          throw new AppError(
            'CONFLICT',
            `на сервере уже есть сессия ${live.sessionId} (статус ${live.status}) — D108`,
            {
              reason: 'session_exists',
              sessionId: live.sessionId,
            },
          );
        }

        const at = nowIso();
        const sessionId = randomUUID() as SessionId;
        const gmPlayerId = randomUUID() as PlayerId;
        const gmCharacterId = randomUUID() as CharacterId;

        const gmCharacter = CharacterSchema.parse({
          characterId: gmCharacterId,
          sessionId,
          // D157: имя персонажа задаёт игрок (HTTP /auth/session принимает characterName).
          name: (input.characterName ?? input.gmDisplayName).trim(),
          archetype: 'gm',
          stats: {},
          createdAt: at,
        } satisfies Character);
        const gm = PlayerSchema.parse({
          playerId: gmPlayerId,
          sessionId,
          characterId: gmCharacterId,
          displayName: input.gmDisplayName,
          isGM: true,
          status: 'ACTIVE',
          revokedBefore: null,
          joinedAt: at,
          leftAt: null,
        } satisfies Player);
        const session = SessionSchema.parse({
          sessionId,
          title: input.title,
          status: 'LOBBY',
          playerIds: [gmPlayerId],
          gmPlayerId,
          currentTurnId: null,
          worldPackId: this.pack.packId,
          worldPackVersion: this.pack.version,
          archivedAt: null,
          createdAt: at,
          updatedAt: at,
        } satisfies Session);

        await this.locations.loadPackToSession({ sessionId }, scope);
        const locations = await scope.repos.locations.listAll();
        const objectStates: GameState['objectStates'] = {};
        for (const location of locations.filter((l) => l.sessionId === sessionId)) {
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
        const state = GameStateSchema.parse({
          sessionId,
          worldState: {
            currentLocationId: this.pack.startLocationId,
            // Q1 (канон стартового timeOfDay) открыт — нейтральное UNKNOWN, не изобретаем.
            timeOfDay: 'UNKNOWN',
            weather: null,
            ambientFlags: {},
          },
          storyFlags: {},
          objectStates,
          playerKnowledge: { [gmPlayerId]: { playerId: gmPlayerId, entries: [] } },
          endingState: null,
          version: 0,
          updatedAt: at,
        } satisfies GameState);

        await scope.repos.sessions.insert(session);
        await scope.repos.characters.insert(gmCharacter);
        await scope.repos.players.insert(gm);
        await scope.repos.state.insert(state);
        await appendOutbox(
          [createEvent('SESSION_CREATED', { sessionId, gmPlayerId, title: session.title }, traceId)],
          scope,
        );
        return { sessionId, gmPlayerId, gmCharacterId, status: 'LOBBY' as const };
      },
    );
    return { ...result.value, replayed: result.replayed };
  }

  /** Игрок присоединяется к лобби (создаёт или присоединяет персонажа). */
  async joinSession(input: {
    sessionId: SessionId;
    displayName: string;
    /** D157: имя персонажа задаёт игрок; по умолчанию — displayName. */
    characterName?: string;
    characterId?: CharacterId | null;
    idempotencyKey: string;
    traceId?: string;
  }): Promise<JoinSessionResult> {
    const traceId = input.traceId ?? newTraceId();
    const key = parseIdempotencyKey(input.idempotencyKey);
    const result = await runCommand(
      this.guard,
      { key, command: 'joinSession', sessionId: input.sessionId, turnId: null, traceId },
      async (scope) => {
        const session = await this.sessionIn(scope, input.sessionId);
        if (session.status !== 'LOBBY') {
          throw new CoreError(
            'CORE_INVALID_STATE_TRANSITION',
            `присоединиться можно только к лобби (статус сессии ${session.status})`,
            { entity: 'session', from: session.status, to: 'LOBBY', reason: 'join_requires_lobby' },
          );
        }
        if (session.playerIds.length >= this.maxPlayersPerSession) {
          throw new AppError('CONFLICT', `сессия заполнена (${this.maxPlayersPerSession} участников)`, {
            reason: 'session_full',
            max: this.maxPlayersPerSession,
          });
        }
        const players = await scope.repos.players.listBySession(input.sessionId);
        if (players.some((p) => p.displayName === input.displayName && p.status !== 'LEFT')) {
          throw new AppError('CONFLICT', `имя «${input.displayName}» уже занято в сессии`, {
            reason: 'display_name_taken',
          });
        }

        const at = nowIso();
        const playerId = randomUUID() as PlayerId;
        let characterId = input.characterId ?? null;
        if (characterId) {
          const character = await scope.repos.characters.findById(characterId);
          if (!character || character.sessionId !== input.sessionId) {
            throw new CoreError('CORE_NOT_FOUND', `персонаж ${characterId} не найден в сессии`, {
              entity: 'character',
              characterId,
            });
          }
          if (players.some((p) => p.characterId === characterId && p.status !== 'LEFT')) {
            throw new AppError('CONFLICT', 'персонаж уже занят другим игроком', { reason: 'character_taken' });
          }
        } else {
          characterId = randomUUID() as CharacterId;
          // D157: имя персонажа задаёт игрок (characterName), уникальность в пределах
          // сессии проверяется среди персонажей НЕ покинувших игроков.
          const wantedName = (input.characterName ?? input.displayName).trim();
          const characters = await scope.repos.characters.listBySession(input.sessionId);
          const activeCharacterIds = new Set(players.filter((p) => p.status !== 'LEFT').map((p) => p.characterId));
          if (characters.some((c) => c.name === wantedName && activeCharacterIds.has(c.characterId))) {
            throw new AppError('CONFLICT', `имя персонажа «${wantedName}» уже занято в сессии`, {
              reason: 'character_name_taken',
            });
          }
          const character = CharacterSchema.parse({
            characterId,
            sessionId: input.sessionId,
            name: wantedName,
            archetype: null,
            stats: {},
            createdAt: at,
          } satisfies Character);
          await scope.repos.characters.insert(character);
        }
        const characterName = (await scope.repos.characters.findById(characterId))?.name ?? input.displayName;

        const player = PlayerSchema.parse({
          playerId,
          sessionId: input.sessionId,
          characterId,
          displayName: input.displayName,
          isGM: false,
          status: 'ACTIVE',
          revokedBefore: null,
          joinedAt: at,
          leftAt: null,
        } satisfies Player);
        await scope.repos.players.insert(player);
        await scope.repos.sessions.update({
          ...session,
          playerIds: [...session.playerIds, playerId],
          updatedAt: at,
        });
        await appendOutbox(
          [
            createEvent(
              'PLAYER_JOINED',
              { sessionId: input.sessionId, playerId, displayName: player.displayName, characterName },
              traceId,
            ),
          ],
          scope,
        );
        return { sessionId: input.sessionId, playerId, characterId, displayName: player.displayName };
      },
    );
    return { ...result.value, replayed: result.replayed };
  }

  /** LOBBY→ACTIVE: требует GM и ≥1 игрока не-GM (D222); открывает ход №1. */
  async startSession(input: {
    sessionId: SessionId;
    idempotencyKey: string;
    traceId?: string;
  }): Promise<StartSessionResult> {
    const traceId = input.traceId ?? newTraceId();
    const key = parseIdempotencyKey(input.idempotencyKey);
    const result = await runCommand(
      this.guard,
      { key, command: 'startSession', sessionId: input.sessionId, turnId: null, traceId },
      async (scope) => {
        const session = await this.sessionIn(scope, input.sessionId);
        if (session.status !== 'LOBBY') {
          throw new CoreError('CORE_INVALID_STATE_TRANSITION', 'старт возможен только из LOBBY', {
            entity: 'session',
            from: session.status,
            to: 'ACTIVE',
            reason: 'start_requires_lobby',
          });
        }
        assertTransition('session', session.status, 'ACTIVE');

        const players = await scope.repos.players.listBySession(input.sessionId);
        const gm = players.find((p) => p.playerId === session.gmPlayerId);
        if (!gm || gm.status === 'LEFT') {
          throw new AppError('CONFLICT', 'для старта нужен действующий GM', { reason: 'gm_required' });
        }
        const nonGm = players.filter((p) => !p.isGM && p.status !== 'LEFT');
        if (nonGm.length < 1) {
          throw new AppError('CONFLICT', 'для старта нужен хотя бы один игрок (не GM)', {
            reason: 'need_at_least_one_player',
          });
        }

        await scope.repos.sessions.patchPhase(input.sessionId, { status: 'ACTIVE', updatedAt: nowIso() });
        await appendOutbox(
          [createEvent('SESSION_STATUS_CHANGED', { sessionId: input.sessionId, from: 'LOBBY', to: 'ACTIVE' }, traceId)],
          scope,
        );

        // Ход №1 — в той же транзакции (вложенный runInTx присоединяется, D196/ALS);
        // ключ детерминированный: повтор startSession не откроет второй ход.
        const turn = await this.turns.openTurn({
          sessionId: input.sessionId,
          idempotencyKey: `start-turn:${input.sessionId}`,
          traceId,
        });
        return { sessionId: input.sessionId, status: 'ACTIVE' as const, turnId: turn.turnId, turnNumber: turn.number };
      },
    );
    return { ...result.value, replayed: result.replayed };
  }

  /** ACTIVE→PAUSED. */
  async pauseSession(input: {
    sessionId: SessionId;
    idempotencyKey: string;
    traceId?: string;
  }): Promise<{ sessionId: SessionId; status: Session['status']; replayed: boolean }> {
    return this.changeStatus(input, 'PAUSED', 'ACTIVE', 'pauseSession');
  }

  /** PAUSED→ACTIVE. */
  async resumeSession(input: {
    sessionId: SessionId;
    idempotencyKey: string;
    traceId?: string;
  }): Promise<{ sessionId: SessionId; status: Session['status']; replayed: boolean }> {
    return this.changeStatus(input, 'ACTIVE', 'PAUSED', 'resumeSession');
  }

  /** Любой незавершённый статус → ENDED + archivedAt (D108). */
  async endSession(input: {
    sessionId: SessionId;
    reason: string;
    idempotencyKey: string;
    traceId?: string;
  }): Promise<{ sessionId: SessionId; status: Session['status']; replayed: boolean }> {
    const traceId = input.traceId ?? newTraceId();
    const key = parseIdempotencyKey(input.idempotencyKey);
    const result = await runCommand(
      this.guard,
      { key, command: 'endSession', sessionId: input.sessionId, turnId: null, traceId },
      async (scope) => {
        const session = await this.sessionIn(scope, input.sessionId);
        assertTransition('session', session.status, 'ENDED');
        const at = nowIso();
        await scope.repos.sessions.update({ ...session, status: 'ENDED', archivedAt: at, updatedAt: at });
        await appendOutbox(
          [
            createEvent(
              'SESSION_STATUS_CHANGED',
              { sessionId: input.sessionId, from: session.status, to: 'ENDED' },
              traceId,
            ),
            createEvent('SESSION_ENDED', { sessionId: input.sessionId, reason: input.reason.slice(0, 200) }, traceId),
          ],
          scope,
        );
        return { sessionId: input.sessionId, status: 'ENDED' as const };
      },
    );
    return { ...result.value, replayed: result.replayed };
  }

  /** GM удаляет игрока (KICKED). */
  async removePlayer(input: {
    sessionId: SessionId;
    playerId: PlayerId;
    idempotencyKey: string;
    traceId?: string;
  }): Promise<{ playerId: PlayerId; status: Player['status']; replayed: boolean }> {
    return this.detachPlayer(input, 'KICKED', 'kickPlayer');
  }

  /** Игрок выходит сам (LEFT). */
  async leaveSession(input: {
    sessionId: SessionId;
    playerId: PlayerId;
    idempotencyKey: string;
    traceId?: string;
  }): Promise<{ playerId: PlayerId; status: Player['status']; replayed: boolean }> {
    return this.detachPlayer(input, 'LEFT', 'leaveSession');
  }

  /** Свободный персонаж сессии (этап 1: минимально, stats пустые — F-1.20). */
  async createCharacter(input: {
    sessionId: SessionId;
    name: string;
    archetype?: string | null;
    idempotencyKey: string;
    traceId?: string;
  }): Promise<{ characterId: CharacterId; replayed: boolean }> {
    const traceId = input.traceId ?? newTraceId();
    const key = parseIdempotencyKey(input.idempotencyKey);
    const result = await runCommand(
      this.guard,
      { key, command: 'createCharacter', sessionId: input.sessionId, turnId: null, traceId },
      async (scope) => {
        const session = await this.sessionIn(scope, input.sessionId);
        if (session.status === 'ENDED') {
          throw new AppError('CONFLICT', 'сессия завершена — персонажи не создаются', { reason: 'session_ended' });
        }
        const character = CharacterSchema.parse({
          characterId: randomUUID() as CharacterId,
          sessionId: input.sessionId,
          name: input.name,
          archetype: input.archetype ?? null,
          stats: {},
          createdAt: nowIso(),
        } satisfies Character);
        await scope.repos.characters.insert(character);
        return { characterId: character.characterId };
      },
    );
    return { ...result.value, replayed: result.replayed };
  }

  // ------------------------------------------------------------------ хелперы

  private async changeStatus(
    input: { sessionId: SessionId; idempotencyKey: string; traceId?: string },
    to: 'PAUSED' | 'ACTIVE',
    expectedFrom: Session['status'],
    command: 'pauseSession' | 'resumeSession',
  ): Promise<{ sessionId: SessionId; status: Session['status']; replayed: boolean }> {
    const traceId = input.traceId ?? newTraceId();
    const key = parseIdempotencyKey(input.idempotencyKey);
    const result = await runCommand(
      this.guard,
      { key, command, sessionId: input.sessionId, turnId: null, traceId },
      async (scope) => {
        const session = await this.sessionIn(scope, input.sessionId);
        if (session.status !== expectedFrom) {
          throw new CoreError('CORE_INVALID_STATE_TRANSITION', `${command}: ожидался статус ${expectedFrom}`, {
            entity: 'session',
            from: session.status,
            to,
          });
        }
        assertTransition('session', session.status, to);
        await scope.repos.sessions.patchPhase(input.sessionId, { status: to, updatedAt: nowIso() });
        await appendOutbox(
          [createEvent('SESSION_STATUS_CHANGED', { sessionId: input.sessionId, from: session.status, to }, traceId)],
          scope,
        );
        return { sessionId: input.sessionId, status: to };
      },
    );
    return { ...result.value, replayed: result.replayed };
  }

  private async detachPlayer(
    input: { sessionId: SessionId; playerId: PlayerId; idempotencyKey: string; traceId?: string },
    reason: 'KICKED' | 'LEFT',
    command: 'kickPlayer' | 'leaveSession',
  ): Promise<{ playerId: PlayerId; status: Player['status']; replayed: boolean }> {
    const traceId = input.traceId ?? newTraceId();
    const key = parseIdempotencyKey(input.idempotencyKey);
    const result = await runCommand(
      this.guard,
      { key, command, sessionId: input.sessionId, turnId: null, traceId },
      async (scope) => {
        const session = await this.sessionIn(scope, input.sessionId);
        if (session.status === 'ENDED') {
          throw new AppError('CONFLICT', 'сессия завершена', { reason: 'session_ended' });
        }
        const player = await scope.repos.players.findById(input.playerId);
        if (!player || player.sessionId !== input.sessionId) {
          throw new CoreError('CORE_NOT_FOUND', `игрок ${input.playerId} не принадлежит сессии`, {
            entity: 'player',
            playerId: input.playerId,
          });
        }
        if (player.isGM) {
          throw new AppError('CONFLICT', 'GM не может быть удалён или выйти сам — завершите сессию (D222)', {
            reason: 'gm_cannot_leave',
          });
        }
        if (player.status === 'LEFT') {
          return { playerId: input.playerId, status: 'LEFT' as const, alreadyLeft: true };
        }
        const at = nowIso();
        // B-12.3: отзыв токенов — revokedBefore=now делает недействительными все
        // access/refresh-токены игрока, выданные до этого момента (проверка iat).
        await scope.repos.players.update({ ...player, status: 'LEFT', leftAt: at, revokedBefore: at });
        await scope.repos.sessions.update({
          ...session,
          playerIds: session.playerIds.filter((id) => id !== input.playerId),
          updatedAt: at,
        });
        await appendOutbox(
          [createEvent('PLAYER_LEFT', { sessionId: input.sessionId, playerId: input.playerId, reason }, traceId)],
          scope,
        );
        return { playerId: input.playerId, status: 'LEFT' as const, alreadyLeft: false };
      },
    );
    return { playerId: result.value.playerId, status: result.value.status, replayed: result.replayed };
  }

  private async sessionIn(scope: TxScope, sessionId: SessionId): Promise<Session> {
    const session = await scope.repos.sessions.findById(sessionId);
    if (!session) {
      throw new CoreError('CORE_NOT_FOUND', `сессия ${sessionId} не найдена`, { entity: 'session', sessionId });
    }
    return session;
  }
}
