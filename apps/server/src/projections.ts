import {
  CoreError,
  PlayerGameStateViewSchema,
  PublicGameStateViewSchema,
  SessionViewSchema,
  type PlayerId,
  type PublicGameStateView,
  type SessionId,
  type SessionView,
} from '@mnemosin/contracts';
import { toPublicLocationView, type UnitOfWork } from '@mnemosin/core';

/**
 * Проекции состояния (K11; промпт 1.10, п.2) — wiring-слой собирает view из
 * репозиториев (порты core) и чистых построителей core/views. Транспорт
 * (gateways/http) только отдаёт результат: инвариант 14 — никакой доменной
 * логики в gateways, проекции — здесь и в core.
 */

export interface ProjectionProviderImpl {
  sessionView(sessionId: SessionId): Promise<SessionView>;
  publicGameState(sessionId: SessionId): Promise<PublicGameStateView>;
  playerGameState(
    sessionId: SessionId,
    playerId: PlayerId,
  ): Promise<{ playerId: PlayerId; version: number; knowledge: unknown[] }>;
}

export function buildProjectionProvider(uow: UnitOfWork): ProjectionProviderImpl {
  return {
    async sessionView(sessionId) {
      const repos = uow.repos();
      const session = await repos.sessions.findById(sessionId);
      if (session === null) {
        throw new CoreError('CORE_NOT_FOUND', `сессия ${sessionId} не найдена`, { entity: 'session' });
      }
      const [players, characters, state] = await Promise.all([
        repos.players.listBySession(sessionId),
        repos.characters.listBySession(sessionId),
        repos.state.findBySession(sessionId),
      ]);
      const nameByCharacter = new Map(characters.map((character) => [character.characterId, character.name]));
      return SessionViewSchema.parse({
        sessionId: session.sessionId,
        title: session.title,
        status: session.status,
        players: players.map((player) => ({
          playerId: player.playerId,
          displayName: player.displayName,
          characterName: nameByCharacter.get(player.characterId) ?? player.displayName,
          isGM: player.isGM,
          status: player.status,
        })),
        gmPlayerId: session.gmPlayerId,
        currentTurnId: session.currentTurnId,
        currentLocationId: state?.worldState.currentLocationId ?? null,
        worldPackId: session.worldPackId,
        worldPackVersion: session.worldPackVersion,
        createdAt: session.createdAt,
      });
    },

    async publicGameState(sessionId) {
      const repos = uow.repos();
      const state = await repos.state.findBySession(sessionId);
      if (state === null) {
        throw new CoreError('CORE_NOT_FOUND', `состояние сессии ${sessionId} не найдено`, { entity: 'game_state' });
      }
      const [players, characters, currentDef] = await Promise.all([
        repos.players.listBySession(sessionId),
        repos.characters.listBySession(sessionId),
        repos.locations.findById(state.worldState.currentLocationId),
      ]);
      const nameByCharacter = new Map(characters.map((character) => [character.characterId, character.name]));
      return PublicGameStateViewSchema.parse({
        sessionId: state.sessionId,
        version: state.version,
        // B-10: публичная проекция — только видимые объекты, без hiddenExits/requiresFlag.
        currentLocation: currentDef === null ? null : toPublicLocationView(currentDef, state),
        timeOfDay: state.worldState.timeOfDay,
        weather: state.worldState.weather,
        storyFlags: Object.fromEntries(
          Object.entries(state.storyFlags)
            .filter((entry) => entry[1] !== undefined)
            .map(([key, flag]) => [key, flag!.value]),
        ),
        objectStates: Object.values(state.objectStates)
          .filter((objectState) => objectState !== undefined)
          .map((objectState) => ({
            objectId: objectState!.objectId,
            visible: objectState!.visible,
            taken: objectState!.taken,
          })),
        players: players.map((player) => ({
          playerId: player.playerId,
          displayName: player.displayName,
          characterName: nameByCharacter.get(player.characterId) ?? player.displayName,
          isGM: player.isGM,
          status: player.status,
        })),
        endingId: state.endingState?.endingId ?? null,
        updatedAt: state.updatedAt,
      });
    },

    async playerGameState(sessionId, playerId) {
      const state = await uow.repos().state.findBySession(sessionId);
      if (state === null) {
        throw new CoreError('CORE_NOT_FOUND', `состояние сессии ${sessionId} не найдено`, { entity: 'game_state' });
      }
      // TARGETED: знания ТОЛЬКО этого игрока (K11).
      return PlayerGameStateViewSchema.parse({
        playerId,
        version: state.version,
        knowledge: state.playerKnowledge[playerId]?.entries ?? [],
      });
    },
  };
}
