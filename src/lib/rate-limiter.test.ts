import { describe, expect, it, vi } from 'vitest';
import { PermanentError, TokenBucket, backoffDelay, withBackoff } from './rate-limiter';

/**
 * These pin the two bugs that produced a live 429 cascade: retries that were
 * not metered (one token bought up to 5 real requests) and a deterministic
 * backoff that made concurrent failures retry in lockstep forever.
 */
describe('backoffDelay', () => {
  it('grows exponentially in expectation', () => {
    const mid = () => 0.5; // jitter factor 1.0
    expect(backoffDelay(0, 2000, mid)).toBe(2000);
    expect(backoffDelay(1, 2000, mid)).toBe(4000);
    expect(backoffDelay(2, 2000, mid)).toBe(8000);
  });

  it('spreads each delay over [50%, 150%] so herds decorrelate', () => {
    expect(backoffDelay(0, 2000, () => 0)).toBe(1000);
    expect(backoffDelay(0, 2000, () => 0.999)).toBeCloseTo(2998, -1);
  });

  it('gives different delays to simultaneous failures', () => {
    // The live bug: ten symbols retrying at exactly the same instants.
    const delays = new Set(Array.from({ length: 20 }, () => backoffDelay(1, 2000)));
    expect(delays.size).toBeGreaterThan(1);
  });
});

describe('TokenBucket cooldown', () => {
  it('issues freely before any penalty', async () => {
    const b = new TokenBucket(60);
    expect(b.cooling).toBe(false);
    await expect(b.acquire()).resolves.toBeUndefined();
  });

  it('stops issuing while a 429 penalty is in effect', () => {
    const b = new TokenBucket(60);
    b.penalize(15_000);
    expect(b.cooling).toBe(true);
  });

  it('keeps the longest penalty rather than letting a later, shorter one shorten it', () => {
    const b = new TokenBucket(60);
    b.penalize(15_000);
    b.penalize(1); // a second 429 must not cut the cooldown short
    expect(b.cooling).toBe(true);
  });

  it('clears once the penalty elapses', async () => {
    const b = new TokenBucket(600);
    b.penalize(60);
    expect(b.cooling).toBe(true);
    await new Promise((r) => setTimeout(r, 120));
    expect(b.cooling).toBe(false);
    await expect(b.acquire()).resolves.toBeUndefined();
  });

  it('queues rather than rejecting while cooling, then drains', async () => {
    const b = new TokenBucket(600);
    b.penalize(80);
    const started = Date.now();
    await b.acquire();
    // Must have waited for the cooldown, not been served immediately.
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
  });

  it('reports its configured ceiling', () => {
    expect(new TokenBucket(60).perMinute).toBe(60);
  });
});

describe('withBackoff and permanent errors', () => {
  it('does not retry an error retrying cannot fix', async () => {
    let calls = 0;
    await expect(
      withBackoff(
        async () => {
          calls += 1;
          throw new PermanentError('cboe 403');
        },
        { retries: 4, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('cboe 403');
    expect(calls).toBe(1);
  });
});

describe('TokenBucket adapts to 429s', () => {
  it('cuts the rate by a quarter on a 429 — once per pause, however many requests report it', () => {
    const b = new TokenBucket(90);
    b.penalize(15_000);
    b.penalize(15_000); // other in-flight requests hitting the same 429
    b.penalize(15_000);
    expect(b.currentPerMinute).toBe(67);
    expect(b.perMinute).toBe(90); // the configured ceiling is unchanged
  });

  it('never drops below a third of the ceiling', () => {
    const b = new TokenBucket(90);
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 20; i++) {
        b.penalize(1_000);
        vi.advanceTimersByTime(1_001);
      }
      expect(b.currentPerMinute).toBe(30);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers 5% of the ceiling per quiet minute, up to the ceiling', () => {
    vi.useFakeTimers();
    try {
      const b = new TokenBucket(100);
      b.penalize(1_000); // 100 → 75
      vi.advanceTimersByTime(1_000 + 60_000);
      expect(b.currentPerMinute).toBe(80);
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(60_000);
        b.currentPerMinute; // refill happens on access
      }
      expect(b.currentPerMinute).toBe(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it('banks no tokens during a pause, so it does not end in a burst', async () => {
    vi.useFakeTimers();
    try {
      const b = new TokenBucket(600); // 10 tokens/s, ~50 bankable
      b.penalize(5_000);
      vi.advanceTimersByTime(5_000);
      let served = 0;
      for (let i = 0; i < 20; i++) void b.acquire().then(() => (served += 1));
      await vi.advanceTimersByTimeAsync(10); // just after the pause
      expect(served).toBeLessThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('banks at most ~5 seconds of budget', async () => {
    vi.useFakeTimers();
    try {
      const b = new TokenBucket(120); // 2/s → at most 10 banked
      vi.advanceTimersByTime(10 * 60_000); // a long idle spell
      let served = 0;
      for (let i = 0; i < 50; i++) void b.acquire().then(() => (served += 1));
      await vi.advanceTimersByTimeAsync(10);
      expect(served).toBeLessThanOrEqual(10);
    } finally {
      vi.useRealTimers();
    }
  });
});
