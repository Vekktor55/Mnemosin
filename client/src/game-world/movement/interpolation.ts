/**
 * Интерполяция удалённых сущностей (NETWORK_PROTOCOL.md §8.4–8.5,
 * HOT_COLD_DESIGN.md §5.4).
 *
 * Кольцевой буфер snapshot'ов по participantId; линейная интерполяция с
 * задержкой ~100 мс и ограниченной экстраполяцией (~100 мс) по последней
 * velocity с последующим удержанием позиции. Дискретные переходы (двери,
 * захват, смена этажа) не интерполируются — они вне P05-B.
 */
import type { WorldPosition } from '@mnemosin/contracts';

export interface RemoteSnapshot {
  readonly simulationTick: number;
  readonly serverTimeMs: number;
  readonly position: WorldPosition;
  readonly velocity: WorldPosition;
}

export interface InterpolationConfig {
  /** PROTOTYPE-ONLY: задержка рендера позади server time (~100 мс). */
  readonly interpolationDelayMs: number;
  /** PROTOTYPE-ONLY: максимум экстраполяции при потере snapshot (~100 мс). */
  readonly extrapolationLimitMs: number;
  /** Ёмкость кольцевого буфера на сущность. */
  readonly maxBufferSize: number;
}

export class InterpolationBuffer {
  private readonly config: InterpolationConfig;
  private readonly buffers = new Map<string, RemoteSnapshot[]>();

  constructor(config: InterpolationConfig) {
    this.config = Object.freeze({ ...config });
  }

  /** Добавить snapshot (монотонно по simulationTick; устаревшие игнорируются). */
  add(participantId: string, snapshot: RemoteSnapshot): void {
    const buffer = this.buffers.get(participantId) ?? [];
    const last = buffer[buffer.length - 1];
    if (last !== undefined && snapshot.simulationTick <= last.simulationTick) return;
    buffer.push({
      simulationTick: snapshot.simulationTick,
      serverTimeMs: snapshot.serverTimeMs,
      position: { x: snapshot.position.x, y: snapshot.position.y },
      velocity: { x: snapshot.velocity.x, y: snapshot.velocity.y },
    });
    while (buffer.length > this.config.maxBufferSize) buffer.shift();
    this.buffers.set(participantId, buffer);
  }

  /** Визуальная позиция сущности на renderServerTimeMs; null — сущность неизвестна. */
  sample(participantId: string, renderServerTimeMs: number): WorldPosition | null {
    const buffer = this.buffers.get(participantId);
    if (buffer === undefined || buffer.length === 0) return null;
    const target = renderServerTimeMs - this.config.interpolationDelayMs;
    const first = buffer[0];
    const last = buffer[buffer.length - 1];
    if (first === undefined || last === undefined) return null;

    if (target <= first.serverTimeMs) return { x: first.position.x, y: first.position.y };

    if (target >= last.serverTimeMs) {
      const overshoot = Math.min(target - last.serverTimeMs, this.config.extrapolationLimitMs);
      return {
        x: last.position.x + (last.velocity.x * overshoot) / 1000,
        y: last.position.y + (last.velocity.y * overshoot) / 1000,
      };
    }

    for (let index = 0; index < buffer.length - 1; index += 1) {
      const before = buffer[index];
      const after = buffer[index + 1];
      if (before === undefined || after === undefined) continue;
      if (target >= before.serverTimeMs && target <= after.serverTimeMs) {
        const span = after.serverTimeMs - before.serverTimeMs;
        if (span <= 0) return { x: before.position.x, y: before.position.y };
        const t = (target - before.serverTimeMs) / span;
        return {
          x: before.position.x + (after.position.x - before.position.x) * t,
          y: before.position.y + (after.position.y - before.position.y) * t,
        };
      }
    }
    return { x: last.position.x, y: last.position.y };
  }

  /** Сброс всех буферов (reconnect / новый worldEpoch). */
  reset(): void {
    this.buffers.clear();
  }

  /** Удалить сущность (entityRemovals). */
  remove(participantId: string): void {
    this.buffers.delete(participantId);
  }

  participantIds(): string[] {
    return [...this.buffers.keys()];
  }
}
