/**
 * Schwab OAuth for the owner's own brokerage account — the key to real-time
 * option chains (schwab.ts).
 *
 * Schwab's Trader API uses the authorization-code flow:
 *   1. /api/schwab/connect sends the browser to Schwab's login with a random
 *      `state` (also set as a short-lived cookie).
 *   2. Schwab redirects back to SCHWAB_CALLBACK_URL with `code` + `state`;
 *      /api/schwab/callback checks the state and exchanges the code (HTTP Basic
 *      auth with the app key/secret) for an access token and a refresh token.
 *   3. The access token lives 30 minutes; it is refreshed here, single-flight,
 *      5 minutes before it lapses.
 *   4. The refresh token dies 7 days after the sign-in no matter how often it
 *      is used. Nothing can extend that: the owner signs in again weekly, and
 *      until then the dashboard falls back to the delayed CBOE feed by itself.
 *
 * Tokens are stored AES-256-GCM encrypted (key derived from the app secret,
 * or SCHWAB_TOKEN_KEY), so the database alone never yields account access.
 * Without a database they live in memory and a restart means signing in again.
 *
 * One instance lives on globalThis: the custom server's poller and Next's API
 * routes are separate module instances in the same process.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { tryDb } from './db';

export const SCHWAB_PROVIDER = 'schwab';
/** Refresh the access token this long before it lapses. */
export const ACCESS_LEEWAY_MS = 5 * 60_000;
/** Schwab refresh tokens expire this long after the sign-in. */
export const REFRESH_TOKEN_LIFETIME_MS = 7 * 86_400_000;
/** Cookie carrying the OAuth `state` between connect and callback. */
export const STATE_COOKIE = 'schwab_oauth_state';
/** How long a cached copy of the stored tokens is trusted before re-reading. */
const RELOAD_MS = 30_000;

export interface SchwabConfig {
  appKey: string;
  appSecret: string;
  callbackUrl: string;
  /** https://api.schwabapi.com; overridable so tests can point at a fake server. */
  apiBase: string;
  /** Secret the token-encryption key is derived from. */
  tokenSecret: string;
}

export function schwabConfig(env: Record<string, string | undefined> = process.env): SchwabConfig | null {
  const appKey = env.SCHWAB_APP_KEY?.trim();
  const appSecret = env.SCHWAB_APP_SECRET?.trim();
  const callbackUrl = env.SCHWAB_CALLBACK_URL?.trim();
  if (!appKey || !appSecret || !callbackUrl) return null;
  return {
    appKey,
    appSecret,
    callbackUrl,
    apiBase: (env.SCHWAB_API_BASE?.trim() || 'https://api.schwabapi.com').replace(/\/+$/, ''),
    tokenSecret: env.SCHWAB_TOKEN_KEY?.trim() || appSecret,
  };
}

export function authorizeUrl(cfg: SchwabConfig, state: string): string {
  const u = new URL(`${cfg.apiBase}/v1/oauth/authorize`);
  u.searchParams.set('client_id', cfg.appKey);
  u.searchParams.set('redirect_uri', cfg.callbackUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', state);
  return u.toString();
}

export function newOAuthState(): string {
  return randomBytes(24).toString('base64url');
}

// ── Encryption at rest ────────────────────────────────────────────────────────

function tokenKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'options-flow', 'schwab-token-v1', 32));
}

/** "v1.<iv>.<ciphertext>.<tag>", base64url. A fresh IV per seal. */
export function sealToken(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', tokenKey(secret), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv, ct, cipher.getAuthTag()].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

/** Null when the value was sealed with another key (app secret rotated) or tampered with. */
export function openToken(sealed: string, secret: string): string | null {
  const [v, iv, ct, tag] = sealed.split('.');
  if (v !== 'v1' || !iv || !ct || !tag) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', tokenKey(secret), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ── Token endpoint ────────────────────────────────────────────────────────────

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  /** Seconds. */
  expires_in?: number;
}

export class SchwabAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Schwab refused the grant itself (expired/revoked token, reused code): retrying cannot help. */
    readonly fatal: boolean,
  ) {
    super(message);
    this.name = 'SchwabAuthError';
  }
}

/** Error text from a token response, without ever echoing a token. */
function describeError(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: string; error_description?: string; message?: string };
    return [body.error, body.error_description ?? body.message].filter(Boolean).join(': ').slice(0, 200) || 'no detail';
  } catch {
    return 'no detail';
  }
}

async function tokenRequest(cfg: SchwabConfig, form: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenResponse> {
  const res = await fetchImpl(`${cfg.apiBase}/v1/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.appKey}:${cfg.appSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(form).toString(),
    cache: 'no-store',
  });
  const text = await res.text();
  if (!res.ok) {
    throw new SchwabAuthError(`token ${res.status}: ${describeError(text)}`, res.status, res.status === 400 || res.status === 401);
  }
  let body: TokenResponse;
  try {
    body = JSON.parse(text) as TokenResponse;
  } catch {
    throw new SchwabAuthError('token response was not JSON', res.status, false);
  }
  if (!body.access_token) throw new SchwabAuthError('token response had no access token', res.status, false);
  return body;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export interface SchwabTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  /** When the owner signed in; the refresh token dies 7 days later. */
  authorizedAt: number;
}

export type SchwabState = 'unconfigured' | 'disconnected' | 'connected' | 'expired';

export interface SchwabAuthStatus {
  state: SchwabState;
  authorizedAt: number | null;
  /** When the owner must sign in again (refresh-token death). */
  reconnectBy: number | null;
  lastError: string | null;
  /** False without a database: tokens are memory-only and lost on restart. */
  persisted: boolean;
}

export interface TokenPersistence {
  /** Undefined = no persistent store (keep whatever is in memory). */
  load(): Promise<SchwabTokens | null | undefined>;
  save(tokens: SchwabTokens | null): Promise<void>;
  readonly persistent: boolean;
}

/** Postgres-backed persistence (BrokerToken), sealed with the configured secret. */
export function dbPersistence(cfg: SchwabConfig): TokenPersistence {
  const persistent = Boolean(process.env.DATABASE_URL);
  return {
    persistent,
    async load() {
      if (!persistent) return undefined;
      const read = await tryDb('load broker token', async (db) => ({
        row: await db.brokerToken.findUnique({ where: { provider: SCHWAB_PROVIDER } }),
      }));
      if (read === null) return undefined; // database unreachable: keep what is in memory
      const row = read.row;
      if (!row) return null;
      const accessToken = openToken(row.accessToken, cfg.tokenSecret);
      const refreshToken = openToken(row.refreshToken, cfg.tokenSecret);
      if (!accessToken || !refreshToken) return null; // sealed under another key: sign in again
      return {
        accessToken,
        refreshToken,
        accessExpiresAt: row.accessExpiresAt.getTime(),
        authorizedAt: row.authorizedAt.getTime(),
      };
    },
    async save(tokens) {
      if (!persistent) return;
      await tryDb('save broker token', async (db) => {
        if (!tokens) {
          await db.brokerToken.deleteMany({ where: { provider: SCHWAB_PROVIDER } });
          return;
        }
        const data = {
          accessToken: sealToken(tokens.accessToken, cfg.tokenSecret),
          refreshToken: sealToken(tokens.refreshToken, cfg.tokenSecret),
          accessExpiresAt: new Date(tokens.accessExpiresAt),
          authorizedAt: new Date(tokens.authorizedAt),
        };
        await db.brokerToken.upsert({ where: { provider: SCHWAB_PROVIDER }, create: { provider: SCHWAB_PROVIDER, ...data }, update: data });
      });
    },
  };
}

export class SchwabAuth {
  private tokens: SchwabTokens | null = null;
  private loadedAt = 0;
  private refreshing: Promise<string | null> | null = null;
  /** Schwab refused the refresh token: nothing works until the owner signs in again. */
  private refused = false;
  lastError: string | null = null;

  constructor(
    readonly cfg: SchwabConfig,
    private store: TokenPersistence,
    private fetchImpl: typeof fetch = (...args) => fetch(...args),
    private now: () => number = Date.now,
  ) {}

  private async load(force = false): Promise<void> {
    if (!force && this.now() - this.loadedAt < RELOAD_MS) return;
    const stored = await this.store.load();
    this.loadedAt = this.now();
    if (stored === undefined) return;
    // A different sign-in (e.g. done through another process) clears a refusal.
    if (stored?.authorizedAt !== this.tokens?.authorizedAt) this.refused = false;
    this.tokens = stored;
  }

  /** Exchange the callback's authorization code; starts a fresh 7-day window. */
  async connect(code: string): Promise<void> {
    let r: TokenResponse;
    try {
      r = await tokenRequest(this.cfg, { grant_type: 'authorization_code', code, redirect_uri: this.cfg.callbackUrl }, this.fetchImpl);
      if (!r.refresh_token) throw new SchwabAuthError('sign-in returned no refresh token', 200, true);
    } catch (err) {
      this.lastError = `sign-in failed: ${err instanceof Error ? err.message : String(err)}`;
      throw err;
    }
    const now = this.now();
    this.tokens = {
      accessToken: r.access_token as string,
      refreshToken: r.refresh_token,
      accessExpiresAt: now + (r.expires_in ?? 1800) * 1000,
      authorizedAt: now,
    };
    this.refused = false;
    this.lastError = null;
    this.loadedAt = now;
    await this.store.save(this.tokens);
  }

  async disconnect(): Promise<void> {
    this.tokens = null;
    this.refused = false;
    this.lastError = null;
    this.loadedAt = this.now();
    await this.store.save(null);
  }

  private reconnectBy(t: SchwabTokens): number {
    return t.authorizedAt + REFRESH_TOKEN_LIFETIME_MS;
  }

  /** A usable access token, refreshing it if due; null when not connected or expired. */
  async getAccessToken(): Promise<string | null> {
    await this.load();
    const t = this.tokens;
    if (!t || this.refused) return null;
    const now = this.now();
    if (now >= this.reconnectBy(t)) return null;
    if (t.accessExpiresAt - now > ACCESS_LEEWAY_MS) return t.accessToken;
    // Single flight: every caller in a burst shares one refresh.
    this.refreshing ??= this.refresh(t).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** The API rejected the access token (401): refresh on the next call. */
  invalidateAccess(): void {
    if (this.tokens) this.tokens = { ...this.tokens, accessExpiresAt: 0 };
    this.loadedAt = this.now(); // do not reload the rejected token from the store
  }

  private async refresh(t: SchwabTokens): Promise<string | null> {
    try {
      const r = await tokenRequest(this.cfg, { grant_type: 'refresh_token', refresh_token: t.refreshToken }, this.fetchImpl);
      // authorizedAt is kept: a refresh never extends the refresh token's life.
      this.tokens = {
        accessToken: r.access_token as string,
        refreshToken: r.refresh_token ?? t.refreshToken,
        accessExpiresAt: this.now() + (r.expires_in ?? 1800) * 1000,
        authorizedAt: t.authorizedAt,
      };
      this.lastError = null;
      await this.store.save(this.tokens);
      return this.tokens.accessToken;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      if (err instanceof SchwabAuthError && err.fatal) {
        this.refused = true;
        console.warn(`[schwab] refresh refused (${this.lastError}) — sign in again; using the delayed feed meanwhile`);
        return null;
      }
      // Transient (network, 5xx): keep using the current token while it lasts.
      return t.accessExpiresAt > this.now() ? t.accessToken : null;
    }
  }

  async status(): Promise<SchwabAuthStatus> {
    await this.load();
    const t = this.tokens;
    const base = { lastError: this.lastError, persisted: this.store.persistent };
    if (!t) return { state: 'disconnected', authorizedAt: null, reconnectBy: null, ...base };
    const reconnectBy = this.reconnectBy(t);
    return {
      state: this.refused || this.now() >= reconnectBy ? 'expired' : 'connected',
      authorizedAt: t.authorizedAt,
      reconnectBy,
      ...base,
    };
  }
}

const globalStore = globalThis as unknown as { __schwabAuth?: SchwabAuth | null };

/** The process-wide Schwab session, or null when SCHWAB_* is not configured. */
export function getSchwabAuth(): SchwabAuth | null {
  if (globalStore.__schwabAuth !== undefined) return globalStore.__schwabAuth;
  const cfg = schwabConfig();
  globalStore.__schwabAuth = cfg ? new SchwabAuth(cfg, dbPersistence(cfg)) : null;
  return globalStore.__schwabAuth;
}
