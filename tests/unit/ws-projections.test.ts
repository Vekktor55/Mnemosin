import { describe, expect, it, vi } from 'vitest';

import {
  InputSequence,
  InputStreamId,
  ObjectId,
  ObserverProjectionSchema,
  ParticipantId,
  PlayerProjectionSchema,
  ProjectionRevision,
  SimulationTick,
  WorldEpoch,
  WorldId,
  FloorId,
  WorldSpaceId,
  type ObserverProjection,
  type PlayerProjection,
} from '@mnemosin/contracts';
import {
  buildObserverProjection,
  buildPlayerProjection,
  buildProjection,
  type WsHiddenFactSource,
  type WsHotSimulationState,
  type WsStaticScene,
} from '@mnemosin/gateway-ws';

const uuid = (suffix: string) => `00000000-0000-4000-8000-${suffix}`;

const ids = {
  participantId: ParticipantId.parse(uuid('000000000001')),
  objectId: ObjectId.parse(uuid('000000000002')),
  inputStreamId: InputStreamId.parse(uuid('000000000003')),
  worldId: WorldId.parse(uuid('000000000004')),
  floorId: FloorId.parse(uuid('000000000005')),
  worldSpaceId: WorldSpaceId.parse(uuid('000000000006')),
};

const infrastructureSecrets = {
  databaseUrl: 'postgres://projection-test:do-not-leak@database/mnemosin',
  jwtSecret: 'projection-test-jwt-secret',
  providerApiKey: 'projection-test-provider-api-key',
};

const stateWithServerOnlyFields = {
  simulationTick: SimulationTick.parse(12),
  infrastructureSecrets,
  players: [
    {
      participantId: ids.participantId,
      position: { x: 1.5, y: 2.5 },
      velocity: { x: 0.25, y: -0.5 },
      direction: { directionX: 1, directionY: 0 },
      activeInputStreamId: ids.inputStreamId,
      lastProcessedInputSequence: InputSequence.parse(4),
      lastInputTick: SimulationTick.parse(11),
      hiddenRole: 'raw-state-role-must-not-leak',
      infected: false,
      infrastructureSecrets,
    },
  ],
};
const state: WsHotSimulationState = stateWithServerOnlyFields;

const sceneWithServerOnlyFields = {
  worldPackVersion: '4.0.0-test',
  worldEpoch: WorldEpoch.parse(3),
  projectionRevision: ProjectionRevision.parse(7),
  environment: {
    worldId: ids.worldId,
    floorId: ids.floorId,
    worldSpaceId: ids.worldSpaceId,
  },
  objects: [
    {
      objectId: ids.objectId,
      position: { x: 4, y: 5 },
      portalState: 'closed' as const,
    },
  ],
  infrastructureSecrets,
};
const scene: WsStaticScene = sceneWithServerOnlyFields;
const input = { state, environment: scene.environment, objects: scene.objects };

function expectNoInfrastructureSecrets(serialized: string): void {
  expect(serialized).not.toContain('infrastructureSecrets');
  for (const secret of Object.values(infrastructureSecrets)) expect(serialized).not.toContain(secret);
}

describe('WS projection privacy at the JSON boundary', () => {
  it('serializes a PlayerProjection without hiddenRole, infected or infrastructure secrets', () => {
    const hiddenFact = vi.fn(() => ({ hiddenRole: 'observer-only-role', infected: true }));
    const projection: PlayerProjection = buildProjection('player', state, scene, { hiddenFact });
    const serialized = JSON.stringify(projection);
    const wireProjection: PlayerProjection = PlayerProjectionSchema.parse(JSON.parse(serialized));

    expect(hiddenFact).not.toHaveBeenCalled();
    expect(wireProjection).toEqual({
      projectionKind: 'player',
      entities: [
        {
          participantId: ids.participantId,
          position: { x: 1.5, y: 2.5 },
          velocity: { x: 0.25, y: -0.5 },
        },
      ],
      objects: [{ objectId: ids.objectId, position: { x: 4, y: 5 }, portalState: 'closed' }],
      environment: scene.environment,
    });
    expect(serialized).not.toContain('hiddenRole');
    expect(serialized).not.toContain('infected');
    expectNoInfrastructureSecrets(serialized);
  });

  it('serializes observer gameplay facts but no infrastructure secrets', () => {
    const hiddenFacts: WsHiddenFactSource = {
      hiddenFact: vi.fn(() => ({ hiddenRole: 'observer-only-role', infected: true })),
    };
    const projection: ObserverProjection = buildObserverProjection(input, hiddenFacts);
    const serialized = JSON.stringify(projection);
    const parsedObserver: ObserverProjection = ObserverProjectionSchema.parse(JSON.parse(serialized));

    expect(PlayerProjectionSchema.safeParse(JSON.parse(serialized)).success).toBe(false);
    expect(parsedObserver).toEqual({
      projectionKind: 'observer',
      entities: [
        {
          participantId: ids.participantId,
          position: { x: 1.5, y: 2.5 },
          velocity: { x: 0.25, y: -0.5 },
          hiddenRole: 'observer-only-role',
          infected: true,
        },
      ],
      objects: input.objects,
      environment: input.environment,
    });
    expect(parsedObserver.entities[0]?.hiddenRole).toBe('observer-only-role');
    expect(parsedObserver.entities[0]?.infected).toBe(true);
    expect(serialized).not.toContain('raw-state-role-must-not-leak');
    expectNoInfrastructureSecrets(serialized);
  });

  it('keeps the direct player builder on the same allowlisted DTO', () => {
    const projection = buildPlayerProjection(input);
    const wireProjection: unknown = JSON.parse(JSON.stringify(projection));

    expect(PlayerProjectionSchema.safeParse(wireProjection).success).toBe(true);
    expectNoInfrastructureSecrets(JSON.stringify(wireProjection));
  });
});
