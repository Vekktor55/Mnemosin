import { FIXED_DT_MS } from './constants.js';
import type { HotTickDiagnostics, HotTickResult } from './types.js';

export interface HotTimerAdapter {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface HotSchedulerDiagnostics extends HotTickDiagnostics {
  readonly eventLoopLagMs: number;
  readonly backlogMs: number;
  readonly catchUpStep: number;
  readonly pausedForBacklog: boolean;
}

export interface HotTickSchedulerOptions {
  readonly tick: () => HotTickResult;
  readonly now?: () => number;
  readonly timers?: HotTimerAdapter;
  /** PROTOTYPE-ONLY: ограничение catch-up, не игровое правило. */
  readonly maxCatchUpSteps?: number;
  readonly onDiagnostics?: (diagnostics: HotSchedulerDiagnostics) => void;
}

export interface HotSchedulerStatus {
  readonly started: boolean;
  readonly backlogMs: number;
  readonly maxCatchUpSteps: number;
}

const systemTimers: HotTimerAdapter = {
  setInterval(callback, intervalMs) {
    const timer = setInterval(callback, intervalMs);
    timer.unref?.();
    return timer;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/** Regular timer + accumulator; FIXED_DT остаётся внутри каждого simulation step. */
export class HotTickScheduler {
  private readonly tick: () => HotTickResult;
  private readonly now: () => number;
  private readonly timers: HotTimerAdapter;
  private readonly maxCatchUpSteps: number;
  private readonly onDiagnostics: ((diagnostics: HotSchedulerDiagnostics) => void) | undefined;
  private timer: unknown = null;
  private started = false;
  private lastNow: number | null = null;
  private accumulatorMs = 0;

  constructor(options: HotTickSchedulerOptions) {
    const maxCatchUpSteps = options.maxCatchUpSteps ?? 5;
    if (!Number.isSafeInteger(maxCatchUpSteps) || maxCatchUpSteps <= 0) {
      throw new Error('HOT scheduler: maxCatchUpSteps должен быть положительным safe integer');
    }
    this.tick = options.tick;
    this.now = options.now ?? (() => performance.now());
    this.timers = options.timers ?? systemTimers;
    this.maxCatchUpSteps = maxCatchUpSteps;
    this.onDiagnostics = options.onDiagnostics;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.lastNow = this.now();
    this.timer = this.timers.setInterval(() => this.runOnce(), FIXED_DT_MS);
  }

  stop(): void {
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.timer = null;
    this.started = false;
    this.lastNow = null;
    this.accumulatorMs = 0;
  }

  status(): HotSchedulerStatus {
    return { started: this.started, backlogMs: this.accumulatorMs, maxCatchUpSteps: this.maxCatchUpSteps };
  }

  /** Публичный deterministic pump для адаптеров/тестов; timer вызывает тот же метод. */
  runOnce(): void {
    if (!this.started || this.lastNow === null) return;
    const current = this.now();
    const elapsedMs = Math.max(0, current - this.lastNow);
    this.lastNow = current;
    this.accumulatorMs += elapsedMs;
    const eventLoopLagMs = Math.max(0, elapsedMs - FIXED_DT_MS);

    let catchUpStep = 0;
    while (this.accumulatorMs >= FIXED_DT_MS && catchUpStep < this.maxCatchUpSteps) {
      this.accumulatorMs -= FIXED_DT_MS;
      const result = this.tick();
      catchUpStep += 1;
      const pausedForBacklog = catchUpStep === this.maxCatchUpSteps && this.accumulatorMs >= FIXED_DT_MS;
      if (pausedForBacklog) this.pauseForBacklog();
      this.onDiagnostics?.({
        ...result.diagnostics,
        eventLoopLagMs,
        backlogMs: this.accumulatorMs,
        catchUpStep,
        pausedForBacklog,
      });
    }
  }

  private pauseForBacklog(): void {
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.timer = null;
    this.started = false;
    this.lastNow = null;
    // Backlog НЕ отбрасывается: start() возобновит его без выдуманных игровых секунд.
  }
}
