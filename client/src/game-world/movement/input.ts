/**
 * Movement input: WASD/стрелки, удерживаемое направление (G1, NETWORK_PROTOCOL.md §7).
 *
 * Клиент отправляет ТОЛЬКО направление (held direction), никогда конечную
 * позицию или скорость. Нормализация — та же, что и на сервере: ненулевой
 * вектор приводится к единичной длине, (0,0) останавливает движение.
 */
import type { MovementInput } from '@mnemosin/contracts';

export type MoveKey = 'up' | 'down' | 'left' | 'right';

/** Нормализация направления (диагональ не быстрее оси). */
export function normalizeDirection(dx: number, dy: number): MovementInput {
  const length = Math.hypot(dx, dy);
  if (length <= 1e-9) return { directionX: 0, directionY: 0 };
  return { directionX: dx / length, directionY: dy / length };
}

/** Удерживаемые клавиши → нормализованное направление движения. */
export function directionFromKeys(keys: Readonly<Record<MoveKey, boolean>>): MovementInput {
  const dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
  return normalizeDirection(dx, dy);
}

/** `KeyboardEvent.code` → ось движения. */
const KEY_TO_AXIS: Readonly<Record<string, MoveKey>> = Object.freeze({
  KeyW: 'up',
  ArrowUp: 'up',
  KeyS: 'down',
  ArrowDown: 'down',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
});

export interface KeyEventLike {
  readonly code: string;
}

export interface EventTargetLike {
  addEventListener(type: 'keydown', listener: (event: KeyEventLike) => void): void;
  removeEventListener(type: 'keydown', listener: (event: KeyEventLike) => void): void;
  addEventListener(type: 'keyup', listener: (event: KeyEventLike) => void): void;
  removeEventListener(type: 'keyup', listener: (event: KeyEventLike) => void): void;
}

export interface BlurTargetLike {
  addEventListener(type: 'blur', listener: () => void): void;
  removeEventListener(type: 'blur', listener: () => void): void;
}

export interface VisibilityTargetLike {
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/**
 * Отслеживание удерживаемых клавиш движения. Сброс при потере фокуса окна и
 * при уходе вкладки в фон (visibilitychange → hidden): клиент не должен
 * «прокручивать» движение, пока вкладка неактивна.
 */
export class KeyboardInputController {
  private readonly pressed = new Set<MoveKey>();
  private direction: MovementInput = { directionX: 0, directionY: 0 };
  private onChange: (() => void) | null = null;
  private target: EventTargetLike | null = null;
  private windowTarget: BlurTargetLike | null = null;
  private visibilityTarget: VisibilityTargetLike | null = null;

  private readonly onKeyDown = (event: KeyEventLike): void => {
    const axis = KEY_TO_AXIS[event.code];
    if (axis === undefined || this.pressed.has(axis)) return;
    this.pressed.add(axis);
    this.recompute();
  };

  private readonly onKeyUp = (event: KeyEventLike): void => {
    const axis = KEY_TO_AXIS[event.code];
    if (axis === undefined || !this.pressed.has(axis)) return;
    this.pressed.delete(axis);
    this.recompute();
  };

  private readonly onBlur = (): void => {
    this.clearAll();
  };

  private readonly onVisibility = (): void => {
    if (typeof document !== 'undefined' && document.hidden) this.clearAll();
  };

  attach(target: EventTargetLike, windowTarget: BlurTargetLike, visibilityTarget: VisibilityTargetLike): void {
    this.detach();
    this.target = target;
    this.windowTarget = windowTarget;
    this.visibilityTarget = visibilityTarget;
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    windowTarget.addEventListener('blur', this.onBlur);
    visibilityTarget.addEventListener('visibilitychange', this.onVisibility);
  }

  detach(): void {
    if (this.target !== null) {
      this.target.removeEventListener('keydown', this.onKeyDown);
      this.target.removeEventListener('keyup', this.onKeyUp);
    }
    if (this.windowTarget !== null) this.windowTarget.removeEventListener('blur', this.onBlur);
    if (this.visibilityTarget !== null)
      this.visibilityTarget.removeEventListener('visibilitychange', this.onVisibility);
    this.target = null;
    this.windowTarget = null;
    this.visibilityTarget = null;
  }

  current(): MovementInput {
    return this.direction;
  }

  setOnChange(listener: (() => void) | null): void {
    this.onChange = listener;
  }

  private recompute(): void {
    const next = directionFromKeys({
      up: this.pressed.has('up'),
      down: this.pressed.has('down'),
      left: this.pressed.has('left'),
      right: this.pressed.has('right'),
    });
    const changed = next.directionX !== this.direction.directionX || next.directionY !== this.direction.directionY;
    this.direction = next;
    if (changed) this.onChange?.();
  }

  private clearAll(): void {
    this.pressed.clear();
    this.recompute();
  }
}
