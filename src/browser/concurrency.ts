/** In-process semaphore — max N concurrent browser jobs (workers). */

import { ScoutError } from '../lib/errors';

const DEFAULT_ACQUIRE_MS = 120_000;

export class BrowserConcurrencyGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private max: number) {}

  get limit(): number {
    return this.max;
  }

  get inUse(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  setLimit(max: number) {
    this.max = Math.max(1, Math.floor(max));
    while (this.active < this.max && this.waiters.length > 0) {
      this.active += 1;
      const next = this.waiters.shift();
      next?.();
    }
  }

  /**
   * Take a worker slot. Waiters inherit the permit from `release()` — do not
   * increment `active` again after waking (that leaked slots at max=1).
   */
  async acquire(timeoutMs: number = DEFAULT_ACQUIRE_MS): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const wake = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      this.waiters.push(wake);
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (settled) return;
              const idx = this.waiters.indexOf(wake);
              if (idx >= 0) this.waiters.splice(idx, 1);
              settled = true;
              reject(
                new ScoutError(
                  'TIMEOUT',
                  `Browser worker queue timed out after ${timeoutMs}ms (max_concurrent=${this.max})`,
                  { details: { max_concurrent: this.max, active_jobs: this.active } },
                ),
              );
            }, timeoutMs)
          : null;
    });
  }

  release() {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

let gate: BrowserConcurrencyGate | null = null;

export function getBrowserConcurrencyGate(): BrowserConcurrencyGate {
  if (!gate) gate = new BrowserConcurrencyGate(1);
  return gate;
}

export function setBrowserConcurrencyLimit(max: number) {
  getBrowserConcurrencyGate().setLimit(max);
}

export function getBrowserPoolStats() {
  const g = getBrowserConcurrencyGate();
  return { max_concurrent: g.limit, active_jobs: g.inUse, queued_jobs: g.queued };
}

export function browserAcquireTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SCOUT_BROWSER_ACQUIRE_MS;
  if (raw == null || raw === '') return DEFAULT_ACQUIRE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_ACQUIRE_MS;
  return n;
}
