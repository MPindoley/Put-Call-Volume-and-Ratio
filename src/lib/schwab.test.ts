import { describe, expect, it } from 'vitest';
import { PermanentError } from './rate-limiter';
import { ChainTruncatedError, normalizeSchwabChain, NotConnectedError, SchwabClient, type SchwabChainResponse } from './schwab';
import {
  authorizeUrl,
  openToken,
  REFRESH_TOKEN_LIFETIME_MS,
  SchwabAuth,
  schwabConfig,
  sealToken,
  type SchwabTokens,
  type TokenPersistence,
} from './schwab-auth';

const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const MIN = 60_000;

const cfg = schwabConfig({
  SCHWAB_APP_KEY: 'app-key',
  SCHWAB_APP_SECRET: 'app-secret',
  SCHWAB_CALLBACK_URL: 'https://flow.example.com/api/schwab/callback',
  SCHWAB_API_BASE: 'https://schwab.test/',
});
if (!cfg) throw new Error('config');

function memoryStore(): TokenPersistence & { saved: SchwabTokens | null; saves: number } {
  const store = {
    persistent: true,
    saved: null as SchwabTokens | null,
    saves: 0,
    async load() {
      return store.saved;
    },
    async save(t: SchwabTokens | null) {
      store.saved = t;
      store.saves += 1;
    },
  };
  return store;
}

interface Call {
  url: string;
  init?: RequestInit;
}

/** A fake fetch answering from a queue, recording every call. */
function fakeFetch(responses: (() => Response)[]): typeof fetch & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    return next();
  }) as typeof fetch & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('Schwab config and sign-in URL', () => {
  it('needs the app key, secret and callback URL', () => {
    expect(schwabConfig({ SCHWAB_APP_KEY: 'k', SCHWAB_APP_SECRET: 's' })).toBeNull();
    expect(cfg.apiBase).toBe('https://schwab.test');
    expect(schwabConfig({ SCHWAB_APP_KEY: 'k', SCHWAB_APP_SECRET: 's', SCHWAB_CALLBACK_URL: 'https://x/cb' })?.apiBase).toBe(
      'https://api.schwabapi.com',
    );
  });

  it('builds the authorize URL with the registered callback and state', () => {
    const u = new URL(authorizeUrl(cfg, 'st4te'));
    expect(u.origin + u.pathname).toBe('https://schwab.test/v1/oauth/authorize');
    expect(u.searchParams.get('client_id')).toBe('app-key');
    expect(u.searchParams.get('redirect_uri')).toBe('https://flow.example.com/api/schwab/callback');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('state')).toBe('st4te');
  });
});

describe('token encryption at rest', () => {
  it('round-trips, uses a fresh IV per seal, and refuses another key or tampering', () => {
    const a = sealToken('refresh-token-value', 'secret');
    const b = sealToken('refresh-token-value', 'secret');
    expect(a).not.toBe(b);
    expect(a).not.toContain('refresh-token-value');
    expect(openToken(a, 'secret')).toBe('refresh-token-value');
    expect(openToken(a, 'other-secret')).toBeNull();
    const parts = a.split('.');
    parts[2] = Buffer.from('tampered').toString('base64url');
    expect(openToken(parts.join('.'), 'secret')).toBeNull();
    expect(openToken('garbage', 'secret')).toBeNull();
  });
});

describe('SchwabAuth', () => {
  async function connected(clock: { t: number }, more: (() => Response)[] = []) {
    const store = memoryStore();
    const f = fakeFetch([json({ access_token: 'A1', refresh_token: 'R1', expires_in: 1800 }), ...more]);
    const auth = new SchwabAuth(cfg, store, f, () => clock.t);
    await auth.connect('C0.code@');
    return { auth, store, f };
  }

  it('exchanges the code with HTTP Basic auth and the registered redirect URI', async () => {
    const clock = { t: NOW };
    const { auth, store, f } = await connected(clock);
    const call = f.calls[0];
    expect(call.url).toBe('https://schwab.test/v1/oauth/token');
    const headers = call.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('app-key:app-secret').toString('base64')}`);
    const form = new URLSearchParams(String(call.init?.body));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('C0.code@');
    expect(form.get('redirect_uri')).toBe('https://flow.example.com/api/schwab/callback');
    expect(store.saved?.refreshToken).toBe('R1');
    const s = await auth.status();
    expect(s.state).toBe('connected');
    expect(s.reconnectBy).toBe(NOW + REFRESH_TOKEN_LIFETIME_MS);
  });

  it('serves the cached access token until 5 minutes before it lapses, then refreshes once for a burst', async () => {
    const clock = { t: NOW };
    const { auth, f } = await connected(clock, [json({ access_token: 'A2', refresh_token: 'R1', expires_in: 1800 })]);
    clock.t = NOW + 20 * MIN;
    expect(await auth.getAccessToken()).toBe('A1');
    clock.t = NOW + 26 * MIN;
    const burst = await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);
    expect(burst).toEqual(['A2', 'A2', 'A2']);
    expect(f.calls).toHaveLength(2);
    const form = new URLSearchParams(String(f.calls[1].init?.body));
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('R1');
    // A refresh never extends the weekly sign-in.
    expect((await auth.status()).reconnectBy).toBe(NOW + REFRESH_TOKEN_LIFETIME_MS);
  });

  it('marks the connection expired when Schwab refuses the refresh token', async () => {
    const clock = { t: NOW };
    const { auth } = await connected(clock, [json({ error: 'invalid_grant', error_description: 'expired' }, 400)]);
    clock.t = NOW + 29 * MIN;
    expect(await auth.getAccessToken()).toBeNull();
    const s = await auth.status();
    expect(s.state).toBe('expired');
    expect(s.lastError).toContain('invalid_grant');
    expect(s.lastError).not.toContain('R1');
  });

  it('keeps using the current token through a transient refresh failure', async () => {
    const clock = { t: NOW };
    const { auth } = await connected(clock, [json({ message: 'unavailable' }, 503)]);
    clock.t = NOW + 27 * MIN;
    expect(await auth.getAccessToken()).toBe('A1');
    expect((await auth.status()).state).toBe('connected');
  });

  it('stops after 7 days and on disconnect', async () => {
    const clock = { t: NOW };
    const { auth, store } = await connected(clock);
    clock.t = NOW + REFRESH_TOKEN_LIFETIME_MS + 1;
    expect(await auth.getAccessToken()).toBeNull();
    expect((await auth.status()).state).toBe('expired');
    await auth.disconnect();
    expect(store.saved).toBeNull();
    expect((await auth.status()).state).toBe('disconnected');
  });
});

function contract(putCall: 'PUT' | 'CALL', volume: number, extra: Record<string, unknown> = {}) {
  return { putCall, bid: 1.0, ask: 1.2, last: 1.1, totalVolume: volume, quoteTimeInLong: NOW - 5_000, ...extra };
}

const chain: SchwabChainResponse = {
  symbol: 'AAPL',
  status: 'SUCCESS',
  isDelayed: false,
  isChainTruncated: false,
  underlyingPrice: 231.5,
  underlying: { last: 231.5, percentChange: -0.8, tradeTime: NOW - 1_000 },
  callExpDateMap: {
    '2026-10-16:2': {
      '230.0': [contract('CALL', 1_000)],
      '235.0': [contract('CALL', 300, { bid: 0, ask: 0, last: 0.5 })],
    },
    '2026-11-20:37': { '230.0': [contract('CALL', 50, { mini: true })] },
  },
  putExpDateMap: {
    '2026-10-16:2': {
      '230.0': [contract('PUT', 800)],
      '225.0': [contract('PUT', 0)],
    },
    '2026-11-20:37': { '230.0': [contract('PUT', 70, { nonStandard: true })] },
  },
};

describe('normalizeSchwabChain', () => {
  it('totals standard contracts the way the CBOE feed is counted', () => {
    const { agg, delayed, priceAt } = normalizeSchwabChain('AAPL', chain, NOW);
    expect(delayed).toBe(false);
    expect(agg.callVolume).toBe(1_300);
    expect(agg.putVolume).toBe(800);
    // Mid when both sides quote, else last: 1.1 × 1,000 × 100 + 0.5 × 300 × 100.
    expect(agg.callPremium).toBeCloseTo(110_000 + 15_000, 6);
    expect(agg.putPremium).toBeCloseTo(88_000, 6);
    expect(agg.contractsSeen).toBe(3);
    expect(agg.largestContractVolume).toBe(1_000);
    expect(agg.underlyingPrice).toBe(231.5);
    expect(agg.priceChangePct).toBe(-0.8);
    expect(agg.asOf).toBe(NOW);
    expect(priceAt).toBe(NOW - 1_000);
    expect(agg.contracts).toBeUndefined();
  });

  it('dates a delayed chain by its newest quote', () => {
    const late = NOW - 15 * MIN;
    const body: SchwabChainResponse = {
      ...chain,
      isDelayed: true,
      callExpDateMap: { '2026-10-16:2': { '230.0': [contract('CALL', 10, { quoteTimeInLong: late })] } },
      putExpDateMap: {},
    };
    const { agg, delayed } = normalizeSchwabChain('AAPL', body, NOW);
    expect(delayed).toBe(true);
    expect(agg.asOf).toBe(late);
  });

  it('refuses failed and truncated chains (CBOE keeps covering them)', () => {
    expect(() => normalizeSchwabChain('XYZ', { status: 'FAILED' }, NOW)).toThrow(PermanentError);
    expect(() => normalizeSchwabChain('SPX', { ...chain, isChainTruncated: true }, NOW)).toThrow(ChainTruncatedError);
  });
});

describe('SchwabClient', () => {
  it('sends the bearer token to the chains endpoint', async () => {
    const clock = { t: Date.now() };
    const store = memoryStore();
    store.saved = { accessToken: 'A1', refreshToken: 'R1', accessExpiresAt: clock.t + 30 * MIN, authorizedAt: clock.t };
    const f = fakeFetch([json(chain)]);
    const client = new SchwabClient(new SchwabAuth(cfg, store, f, () => clock.t), 100, f);
    const { agg } = await client.getRealtimeChain('AAPL');
    expect(agg.callVolume).toBe(1_300);
    const u = new URL(f.calls[0].url);
    expect(u.pathname).toBe('/marketdata/v1/chains');
    expect(u.searchParams.get('symbol')).toBe('AAPL');
    expect(u.searchParams.get('contractType')).toBe('ALL');
    expect((f.calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer A1');
  });

  it('fails fast without a sign-in', async () => {
    const f = fakeFetch([]);
    const client = new SchwabClient(new SchwabAuth(cfg, memoryStore(), f), 100, f);
    await expect(client.getRealtimeChain('AAPL')).rejects.toBeInstanceOf(NotConnectedError);
    expect(f.calls).toHaveLength(0);
  });

  it('refreshes and retries once the API rejects the access token', async () => {
    const clock = { t: Date.now() };
    const store = memoryStore();
    store.saved = { accessToken: 'A1', refreshToken: 'R1', accessExpiresAt: clock.t + 30 * MIN, authorizedAt: clock.t };
    const f = fakeFetch([
      () => new Response('', { status: 401 }),
      json({ access_token: 'A2', refresh_token: 'R1', expires_in: 1800 }),
      json(chain),
    ]);
    const client = new SchwabClient(new SchwabAuth(cfg, store, f, () => clock.t), 100, f);
    await client.getRealtimeChain('AAPL');
    expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/marketdata/v1/chains',
      '/v1/oauth/token',
      '/marketdata/v1/chains',
    ]);
    expect((f.calls[2].init?.headers as Record<string, string>).Authorization).toBe('Bearer A2');
  });
});
