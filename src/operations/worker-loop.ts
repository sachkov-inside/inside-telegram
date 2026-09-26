import { reportFailure } from "../shared/failure-diagnostics.js";

export interface WorkerPacing {
  /** Delay before the next cycle after a cycle that found work. */
  readonly busyMs: number;
  /** Upper bound of the delay that doubles after every cycle that found nothing. */
  readonly idleMs: number;
}

/**
 * Runs one background cycle repeatedly: soon again while it finds work, then less and less
 * often while it finds none. `wake` starts the next cycle at once when new work arrives.
 * `stop` stops scheduling, signals the running cycle and waits for it to settle, so no cycle
 * outlives the database pool.
 */
export class WorkerLoop {
  private readonly controller = new AbortController();
  private running: Promise<void> | undefined;
  private timer?: NodeJS.Timeout;
  private delayMs: number;
  private woken = false;
  private started = false;

  constructor(
    private readonly name: string,
    private readonly cycle: (signal: AbortSignal) => Promise<boolean>,
    private readonly pacing: WorkerPacing,
  ) {
    this.delayMs = pacing.busyMs;
  }

  start(): void {
    if (this.started || this.controller.signal.aborted) return;
    this.started = true;
    this.schedule(0);
  }

  wake(): void {
    if (!this.started || this.controller.signal.aborted) return;
    if (this.running) this.woken = true;
    else this.schedule(0);
  }

  async stop(): Promise<void> {
    this.controller.abort();
    clearTimeout(this.timer);
    await this.running;
  }

  private schedule(delayMs: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), delayMs);
    this.timer.unref();
  }

  private run(): void {
    if (this.running || this.controller.signal.aborted) return;
    this.running = this.cycle(this.controller.signal)
      .catch((error: unknown) => {
        reportFailure(`worker.${this.name}`, error);
        return false;
      })
      .then((foundWork) => {
        this.running = undefined;
        if (this.controller.signal.aborted) return;
        const again = foundWork || this.woken;
        this.woken = false;
        this.delayMs = again
          ? this.pacing.busyMs
          : Math.min(this.pacing.idleMs, this.delayMs * 2);
        this.schedule(this.delayMs);
      });
  }
}
