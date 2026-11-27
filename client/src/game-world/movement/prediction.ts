/**
 * Client-side prediction + reconciliation (NETWORK_PROTOCOL.md §8.2–8.3,
 * HOT_COLD_DESIGN.md §5.3).
 *
 * Клиент НЕ авторитетен: `advance`/`onInput` меняют только предсказанную
 * позицию, а `authoritative` обновляется исключительно из серверного ACK/keyframe
 * через `reconcile`. Клиентское сообщение не может напрямую изменить
 * серверную позицию — это проверяет тест и архитектурная граница.
 */
import type { MovementInput, WorldPosition } from '@mnemosin/contracts';

export interface ClientPredictionConfig {
  /** PROTOTYPE-ONLY: скорость (cells/s); зеркало серверного HOT config. */
  readonly speedCellsPerSecond: number;
  /** PROTOTYPE-ONLY: фиксированный шаг серверного тика (секунды). */
  readonly fixedDtSeconds: number;
}

export interface UnackedInput {
  readonly inputSequence: number;
  readonly direction: MovementInput;
}

export interface PredictionReconcile {
  readonly lastProcessedInputSequence: number;
  readonly authoritativePosition: WorldPosition;
}

export interface PredictionSnapshot {
  readonly predicted: WorldPosition;
  readonly authoritative: WorldPosition;
  readonly pendingCount: number;
  readonly nextInputSequence: number;
}

export class ClientPrediction {
  private readonly speed: number;
  private readonly fixedDt: number;
  private authoritative: WorldPosition;
  private predicted: WorldPosition;
  private direction: MovementInput = { directionX: 0, directionY: 0 };
  private readonly unacked: UnackedInput[] = [];
  private nextSequence = 1;

  constructor(start: WorldPosition, config: ClientPredictionConfig) {
    this.speed = config.speedCellsPerSecond;
    this.fixedDt = config.fixedDtSeconds;
    this.authoritative = { x: start.x, y: start.y };
    this.predicted = { x: start.x, y: start.y };
  }

  /** Зарегистрировать новый локальный held-direction input; возвращает его sequence. */
  onInput(direction: MovementInput): number {
    this.direction = { directionX: direction.directionX, directionY: direction.directionY };
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    this.unacked.push({
      inputSequence: sequence,
      direction: { directionX: direction.directionX, directionY: direction.directionY },
    });
    return sequence;
  }

  /**
   * Плавная интеграция между серверными тиками: predicted сдвигается по текущему
   * направлению со скоростью speed за frameDt. Вызывается каждый кадр рендера.
   */
  advance(frameDtSeconds: number): WorldPosition {
    if (this.direction.directionX === 0 && this.direction.directionY === 0) return this.predicted;
    const step = this.speed * frameDtSeconds;
    this.predicted = {
      x: this.predicted.x + this.direction.directionX * step,
      y: this.predicted.y + this.direction.directionY * step,
    };
    return this.predicted;
  }

  /**
   * Reconciliation: установить серверную authoritative позицию, удалить
   * подтверждённые inputs (sequence ≤ lastProcessedInputSequence) и переиграть
   * неподтверждённые поверх baseline. Коррекция — быстрый snap, без сглаживания
   * через стены/двери (NETWORK_PROTOCOL.md §8.3).
   */
  reconcile(ack: PredictionReconcile): void {
    this.authoritative = { x: ack.authoritativePosition.x, y: ack.authoritativePosition.y };
    const cutoff = ack.lastProcessedInputSequence;
    while (this.unacked.length > 0 && (this.unacked[0]?.inputSequence ?? Number.POSITIVE_INFINITY) <= cutoff) {
      this.unacked.shift();
    }
    this.recomputePredicted();
  }

  /** Сброс при reconnect: старые inputs никогда не переигрываются. */
  reset(authoritative: WorldPosition): void {
    this.authoritative = { x: authoritative.x, y: authoritative.y };
    this.predicted = { x: authoritative.x, y: authoritative.y };
    this.direction = { directionX: 0, directionY: 0 };
    this.unacked.length = 0;
  }

  snapshot(): PredictionSnapshot {
    return {
      predicted: { x: this.predicted.x, y: this.predicted.y },
      authoritative: { x: this.authoritative.x, y: this.authoritative.y },
      pendingCount: this.unacked.length,
      nextInputSequence: this.nextSequence,
    };
  }

  private recomputePredicted(): void {
    let position = { x: this.authoritative.x, y: this.authoritative.y };
    for (const input of this.unacked) {
      const dir = input.direction;
      position = {
        x: position.x + dir.directionX * this.speed * this.fixedDt,
        y: position.y + dir.directionY * this.speed * this.fixedDt,
      };
    }
    this.predicted = position;
  }
}
