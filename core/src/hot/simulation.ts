import {
  SceneInputAckMessageSchema,
  SimulationTick,
  type MovementInput,
  type ParticipantId,
} from '@mnemosin/contracts';

import { moveCircleWithCollisions } from './collision.js';
import { FIXED_DT } from './constants.js';
import type { HotWorldGeometry } from './geometry.js';
import type { HotPlayerState, HotQueuedInput, HotRuntimeConfig, HotSimulationState, HotStepResult } from './types.js';

/** Только направление: любой ненулевой вектор приводится к единичной длине. */
export function normalizeHotDirection(input: MovementInput): MovementInput {
  const length = Math.hypot(input.directionX, input.directionY);
  if (length === 0) return { directionX: 0, directionY: 0 };
  return { directionX: input.directionX / length, directionY: input.directionY / length };
}

function compareParticipants(a: ParticipantId, b: ParticipantId): number {
  return a.localeCompare(b);
}

function copyPlayer(player: HotPlayerState): HotPlayerState {
  return {
    ...player,
    position: { ...player.position },
    direction: { ...player.direction },
    velocity: { ...player.velocity },
  };
}

/**
 * Чистый логический тик: drain ordered inputs → lease → movement/swept collision → clock.
 * Не читает часы, таймеры, сеть или ФС и не мутирует входное состояние.
 */
export function runHotSimulationStep(
  state: HotSimulationState,
  inputs: readonly HotQueuedInput[],
  geometry: HotWorldGeometry,
  config: HotRuntimeConfig,
): HotStepResult {
  const players = [...state.players]
    .sort((a, b) => compareParticipants(a.participantId, b.participantId))
    .map(copyPlayer);
  const byParticipant = new Map(players.map((player) => [player.participantId, player]));
  const latestAccepted = new Map<ParticipantId, HotQueuedInput>();
  const orderedInputs = [...inputs].sort(
    (a, b) =>
      a.arrivalSequence - b.arrivalSequence ||
      compareParticipants(a.participantId, b.participantId) ||
      a.message.inputSequence - b.message.inputSequence,
  );

  const mutablePlayers = byParticipant.values();
  for (const queued of orderedInputs) {
    const player = byParticipant.get(queued.participantId);
    if (player === undefined || player.activeInputStreamId !== queued.message.inputStreamId) continue;
    if (
      player.lastProcessedInputSequence !== null &&
      queued.message.inputSequence <= player.lastProcessedInputSequence
    ) {
      continue;
    }

    const mutable = player as {
      -readonly [K in keyof HotPlayerState]: HotPlayerState[K];
    };
    mutable.direction = normalizeHotDirection(queued.message.input);
    mutable.lastProcessedInputSequence = queued.message.inputSequence;
    mutable.lastInputTick = state.simulationTick;
    latestAccepted.set(queued.participantId, queued);
  }

  for (const player of mutablePlayers) {
    const mutable = player as { -readonly [K in keyof HotPlayerState]: HotPlayerState[K] };
    if (player.lastInputTick === null || state.simulationTick - player.lastInputTick >= config.inputLeaseTicks) {
      mutable.direction = { directionX: 0, directionY: 0 };
    }

    const intendedVelocity = {
      x: player.direction.directionX * config.movementSpeedCellsPerSecond,
      y: player.direction.directionY * config.movementSpeedCellsPerSecond,
    };
    const movement = moveCircleWithCollisions(
      player.position,
      { x: intendedVelocity.x * FIXED_DT, y: intendedVelocity.y * FIXED_DT },
      config.entityRadius,
      config.collisionEpsilon,
      geometry,
    );
    mutable.velocity = {
      x: (movement.position.x - player.position.x) / FIXED_DT,
      y: (movement.position.y - player.position.y) / FIXED_DT,
    };
    mutable.position = movement.position;
  }

  const simulationTick = SimulationTick.parse(state.simulationTick + 1);
  const acknowledgements = players.flatMap((player) => {
    const accepted = latestAccepted.get(player.participantId);
    if (accepted === undefined) return [];
    return [
      SceneInputAckMessageSchema.parse({
        inputStreamId: accepted.message.inputStreamId,
        lastProcessedInputSequence: accepted.message.inputSequence,
        simulationTick,
        authoritativePosition: player.position,
        authoritativeVelocity: player.velocity,
      }),
    ];
  });

  return {
    state: { simulationTick, players },
    acknowledgements,
  };
}
