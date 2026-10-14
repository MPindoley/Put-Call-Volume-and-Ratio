import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TickerFlow } from '@/types';
import { FlowEngine } from './flow-engine';
import { PermanentError, TokenBucket } from './rate-limiter';
import { pickHotSet, RealtimeFeed } from './realtime-feed';
import { NotConnectedError, type RealtimeChain, type SchwabClient } from './schwab';
import type { SchwabAuth, SchwabAuthStatus } from './schwab-auth';

const universe = ['A', 'B', 'C', 'D', 'E', 'F'];
const volumes: Record<string, number> = { A: 600, B: 500, C: 400, D: 300, E: 200, F: 0 };
const activity = (s: string): number => volumes[s] ?? 0;
const none = new Set<string>();

describe('pickHotSet', () => {
  it('takes pinned names plus the most active, skipping unknown activity', () => {
    const hot = pickHotSet({ universe, activity, always: new Set(['F']), size: 2, previous: none, exclude: none });
    expect([...hot].sort()).toEqual(['A', 'B', 'F']);
  });

  it('keeps a member until it falls below 1.5× the cut-off rank (no flapping)', () => {
    // C ranks third with size 2: out for a newcomer, kept as a member (rank 2 < 3).
    expect(pickHotSet({ universe, activity, always: none, size: 2, previous: none, exclude: none }).has('C')).toBe(false);
    expect(pickHotSet({ universe, activity, always: none, size: 2, previous: new Set(['C']), exclude: none }).has('C')).toBe(true);
    // D ranks fourth: beyond 1.5 × 2, so it leaves.
    expect(pickHotSet({ universe, activity, always: none, size: 2, previous: new Set(['D']), exclude: none }).has('D')).toBe(false);
  });

  it('leaves out names the source cannot serve, even pinned ones', () => {
    const hot = pickHotSet({ universe, activity, always: new Set(['A']), size: 2, previous: none, exclude: new Set(['A']) });
    expect([...hot].sort()).toEqual(['B', 'C']);
  });
});

describe('RealtimeFeed.cycle', () => {
  const saved = process.env.SITE_PASSWORD;
  beforeEach(() => {
    process.env.SITE_PASSWORD = 'pw';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SITE_PASSWORD;
    else process.env.SITE_PASSWORD = saved;
  });

  function setup(state: SchwabAuthStatus['state'], fetchChain: (symbol: string) => Promise<RealtimeChain>) {
    const engine = new FlowEngine();
    const auth = {
      lastError: null,
      status: async (): Promise<SchwabAuthStatus> => ({ state, authorizedAt: 1, reconnectBy: 2, lastError: null, persisted: true }),
    } as unknown as SchwabAuth;
    const fetched: string[] = [];
    const client = {
      bucket: new TokenBucket(600),
      getRealtimeChain: async (symbol: string) => {
        fetched.push(symbol);
        return fetchChain(symbol);
      },
    } as unknown as SchwabClient;
    const published: TickerFlow[][] = [];
    const feed = new RealtimeFeed(engine, auth, client, {
      intervalMs: 20_000,
      hotSize: 3,
      concurrency: 2,
      universe: () => universe,
      activity,
      pinned: () => ({ watch: none, benchmarks: none }),
      shouldIdle: () => false,
      publish: async (rows) => {
        published.push(rows);
      },
    });
    return { engine, feed, fetched, published };
  }

  const chainFor = (symbol: string): RealtimeChain => ({
    agg: {
      symbol,
      putVolume: 100,
      callVolume: 200,
      putPremium: 1_000,
      callPremium: 2_000,
      underlyingPrice: 50,
      priceChangePct: 1,
      contractsSeen: 3,
      largestContractVolume: 50,
      iv30: null,
      iv30Change: null,
      asOf: Date.now(),
    },
    delayed: false,
    priceAt: Date.now(),
  });

  it('fetches the hot set, ingests real-time rows and publishes them', async () => {
    const { engine, feed, fetched, published } = setup('connected', async (s) => chainFor(s));
    await feed.cycle();
    expect(fetched.sort()).toEqual(['A', 'B', 'C']);
    expect(published).toHaveLength(1);
    expect(engine.getFlow('A')?.livePrice).toBe(50);
    expect(engine.realtimeFeed?.state).toBe('polling');
    expect(engine.realtimeFeed?.hotSetSize).toBe(3);
  });

  it('drops names Schwab cannot serve for the rest of the session', async () => {
    const { engine, feed, fetched } = setup('connected', async (s) => {
      if (s === 'A') throw new PermanentError('schwab: no chain for A (FAILED)');
      return chainFor(s);
    });
    await feed.cycle();
    expect(engine.realtimeFeed?.unsupported).toBe(1);
    fetched.length = 0;
    await feed.cycle();
    expect(fetched).not.toContain('A');
    expect(fetched).toContain('D'); // the freed slot goes to the next name
  });

  it('does nothing but report when not signed in, expired, or the site is open', async () => {
    const signedOut = setup('disconnected', async (s) => chainFor(s));
    await signedOut.feed.cycle();
    expect(signedOut.fetched).toHaveLength(0);
    expect(signedOut.engine.realtimeFeed?.state).toBe('signed-out');

    const expired = setup('expired', async (s) => chainFor(s));
    await expired.feed.cycle();
    expect(expired.engine.realtimeFeed?.state).toBe('expired');

    delete process.env.SITE_PASSWORD;
    const open = setup('connected', async (s) => chainFor(s));
    await open.feed.cycle();
    expect(open.fetched).toHaveLength(0);
    expect(open.engine.realtimeFeed?.state).toBe('unlocked');
  });

  it('stops the pass at the first sign-in failure', async () => {
    const { feed, fetched, published } = setup('connected', async () => {
      throw new NotConnectedError('schwab not connected');
    });
    await feed.cycle();
    expect(published).toHaveLength(0);
    expect(fetched.length).toBeLessThanOrEqual(2); // at most one per worker
  });
});
