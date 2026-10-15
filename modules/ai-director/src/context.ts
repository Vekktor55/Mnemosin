import {
  AppError,
  CoreError,
  DirectorContextSchema,
  type Character,
  type DirectorContext,
  type GameState,
  type ObjectState,
  type Player,
  type StoryFlag,
  type TurnId,
} from '@mnemosin/contracts';
import { toAiLocationView, type UnitOfWork } from '@mnemosin/core';

// D244: проекция живёт в core (нужна ещё и gm.inspectState); реэкспорт сохраняет поверхность 1.7.
export { toAiLocationView };

/**
 * Сборка DirectorContext (промпт 1.7, п.7; v3 §V.1, §IV.4).
 *
 * Этап 1 — упрощённая сборка (по тексту промта): токен-бюджет и тримминг
 * истории — промпт 2.5. Всё чтение — через порты UnitOfWork (модуль не знает
 * про БД, D161/инвариант 8). Результат ОБЯЗАН пройти DirectorContextSchema.parse
 * (инвариант 16): контекст, не прошедший схему, модели не отдаётся.
 */

export interface BuildContextDeps {
  readonly uow: UnitOfWork;
}

export interface BuildContextInput {
  readonly turnId: TurnId;
  /** Базовые указания Директору из config (limits.aiDirectorInstructions). */
  readonly directorInstructions: string;
}

export interface BuiltContext {
  readonly context: DirectorContext;
  /** Версия GameState на момент сборки — baseVersion черновика (optimistic lock, 1.8). */
  readonly baseVersion: number;
}

/** Максимумы схемы: storyFacts ≤300, gmNotesForAI ≤500 на элемент. */
const FACT_MAX = 300;
const NOTE_MAX = 500;

export async function buildDirectorContext(deps: BuildContextDeps, input: BuildContextInput): Promise<BuiltContext> {
  const repos = deps.uow.repos();

  const turn = await repos.turns.findById(input.turnId);
  if (turn === null) {
    throw new CoreError('CORE_NOT_FOUND', `ход ${input.turnId} не найден`, { entity: 'turn', turnId: input.turnId });
  }

  const state = await repos.state.findBySession(turn.sessionId);
  if (state === null) {
    throw new CoreError('CORE_NOT_FOUND', `состояние сессии ${turn.sessionId} не найдено`, {
      entity: 'game_state',
      sessionId: turn.sessionId,
    });
  }

  const location = await repos.locations.findById(state.worldState.currentLocationId);
  if (location === null) {
    throw new CoreError('CORE_LOCATION_NOT_FOUND', `локация ${state.worldState.currentLocationId} не найдена`, {
      locationId: state.worldState.currentLocationId,
    });
  }

  const [actions, players, characters, gmNotes] = await Promise.all([
    repos.actions.listByTurn(turn.turnId),
    repos.players.listBySession(turn.sessionId),
    repos.characters.listBySession(turn.sessionId),
    repos.gmNotes.listBySession(turn.sessionId),
  ]);

  const visiblePlayerActions = [...actions].sort((a, b) => a.sequenceId - b.sequenceId);
  const characterNames = buildCharacterNames(players, characters);

  const draft: DirectorContext = {
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    turnNumber: turn.number,
    currentLocation: toAiLocationView(location, state),
    visiblePlayerActions,
    relevantState: {
      timeOfDay: state.worldState.timeOfDay,
      weather: state.worldState.weather,
      activeFlags: Object.fromEntries(
        Object.entries(state.storyFlags)
          .filter((entry): entry is [string, StoryFlag] => entry[1] !== undefined)
          .map(([key, flag]) => [key, flag.value]),
      ),
      objectStates: Object.values(state.objectStates)
        .filter((objectState): objectState is ObjectState => objectState !== undefined)
        .map((objectState) => ({
          objectId: objectState.objectId,
          locationId: objectState.locationId,
          visible: objectState.visible,
          taken: objectState.taken,
          state: objectState.state,
        })),
    },
    // Инвариант v2 §26: модели разрешены только зарегистрированные события локации.
    allowedEventIds: location.registeredEventIds,
    // Этап 1: каталога определений событий в БД нет (remap.stage1.json: events={});
    // тела событий и aiGuidance по ним приходят в world-pack этапа 2 (2.1/2.4).
    allowedEvents: [],
    storyFacts: buildStoryFacts(state, players, characters),
    gmNotesForAI: gmNotes
      .filter((note) => note.visibility === 'AI_DIRECTOR')
      .map((note) => truncate(note.text, NOTE_MAX)),
    directorInstructions: input.directorInstructions,
    // D157: имена задают игроки и видны всегда; ограничение нарратива по флагу
    // remembered_name.<playerId> (K13/D173) включает namePolicy в промпте 2.5.
    characterNames,
    namePolicy: 'ALL',
    tokensEstimate: null,
  };

  const withEstimate: DirectorContext = {
    ...draft,
    tokensEstimate: Math.ceil(JSON.stringify(draft).length / 4),
  };

  const parsed = DirectorContextSchema.safeParse(withEstimate);
  if (!parsed.success) {
    // Внутренний дефект сборки (не данные игроков): значения полей не логируем.
    const issues = parsed.error.issues.slice(0, 10).map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new AppError('VALIDATION', `DirectorContext не прошёл схему: ${issues.join('; ')}`, {
      turnId: input.turnId,
      issuePaths: parsed.error.issues.slice(0, 10).map((issue) => issue.path.join('.')),
    });
  }
  return { context: parsed.data, baseVersion: state.version };
}

/** K13: имена персонажей для нарратива — все активные участники, включая GM. */
function buildCharacterNames(
  players: readonly Player[],
  characters: readonly Character[],
): Array<{ playerId: DirectorContext['characterNames'][number]['playerId']; name: string }> {
  const nameByCharacter = new Map(characters.map((character) => [character.characterId, character.name]));
  return players
    .filter((player) => player.status === 'ACTIVE' || player.status === 'DISCONNECTED')
    .map((player) => ({
      playerId: player.playerId,
      name: nameByCharacter.get(player.characterId) ?? player.displayName,
    }));
}

/** storyFacts: флаги партии + знания игроков (промпт 1.7: «из playerKnowledge/флагов»). */
function buildStoryFacts(state: GameState, players: readonly Player[], characters: readonly Character[]): string[] {
  const facts: string[] = [];
  for (const [key, flag] of Object.entries(state.storyFlags)) {
    if (flag === undefined) continue;
    facts.push(truncate(`Флаг партии: ${key} = ${String(flag.value)}`, FACT_MAX));
  }
  const nameByCharacter = new Map(characters.map((character) => [character.characterId, character.name]));
  const nameByPlayer = new Map(
    players.map((player) => [player.playerId, nameByCharacter.get(player.characterId) ?? player.displayName]),
  );
  for (const knowledge of Object.values(state.playerKnowledge)) {
    if (knowledge === undefined) continue;
    const who = nameByPlayer.get(knowledge.playerId) ?? 'безымянный';
    for (const entry of knowledge.entries) {
      facts.push(truncate(`${who} знает: ${entry.key} = ${String(entry.value)} (${entry.source})`, FACT_MAX));
    }
  }
  return facts;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
