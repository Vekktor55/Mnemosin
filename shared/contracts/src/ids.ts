import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Branded ID (v3 §II.1, инвариант 17: `string` без бренда не проходит границу модуля).
 *
 * Реализация через `.brand()`, а НЕ через `.pipe(s.brand())` — дефект F-1.13 аудита:
 * pipe-обёртка ломает вывод типа и несовместима с Zod 4. Мажор Zod зафиксирован (D160).
 */

export const SessionId = z.string().uuid().brand<'SessionId'>();
export const PlayerId = z.string().uuid().brand<'PlayerId'>();
export const CharacterId = z.string().uuid().brand<'CharacterId'>();
export const TurnId = z.string().uuid().brand<'TurnId'>();
export const ActionId = z.string().uuid().brand<'ActionId'>();
export const EventId = z.string().uuid().brand<'EventId'>();
export const LocationId = z.string().uuid().brand<'LocationId'>();
export const ObjectId = z.string().uuid().brand<'ObjectId'>();
export const MediaJobId = z.string().uuid().brand<'MediaJobId'>();
export const AudioJobId = z.string().uuid().brand<'AudioJobId'>();
export const ConnectionId = z.string().uuid().brand<'ConnectionId'>();
export const NoteId = z.string().uuid().brand<'NoteId'>();
export const MessageId = z.string().uuid().brand<'MessageId'>();
export const SnapshotId = z.string().uuid().brand<'SnapshotId'>();

export type SessionId = z.infer<typeof SessionId>;
export type PlayerId = z.infer<typeof PlayerId>;
export type CharacterId = z.infer<typeof CharacterId>;
export type TurnId = z.infer<typeof TurnId>;
export type ActionId = z.infer<typeof ActionId>;
export type EventId = z.infer<typeof EventId>;
export type LocationId = z.infer<typeof LocationId>;
export type ObjectId = z.infer<typeof ObjectId>;
export type MediaJobId = z.infer<typeof MediaJobId>;
export type AudioJobId = z.infer<typeof AudioJobId>;
export type ConnectionId = z.infer<typeof ConnectionId>;
export type NoteId = z.infer<typeof NoteId>;
export type MessageId = z.infer<typeof MessageId>;
export type SnapshotId = z.infer<typeof SnapshotId>;

/**
 * Ключ идемпотентности: не uuid, а произвольная строка 16–128 символов —
 * клиент генерирует её на операцию и переиспользует при ретраях (v3 §III.2).
 * Серверные детерминированные ключи (`resolve:{turnId}`) тоже проходят по длине.
 */
export const IdempotencyKey = z.string().min(16).max(128).brand<'IdempotencyKey'>();
export type IdempotencyKey = z.infer<typeof IdempotencyKey>;

/**
 * Slug — человекочитаемый идентификатор шаблона (`loc_reception`, `obj_doll`).
 * Используется только в world-pack'ах до инстанцирования; в сессии заменяется на UUID
 * с сохранением таблицы remap (аудит §8.7, D164).
 */
export const Slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,59}$/, 'slug: строчные латиница/цифры, "_" и "-", до 60 символов')
  .brand<'Slug'>();
export type Slug = z.infer<typeof Slug>;

/**
 * Ключ флага (D174, поправка K5): глобальные флаги — `snake_case` (`mnemosin_name_known`),
 * локальные — `<room_id>.<flag>` (`floor0_airlock.group_awake`).
 * Точка разрешена: в патче аудита §8.2 она была исключена из charset при том, что
 * примеры v3 её используют, — исправлено решением D167.
 */
export const FlagKey = z
  .string()
  .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,79}$/, 'flagKey: [a-zA-Z0-9_.:-], 1–80 символов, не начинается с точки')
  .brand<'FlagKey'>();
export type FlagKey = z.infer<typeof FlagKey>;

/** Идентификатор хоста GM-машины в HostBridge (v3 §V.10) — не uuid. */
export const HostId = z.string().min(1).max(64).brand<'HostId'>();
export type HostId = z.infer<typeof HostId>;

/** Скалярные значения состояния (флаги, ambient, objectStates). */
export const Scalar = z.union([z.boolean(), z.number(), z.string().max(500)]);
export type Scalar = z.infer<typeof Scalar>;

// --- v4 common identifiers (P02) ---

/** Идентификатор матча/партии — отдельный от SessionId для будущего Match aggregate. */
export const MatchId = z.string().uuid().brand<'MatchId'>();
export type MatchId = z.infer<typeof MatchId>;

/** Идентификатор участника матча (player/observer/developer в контексте конкретного матча). */
export const ParticipantId = z.string().uuid().brand<'ParticipantId'>();
export type ParticipantId = z.infer<typeof ParticipantId>;

/** Идентификатор игрового мира/комплекса. */
export const WorldId = z.string().uuid().brand<'WorldId'>();
export type WorldId = z.infer<typeof WorldId>;

/** Идентификатор этажа. */
export const FloorId = z.string().uuid().brand<'FloorId'>();
export type FloorId = z.infer<typeof FloorId>;

/** Идентификатор мирового пространства (координатной области этажа). */
export const WorldSpaceId = z.string().uuid().brand<'WorldSpaceId'>();
export type WorldSpaceId = z.infer<typeof WorldSpaceId>;

/** Версия/эпоха активного экземпляра игрового мира (инкрементируется при смене этажа/World Pack). */
export const WorldEpoch = z.number().int().nonnegative().brand<'WorldEpoch'>();
export type WorldEpoch = z.infer<typeof WorldEpoch>;

/** Идентификатор команды (COLD command) — для идемпотентности и корреляции. */
export const CommandId = z.string().uuid().brand<'CommandId'>();
export type CommandId = z.infer<typeof CommandId>;

/** Идентификатор потока ввода движения (connection epoch / input stream). */
export const InputStreamId = z.string().uuid().brand<'InputStreamId'>();
export type InputStreamId = z.infer<typeof InputStreamId>;

/** Порядковый номер ввода в пределах одного input stream (monotonic). */
export const InputSequence = z.number().int().nonnegative().brand<'InputSequence'>();
export type InputSequence = z.infer<typeof InputSequence>;

/** Порядковый номер scene replication update (monotonic per projection stream). */
export const SceneSequence = z.number().int().nonnegative().brand<'SceneSequence'>();
export type SceneSequence = z.infer<typeof SceneSequence>;

/** Номер HOT simulation tick. */
export const SimulationTick = z.number().int().nonnegative().brand<'SimulationTick'>();
export type SimulationTick = z.infer<typeof SimulationTick>;

/** Ревизия COLD projection / read model. */
export const ProjectionRevision = z.number().int().nonnegative().brand<'ProjectionRevision'>();
export type ProjectionRevision = z.infer<typeof ProjectionRevision>;

/** Порядковый номер durable event в пределах match/world epoch. */
export const EventSequence = z.number().int().nonnegative().brand<'EventSequence'>();
export type EventSequence = z.infer<typeof EventSequence>;

/** Поколение соединения (connection epoch). */
export const ConnectionEpoch = z.number().int().nonnegative().brand<'ConnectionEpoch'>();
export type ConnectionEpoch = z.infer<typeof ConnectionEpoch>;

export function newId(): string {
  return randomUUID();
}

/**
 * Типизированный конструктор ID. Единственный легальный способ получить брендовое
 * значение вне Zod-парсинга (фикстуры, тесты, инстанцирование world-pack).
 */
export function id<T extends z.ZodTypeAny>(schema: T, value: string): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`invalid id for schema: ${value} (${parsed.error.issues[0]?.message ?? 'unknown'})`);
  }
  return parsed.data;
}
