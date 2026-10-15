import {
  CoreError,
  DirectorContextSchema,
  GMStateViewSchema,
  type DirectorContext,
  type GMStateView,
  type GmAuditEntry,
  type JournalEntry,
} from '@mnemosin/contracts';
import { toGmLocationView, toPublicLocationView } from '@mnemosin/core';
import type { GmServiceDeps } from './deps.js';
import type { InspectAIContextInput, InspectJournalInput, InspectStateInput, ListAuditInput } from './contract.js';

/**
 * GM-инспекция (промпт 1.9, п.5; v3 §IV.8, K11/K7).
 *
 * inspectState → GMStateView: публичная проекция (PublicGameStateView) +
 * GM-блок (локации c gmSecret, знания всех игроков, детали флагов, ВСЕ заметки,
 * очередь ревью). GM_ONLY-заметки попадают ТОЛЬКО в GM-часть представления —
 * в публичной проекции (view.session) их нет (тест промта 1.9 п.9; полная
 * проверка приватности — property-based тест 1.11).
 *
 * inspectAIContext → DirectorContext из журнала 'ai_context_built' (D121:
 * контекст хранится в journal, а не в отдельной таблице — см. ARCHITECTURE §1.12).
 */

export async function inspectState(deps: GmServiceDeps, rawInput: InspectStateInput): Promise<GMStateView> {
  const repos = deps.uow.repos();
  const session = await repos.sessions.findById(rawInput.sessionId);
  if (session === null) {
    throw new CoreError('CORE_NOT_FOUND', `сессия ${rawInput.sessionId} не найдена`, { entity: 'session' });
  }
  const state = await repos.state.findBySession(rawInput.sessionId);
  if (state === null) {
    throw new CoreError('CORE_NOT_FOUND', `состояние сессии ${rawInput.sessionId} не найдено`, {
      entity: 'game_state',
    });
  }

  const [players, characters, locationDefs, notes, turns] = await Promise.all([
    repos.players.listBySession(rawInput.sessionId),
    repos.characters.listBySession(rawInput.sessionId),
    repos.locations.listAll(),
    repos.gmNotes.listBySession(rawInput.sessionId, 500),
    repos.turns.listBySession(rawInput.sessionId, 200),
  ]);
  const nameByCharacter = new Map(characters.map((character) => [character.characterId, character.name]));
  const sessionLocations = locationDefs.filter((location) => location.sessionId === rawInput.sessionId);
  const currentDef = sessionLocations.find((location) => location.locationId === state.worldState.currentLocationId);

  const view = {
    session: {
      sessionId: state.sessionId,
      version: state.version,
      currentLocation: currentDef === undefined ? null : toPublicLocationView(currentDef, state),
      timeOfDay: state.worldState.timeOfDay,
      weather: state.worldState.weather,
      storyFlags: Object.fromEntries(
        Object.entries(state.storyFlags)
          .filter((entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] !== undefined)
          .map(([key, flag]) => [key, flag.value]),
      ),
      objectStates: Object.values(state.objectStates)
        .filter((objectState) => objectState !== undefined)
        .map((objectState) => ({
          objectId: objectState.objectId,
          visible: objectState.visible,
          taken: objectState.taken,
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
    },
    locations: sessionLocations.map((location) => toGmLocationView(location, state)),
    knowledgeByPlayer: Object.fromEntries(
      Object.values(state.playerKnowledge)
        .filter((knowledge) => knowledge !== undefined)
        .map((knowledge) => [knowledge.playerId, knowledge.entries]),
    ),
    flagsDetail: Object.values(state.storyFlags)
      .filter((flag) => flag !== undefined)
      .map((flag) => ({
        key: flag.key,
        value: flag.value,
        setBy: flag.setBy,
        setAtTurnId: flag.setAtTurnId,
      })),
    // GM-часть: ВСЕ заметки (включая GM_ONLY) — представление только для ведущего.
    notes: notes.map((note) => ({
      noteId: note.noteId,
      visibility: note.visibility,
      text: note.text,
      createdAt: note.createdAt,
    })),
    pendingReviews: turns.filter((turn) => turn.status === 'REVIEW').map((turn) => turn.turnId),
    // Этап 1: отложенных эффектов нет (Event Engine — 2.1); media-джобы — этап 2.
    deferredEffects: [],
  };
  return GMStateViewSchema.parse(view);
}

/**
 * Последний DirectorContext хода — из журнала 'ai_context_built' (D121).
 * ai-director пишет её при каждой сборке контекста (промпт 1.7 + 1.9).
 */
export async function inspectAIContext(deps: GmServiceDeps, input: InspectAIContextInput): Promise<DirectorContext> {
  const entries = await deps.services.journal.list(input.turnId);
  const contextEntries = entries.filter((entry) => entry.kind === 'ai_context_built');
  const last = contextEntries.at(-1);
  if (last === undefined) {
    throw new CoreError('CORE_NOT_FOUND', `AI-контекст хода ${input.turnId} не найден (сборка — в resolveTurn)`, {
      entity: 'ai_context',
      turnId: input.turnId,
    });
  }
  const parsed = DirectorContextSchema.safeParse(last.payload['context']);
  if (!parsed.success) {
    throw new CoreError('CORE_NOT_FOUND', `AI-контекст хода ${input.turnId} повреждён`, {
      entity: 'ai_context',
      turnId: input.turnId,
    });
  }
  return parsed.data;
}

export async function inspectJournal(deps: GmServiceDeps, input: InspectJournalInput): Promise<JournalEntry[]> {
  const turn = await deps.uow.repos().turns.findById(input.turnId);
  if (turn === null) {
    throw new CoreError('CORE_NOT_FOUND', `ход ${input.turnId} не найден`, { entity: 'turn' });
  }
  return deps.services.journal.list(input.turnId);
}

/** Лента аудита GM (для GET /gm/audit в 1.10); свежие сверху. */
export async function listAudit(deps: GmServiceDeps, input: ListAuditInput): Promise<GmAuditEntry[]> {
  const limit = input.limit ?? 200;
  const entries = await deps.uow.repos().gmAudit.listBySession(input.sessionId, Math.min(1000, limit * 2));
  const since = input.since;
  const filtered = since !== undefined ? entries.filter((entry) => entry.at > since) : entries;
  return filtered.slice(0, limit);
}
