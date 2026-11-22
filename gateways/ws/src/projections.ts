import type {
  ObserverProjection,
  ParticipantId,
  PlayerProjection,
  PlayerSceneEntity,
  SceneEnvironment,
  SceneObject,
} from '@mnemosin/contracts';

import type { WsHiddenFactSource, WsHotSimulationState, WsStaticScene } from './deps.js';

export interface SceneProjectionInput {
  readonly state: WsHotSimulationState;
  readonly environment: SceneEnvironment;
  readonly objects: readonly SceneObject[];
}

function publicEntity(player: WsHotSimulationState['players'][number]): PlayerSceneEntity {
  return {
    participantId: player.participantId,
    position: { ...player.position },
    velocity: { ...player.velocity },
  };
}

/** DTO фильтруется до JSON.stringify: hiddenRole/infected здесь даже не читаются. */
export function buildPlayerProjection(input: SceneProjectionInput): PlayerProjection {
  return {
    projectionKind: 'player',
    entities: input.state.players.map(publicEntity),
    objects: input.objects.map((object) => ({ ...object, position: { ...object.position } })),
    environment: { ...input.environment },
  };
}

/** Observer получает игровые факты из отдельного порта, не infrastructure credentials. */
export function buildObserverProjection(
  input: SceneProjectionInput,
  hiddenFacts: WsHiddenFactSource,
): ObserverProjection {
  return {
    projectionKind: 'observer',
    entities: input.state.players.map((player) => ({
      ...publicEntity(player),
      ...hiddenFacts.hiddenFact(player.participantId),
    })),
    objects: input.objects.map((object) => ({ ...object, position: { ...object.position } })),
    environment: { ...input.environment },
  };
}

export function buildProjection(
  kind: 'player' | 'observer',
  state: WsHotSimulationState,
  scene: WsStaticScene,
  hiddenFacts?: WsHiddenFactSource,
): PlayerProjection | ObserverProjection {
  const input = { state, environment: scene.environment, objects: scene.objects };
  if (kind === 'player') return buildPlayerProjection(input);
  if (hiddenFacts === undefined) throw new Error('ObserverProjection требует server-side hidden fact source');
  return buildObserverProjection(input, hiddenFacts);
}

export function ownActorState(
  state: WsHotSimulationState,
  participantId: ParticipantId,
): PlayerSceneEntity | undefined {
  const player = state.players.find((candidate) => candidate.participantId === participantId);
  return player === undefined ? undefined : publicEntity(player);
}
