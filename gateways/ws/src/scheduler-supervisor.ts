import type { WsHotSchedulerPort } from './deps.js';

/**
 * Возобновляет P04 scheduler после его controlled backlog pause.
 * Backlog принадлежит scheduler и при повторном start() не сбрасывается.
 */
export class HotSchedulerSupervisor {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly scheduler: WsHotSchedulerPort,
    private readonly recoveryIntervalMs: number,
  ) {
    if (!Number.isFinite(recoveryIntervalMs) || recoveryIntervalMs <= 0) {
      throw new Error('Scheduler recovery interval must be positive');
    }
  }

  start(): void {
    if (this.timer !== null) return;
    this.scheduler.start();
    this.timer = setInterval(() => {
      if (!this.scheduler.status().started) this.scheduler.start();
    }, this.recoveryIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.scheduler.stop();
  }
}
