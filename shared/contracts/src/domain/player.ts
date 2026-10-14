import { z } from 'zod';
import { IsoDateTime } from '../time.js';
import { CharacterId, PlayerId, Scalar, SessionId } from '../ids.js';

/**
 * Player и Character (v3 §II.3 + D157: имя персонажа задаёт игрок).
 * Характеристики персонажа не в Core — они в `stats` как непрозрачные данные
 * или в `player_extensions` (F-1.20, инвариант 1).
 */

export const PlayerStatus = z.enum(['ACTIVE', 'DISCONNECTED', 'LEFT', 'SPECTATOR']);
export type PlayerStatus = z.infer<typeof PlayerStatus>;

export const CharacterSchema = z.object({
  characterId: CharacterId,
  sessionId: SessionId,
  /** D157: имя задаёт игрок при join. В UI видно всегда; в нарративе — только
   *  после флага `remembered_name.<playerId>` (D173/K13). */
  name: z.string().min(1).max(60),
  archetype: z.string().max(60).nullable(),
  /** Непрозрачные характеристики: интерпретируются модулями, не Core (K12). */
  stats: z.record(z.string().max(60), Scalar),
  createdAt: IsoDateTime,
});
export type Character = z.infer<typeof CharacterSchema>;

export const PlayerSchema = z.object({
  playerId: PlayerId,
  sessionId: SessionId,
  characterId: CharacterId,
  displayName: z.string().min(1).max(60),
  isGM: z.boolean(),
  status: PlayerStatus,
  /** Отзыв токенов (B-12): токен недействителен, если iat < revokedBefore. */
  revokedBefore: IsoDateTime.nullable(),
  joinedAt: IsoDateTime,
  leftAt: IsoDateTime.nullable(),
});
export type Player = z.infer<typeof PlayerSchema>;

/** Данные модуля о игроке (v3 §II.3 заметка, F-1.20). */
export const PlayerExtensionSchema = z.object({
  playerId: PlayerId,
  moduleId: z.string().min(1).max(60),
  data: z.record(z.string().max(60), z.unknown()),
  updatedAt: IsoDateTime,
});
export type PlayerExtension = z.infer<typeof PlayerExtensionSchema>;
