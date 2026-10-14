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
  /** Configured requests/minute — the most this bucket will ever issue. */
  private readonly ceiling: number;
  /** Current allowed rate: cut on a 429, recovered while quiet (AIMD). */
  private rate: number;
  private readonly floor: number;
  private lastRefill = Date.now();
  private lastIncrease = Date.now();
  private queue: QueueItem[] = [];
  private timer: NodeJS.Timeout | null = null;
  private callTimestamps: number[] = [];
  /** While Date.now() < this, no token is issued (see penalize). */
  private cooldownUntil = 0;

  constructor(callsPerMinute: number) {
    this.ceiling = Math.max(1, callsPerMinute);
    this.rate = this.ceiling;
    this.floor = Math.max(1, Math.ceil(this.ceiling / 3));
    // Start with only a few seconds of budget, not a minute's: a full bucket
    // lets the whole per-minute budget fire in one instant (measured at ~1180
    // req/min effective against a 60/min setting), and an opening burst of
    // multi-MB chain requests is precisely what trips a CDN's rate limiter.
    this.tokens = this.burst;
  }

  /**
   * The most tokens that can be banked: ~5 seconds of budget. Average
   * throughput is set by the refill rate alone; the cap only bounds bursts.
   * Measured live: with a minute's worth bankable, quiet spells (a 429 pause,
   * a slow chain) were followed by bursts of 20+ requests — the request rate
   * swung 45 → 135/min — and each burst drew the next 429.
   */
  private get burst(): number {
    return Math.max(1, Math.ceil(this.rate / 12));
  }

  private get refillPerMs(): number {
    return this.rate / 60_000;
  }

  /**
   * The source said "too many requests". That is a statement about the whole
   * client, not about one unlucky symbol, so pause every issue for a moment
   * instead of letting each in-flight request retry independently — the latter
   * is what turns a single 429 into a cascade. Then resume SLOWER: the rate is
   * cut by a quarter (once per pause, however many in-flight requests report
   * the same 429) and recovers by 5% of the ceiling per quiet minute — the
   * CDN's tolerance varies with its load (worst near the close), so a fixed
   * rate is either too slow most of the day or too fast at the busiest times.
   * Nothing accrues during the pause, so it ends without a burst.
   */
  penalize(ms: number): void {
    const now = Date.now();
    if (!this.cooling && this.rate > this.floor) {
      this.rate = Math.max(this.floor, Math.floor(this.rate * 0.75));
      console.warn(`[rate] 429 — easing to ${this.rate}/min (ceiling ${this.ceiling}/min)`);
    }
    this.cooldownUntil = Math.max(this.cooldownUntil, now + ms);
    this.tokens = 0;
    this.lastRefill = this.cooldownUntil;
    this.lastIncrease = this.cooldownUntil;
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

  /** The configured ceiling (requests/minute). */
  get perMinute(): number {
    return this.ceiling;
  }

  /** The rate currently allowed — at or below the ceiling after recent 429s. */
  get currentPerMinute(): number {
    this.refill();
    return this.rate;
  }

  private recordCall(): void {
    this.callTimestamps.push(Date.now());
    if (this.callTimestamps.length > this.ceiling * 3) this.callsLastMinute();
  }

  private refill(): void {
    const now = Date.now();
    if (now < this.lastRefill) return; // still inside a 429 pause: nothing accrues
    if (this.rate < this.ceiling && now - this.lastIncrease >= 60_000) {
      this.rate = Math.min(this.ceiling, this.rate + Math.max(1, Math.round(this.ceiling * 0.05)));
      this.lastIncrease = now;
    }
    this.tokens = Math.min(this.burst, this.tokens + (now - this.lastRefill) * this.refillPerMs);
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

/**
 * An error that retrying cannot fix (e.g. HTTP 403/404: the source does not
 * serve that symbol). withBackoff rethrows it at once instead of spending ~30 s
 * and four more rate-limit tokens on the same answer.
 */
export class PermanentError extends Error {
  readonly permanent = true;
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
      if (err instanceof PermanentError || attempt === retries) break;
      const delay = backoffDelay(attempt, baseDelayMs);
      console.warn(`[backoff] ${label} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms:`, err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
