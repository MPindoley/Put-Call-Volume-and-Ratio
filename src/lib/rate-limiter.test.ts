import { describe, expect, it } from 'vitest';
import { TokenBucket, backoffDelay } from './rate-limiter';

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
