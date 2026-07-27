/**
 * The health route is a platform deploy gate (Railway healthcheck), so its
 * status mapping is load-bearing: returning 503 while the market is closed
 * makes any night/weekend/holiday release fail to come up. These cases pin
 * liveness (is the process serving?) apart from freshness (is data recent?).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFlowEngine } from '@/lib/flow-engine';
import { GET } from './route';

// 14:00 ET on each date (July 2026 is EDT, UTC-4).
const WEDNESDAY = new Date('2026-07-15T18:00:00Z'); // regular session
const SATURDAY = new Date('2026-07-18T18:00:00Z'); // weekend
const JULY_4TH_OBSERVED = new Date('2026-07-03T18:00:00Z'); // market holiday

function setNow(d: Date): void {
  vi.useFakeTimers();
  vi.setSystemTime(d);
}

describe('GET /api/health', () => {
  beforeEach(() => {
    getFlowEngine().lastPollAt = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    getFlowEngine().lastPollAt = 0;
  });

  it('is 200 "idle" at the weekend — the poller idles by design', async () => {
    setNow(SATURDAY);
    const res = GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ state: 'idle' });
  });

  it('is 200 "idle" on a market holiday', async () => {
    setNow(JULY_4TH_OBSERVED);
    const res = GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ state: 'idle' });
  });

  it('is 200 "starting" during a session before the first cycle lands', async () => {
    setNow(WEDNESDAY);
    getFlowEngine().lastPollAt = 0;
    const res = GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ state: 'starting' });
  });

  it('is 200 "ok" during a session with a recent poll', async () => {
    setNow(WEDNESDAY);
    getFlowEngine().lastPollAt = Date.now();
    const res = GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ state: 'ok' });
  });

  it('is 503 "stale" only when the poller dies during a session', async () => {
    setNow(WEDNESDAY);
    getFlowEngine().lastPollAt = Date.now() - 5 * 60_000;
    const res = GET();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ state: 'stale' });
  });
});
