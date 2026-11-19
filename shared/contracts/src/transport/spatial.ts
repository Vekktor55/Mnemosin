import { z } from 'zod';
import { WorldId, FloorId, WorldSpaceId } from '../ids.js';

/**
 * Пространственные примитивы для P03–P05 (G1–G3, WORLD_SIMULATION.md §2.3).
 *
 * Правила (СОГЛАСОВАНО G2):
 * - Единица мировых координат = сторона одной клетки.
 * - X растёт вправо, Y растёт вниз.
 * - Клетка (gx, gy) занимает [gx, gx+1) × [gy, gy+1).
 * - Центр клетки = (gx+0.5, gy+0.5).
 * - Мировая позиция непрерывна, дробные значения допускаются.
 * - Клетка определяется floor(x), floor(y).
 * - НЕТ квантизации, fixed-point или snapping к центру клетки.
 */

export const WorldPositionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});
export type WorldPosition = z.infer<typeof WorldPositionSchema>;

export const GridCellSchema = z.object({
  gx: z.number().int(),
  gy: z.number().int(),
});
export type GridCell = z.infer<typeof GridCellSchema>;

/** Полная пространственная позиция с контекстом мира/этажа/пространства. */
export const SpatialPositionSchema = z.object({
  worldId: WorldId,
  floorId: FloorId,
  worldSpaceId: WorldSpaceId,
  position: WorldPositionSchema,
});
export type SpatialPosition = z.infer<typeof SpatialPositionSchema>;

/**
 * Movement input от клиента (G1, NETWORK_PROTOCOL.md §7.3, HOT_COLD_DESIGN.md §5.2).
 *
 * - Клиент отправляет удерживаемое направление, НЕ целевую позицию.
 * - directionX/Y нормализованы сервером (длина ≤ 1).
 * - Скорость, спринт и режимы движения определяются серверными правилами, не контрактом.
 * - inputSequence монотонно возрастает в пределах inputStreamId.
 */
export const MovementInputSchema = z.object({
  inputStreamId: z.string().uuid(), // InputStreamId (branded) — но в payload кладём строку для простоты сериализации
  inputSequence: z.number().int().nonnegative(),
  directionX: z.number().finite().min(-1).max(1),
  directionY: z.number().finite().min(-1).max(1),
  clientSentAt: z.number().int().nonnegative().optional(), // только диагностика
});
export type MovementInput = z.infer<typeof MovementInputSchema>;

/**
 * Scene input message (client → server, NETWORK_PROTOCOL.md §6.1: scene:input).
 */
export const SceneInputMessageSchema = z.object({
  input: MovementInputSchema,
});
export type SceneInputMessage = z.infer<typeof SceneInputMessageSchema>;

/**
 * Scene resync request (client → server, NETWORK_PROTOCOL.md §6.1: scene:resync).
 */
export const SceneResyncMessageSchema = z.object({
  lastAppliedSceneSequence: z.number().int().nonnegative().optional(),
  worldEpoch: z.number().int().nonnegative().optional(),
  reason: z.enum(['sequence_gap', 'invalid_delta', 'projection_reset', 'client_recovery']),
  snapshotId: z.string().uuid().optional(),
});
export type SceneResyncMessage = z.infer<typeof SceneResyncMessageSchema>;

/**
 * Connection ready message (client → server, NETWORK_PROTOCOL.md §6.1: connection:client-ready).
 */
export const ConnectionClientReadyMessageSchema = z.object({
  // пусто — клиент сигнализирует готовность получать keyframe
});
export type ConnectionClientReadyMessage = z.infer<typeof ConnectionClientReadyMessageSchema>;

/**
 * Connection ping (client → server, NETWORK_PROTOCOL.md §6.1: connection:ping).
 */
export const ConnectionPingMessageSchema = z.object({
  pingId: z.string().min(8).max(64),
  clientTimeMs: z.number().int().nonnegative(),
});
export type ConnectionPingMessage = z.infer<typeof ConnectionPingMessageSchema>;

/**
 * Connection welcome (server → client, NETWORK_PROTOCOL.md §6.2: connection:welcome).
 */
export const ConnectionWelcomeMessageSchema = z.object({
  protocolVersion: z.literal('v1'),
  serverVersion: z.string().max(40),
  contractsVersion: z.string().max(40),
  matchId: z.string().uuid(),
  sessionId: z.string().uuid(),
  connectionId: z.string().uuid(),
  connectionEpoch: z.number().int().nonnegative(),
  actorType: z.enum(['player', 'observer', 'developer']),
  permissions: z.array(z.string()),
  isReconnect: z.boolean(),
  supportedFeatures: z.array(z.string()),
});
export type ConnectionWelcomeMessage = z.infer<typeof ConnectionWelcomeMessageSchema>;

/**
 * Connection ready (server → client, NETWORK_PROTOCOL.md §6.2: connection:ready).
 */
export const ConnectionReadyMessageSchema = z.object({
  // пусто — initial sync completed
});
export type ConnectionReadyMessage = z.infer<typeof ConnectionReadyMessageSchema>;

/**
 * Connection pong (server → client, NETWORK_PROTOCOL.md §6.2: connection:pong).
 */
export const ConnectionPongMessageSchema = z.object({
  pingId: z.string().min(8).max(64),
  serverTimeMs: z.number().int().nonnegative(),
  simulationTick: z.number().int().nonnegative(),
});
export type ConnectionPongMessage = z.infer<typeof ConnectionPongMessageSchema>;

/**
 * Connection error (server → client, NETWORK_PROTOCOL.md §6.2: connection:error).
 */
export const ConnectionErrorMessageSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().max(500),
  retryable: z.boolean(),
  correlationId: z.string().max(64).optional(),
});
export type ConnectionErrorMessage = z.infer<typeof ConnectionErrorMessageSchema>;

/**
 * Scene input ack (server → client, NETWORK_PROTOCOL.md §6.2: scene:input-ack).
 */
export const SceneInputAckMessageSchema = z.object({
  inputStreamId: z.string().uuid(),
  lastProcessedInputSequence: z.number().int().nonnegative(),
  simulationTick: z.number().int().nonnegative(),
  authoritativePosition: WorldPositionSchema,
  authoritativeVelocity: WorldPositionSchema.optional(),
});
export type SceneInputAckMessage = z.infer<typeof SceneInputAckMessageSchema>;

/**
 * Scene resync required (server → client, NETWORK_PROTOCOL.md §6.2: scene:resync-required).
 */
export const SceneResyncRequiredMessageSchema = z.object({
  reason: z.enum(['sequence_gap', 'invalid_delta', 'projection_reset', 'client_recovery']),
  lastValidSceneSequence: z.number().int().nonnegative().optional(),
});
export type SceneResyncRequiredMessage = z.infer<typeof SceneResyncRequiredMessageSchema>;

/**
 * Command result (server → client, NETWORK_PROTOCOL.md §6.2: command:result).
 */
export const CommandResultMessageSchema = z.object({
  commandId: z.string().uuid(),
  status: z.enum(['accepted', 'rejected', 'conflict', 'already_processed']),
  resultCode: z.string().max(64).optional(),
  objectRevision: z.number().int().nonnegative().optional(),
  projectionRevision: z.number().int().nonnegative().optional(),
  eventId: z.string().uuid().optional(),
});
export type CommandResultMessage = z.infer<typeof CommandResultMessageSchema>;

/**
 * Domain event (server → client, NETWORK_PROTOCOL.md §6.2: domain:event).
 */
export const DomainEventMessageSchema = z.object({
  eventId: z.string().uuid(),
  type: z.string().min(1).max(64),
  payload: z.unknown(),
  projectionRevision: z.number().int().nonnegative().optional(),
});
export type DomainEventMessage = z.infer<typeof DomainEventMessageSchema>;

/**
 * Match projection update (server → client, NETWORK_PROTOCOL.md §6.2: match:projection).
 */
export const MatchProjectionMessageSchema = z.object({
  matchId: z.string().uuid(),
  projectionRevision: z.number().int().nonnegative(),
  payload: z.unknown(),
});
export type MatchProjectionMessage = z.infer<typeof MatchProjectionMessageSchema>;

/**
 * Observer projection (server → client, NETWORK_PROTOCOL.md §6.2: observer:projection).
 */
export const ObserverProjectionMessageSchema = z.object({
  matchId: z.string().uuid(),
  projectionRevision: z.number().int().nonnegative(),
  payload: z.unknown(), // полная скрытая игровая projection
});
export type ObserverProjectionMessage = z.infer<typeof ObserverProjectionMessageSchema>;

/**
 * Developer diagnostic (server → client, NETWORK_PROTOCOL.md §6.2: developer:diagnostic).
 */
export const DeveloperDiagnosticMessageSchema = z.object({
  diagnosticType: z.string().min(1).max(64),
  payload: z.unknown(),
});
export type DeveloperDiagnosticMessage = z.infer<typeof DeveloperDiagnosticMessageSchema>;
