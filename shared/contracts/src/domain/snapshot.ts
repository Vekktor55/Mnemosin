import { z } from 'zod';

import { SnapshotId, SessionId, TurnId } from '../ids.js';
import { IsoDateTime } from '../time.js';
import { GameStateSchema } from './state.js';

/**
 * Snapshot — полная копия GameState для отката (v3 §I «Снимки состояния», критерий A3.x).
 *
 * Добавлен в промпте 1.4: таблица `snapshots` требовалась в схеме БД, а типа в контрактах
 * не было (gap промпта 1.2). Решение K17/D198 — снапшот хранит состояние ЦЕЛИКОМ
 * (не дельту), потому что откат должен быть возможен без воспроизведения истории.
 */
export const SnapshotSchema = z.object({
  id: SnapshotId,
  sessionId: SessionId,
  label: z.string().min(1).max(120),
  /** Номер хода, ПОСЛЕ которого сделан снимок (0 = состояние до первого хода). */
  turnNumber: z.number().int().nonnegative(),
  /** Ход, на котором снимок создан (для аудита; может отсутствовать у стартового). */
  createdByTurnId: TurnId.nullable(),
  createdBy: z.enum(['GM', 'SYSTEM']),
  state: GameStateSchema,
  /** Контрольная сумма state_json — защита от тихой порчи при хранении. */
  checksum: z.string().min(8).max(128),
  createdAt: IsoDateTime,
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const SnapshotListEntrySchema = SnapshotSchema.omit({ state: true });
export type SnapshotListEntry = z.infer<typeof SnapshotListEntrySchema>;
