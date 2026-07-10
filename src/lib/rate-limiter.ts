/**
 * Token-bucket rate limiter with a priority queue, sized to the Polygon plan
 * (POLYGON_RPM). Watched/spiking tickers are fetched first; on the free tier
 * the poller simply drains the queue at 5 calls/min and cycles the universe.
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

  constructor(callsPerMinute: number) {
    this.capacity = Math.max(1, callsPerMinute);
    this.tokens = this.capacity;
    this.refillPerMs = this.capacity / 60_000;
  }

  /** Resolves when a token is available. Lower priority number = served first. */
  acquire(priority = 5): Promise<void> {
    this.refill();
    if (this.tokens >= 1 && this.queue.length === 0) {
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
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refill();
      while (this.tokens >= 1 && this.queue.length > 0) {
        this.tokens -= 1;
        this.recordCall();
        this.queue.shift()?.resolve();
      }
      if (this.queue.length > 0) this.schedule();
    }, Math.max(50, 1 / this.refillPerMs));
  }
}

/** Exponential backoff helper for 429s and transient failures. */
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
      const delay = baseDelayMs * 2 ** attempt;
      console.warn(`[backoff] ${label} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms:`, err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
