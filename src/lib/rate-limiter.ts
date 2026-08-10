/**
 * Token-bucket rate limiter with a priority queue, sized per data source
 * (MASSIVE_RPM / CBOE_RPM). Watched/spiking tickers are fetched first; on
 * tight budgets the poller drains the queue and cycles the universe fairly.
 */

interface QueueItem {
  priority: number;
  resolve: () => void;
}

export class TokenBucket {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private lastRefill = Date.now();
  private queue: QueueItem[] = [];
  private timer: NodeJS.Timeout | null = null;
  private callTimestamps: number[] = [];
  /** While Date.now() < this, no token is issued (see penalize). */
  private cooldownUntil = 0;

  constructor(callsPerMinute: number) {
    this.capacity = Math.max(1, callsPerMinute);
    // Start partly filled, not full. A full bucket lets the whole per-minute
    // budget fire in one instant — measured at ~1180 req/min effective against
    // a 60/min setting — and an opening burst of that many multi-MB chain
    // requests is precisely what trips a CDN's rate limiter at boot. The
    // bucket reaches full capacity within the minute either way, so this costs
    // nothing in steady state.
    this.tokens = Math.max(1, Math.ceil(this.capacity / 4));
    this.refillPerMs = this.capacity / 60_000;
  }

  /**
   * The source said "too many requests". That is a statement about the whole
   * client, not about one unlucky symbol, so pause every issue for a moment
   * instead of letting each in-flight request retry independently — the latter
   * is what turns a single 429 into a cascade.
   */
  penalize(ms: number): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + ms);
  }

  /** True while a 429 cooldown is in effect (surfaced for logging/tests). */
  get cooling(): boolean {
    return Date.now() < this.cooldownUntil;
  }

  /** Resolves when a token is available. Lower priority number = served first. */
  acquire(priority = 5): Promise<void> {
    this.refill();
    if (this.tokens >= 1 && this.queue.length === 0 && !this.cooling) {
      this.tokens -= 1;
      this.recordCall();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push({ priority, resolve });
      this.queue.sort((a, b) => a.priority - b.priority);
      this.schedule();
    });
  }

  /** Calls made in the trailing 60 seconds — surfaced in the status bar. */
  callsLastMinute(): number {
    const cutoff = Date.now() - 60_000;
    this.callTimestamps = this.callTimestamps.filter((t) => t > cutoff);
    return this.callTimestamps.length;
  }

  get perMinute(): number {
    return this.capacity;
  }

  private recordCall(): void {
    this.callTimestamps.push(Date.now());
    if (this.callTimestamps.length > this.capacity * 3) this.callsLastMinute();
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.lastRefill) * this.refillPerMs);
    this.lastRefill = now;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.refill();
        if (!this.cooling) {
          while (this.tokens >= 1 && this.queue.length > 0) {
            this.tokens -= 1;
            this.recordCall();
            this.queue.shift()?.resolve();
          }
        }
        if (this.queue.length > 0) this.schedule();
      },
      // Wait out any cooldown before the next drain attempt.
      Math.max(50, 1 / this.refillPerMs, this.cooldownUntil - Date.now()),
    );
  }
}

/**
 * Exponential backoff with JITTER for 429s and transient failures.
 *
 * The jitter is not cosmetic. A plain `base * 2**attempt` schedule is
 * deterministic, so N requests that fail together retry at exactly the same
 * instants and keep colliding — observed in production as ten symbols marching
 * through attempts 1-4 in perfect lockstep, each round re-triggering the 429
 * that caused it. Spreading each delay over [50%, 150%] decorrelates them.
 */
export function backoffDelay(attempt: number, baseDelayMs: number, rand = Math.random): number {
  return Math.round(baseDelayMs * 2 ** attempt * (0.5 + rand()));
}

export async function withBackoff<T>(
  fn: () => Promise<T>,
  { retries = 4, baseDelayMs = 2_000, label = 'request' }: { retries?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === retries) break;
      const delay = backoffDelay(attempt, baseDelayMs);
      console.warn(`[backoff] ${label} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms:`, err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
