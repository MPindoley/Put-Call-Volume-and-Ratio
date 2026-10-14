/**
 * Site lock: a single shared password (SITE_PASSWORD) and an HMAC-signed
 * session cookie. Unset SITE_PASSWORD = the site stays open, as before.
 *
 * Why a lock at all: broker market data (Schwab) is licensed for the account
 * holder's personal use, and the Railway URL is reachable by anyone who has
 * it. The lock also guards the Schwab connect/callback routes, so nobody else
 * can swap in their own Schwab login.
 *
 * Uses only Web Crypto, so the same code runs in the edge middleware and in
 * the Node socket server.
 */

export const SESSION_COOKIE = 'of_session';
/** Sessions last 30 days, then the password is asked again. */
export const SESSION_MAX_AGE_S = 30 * 86_400;

const enc = new TextEncoder();

/** The signing secret: SESSION_SECRET if set, else derived from the site password. */
export function sessionSecret(env: Record<string, string | undefined> = process.env): string | null {
  return env.SESSION_SECRET || env.SITE_PASSWORD || null;
}

export function siteLocked(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.SITE_PASSWORD);
}

async function hmac(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(message)));
  let s = '';
  for (const b of sig) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Length-independent comparison that does not stop at the first difference. */
function sameString(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** A session token: "<issuedAtSeconds>.<signature>". */
export async function signSession(secret: string, nowMs = Date.now()): Promise<string> {
  const issued = Math.floor(nowMs / 1000).toString();
  return `${issued}.${await hmac(secret, `session|${issued}`)}`;
}

export async function verifySession(token: string | null | undefined, secret: string, nowMs = Date.now()): Promise<boolean> {
  if (!token) return false;
  const [issued, sig] = token.split('.');
  if (!issued || !sig || !/^\d+$/.test(issued)) return false;
  const age = nowMs / 1000 - Number(issued);
  if (age < -60 || age > SESSION_MAX_AGE_S) return false;
  return sameString(sig, await hmac(secret, `session|${issued}`));
}

/** Compare a submitted password without leaking its length or prefix through timing. */
export async function passwordMatches(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([hmac('password-check', given), hmac('password-check', expected)]);
  return sameString(a, b);
}

/** Read one cookie from a Cookie header. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Paths reachable without a session (the login flow and the platform health probe). */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname === '/api/login' ||
    pathname === '/api/health' ||
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico'
  );
}
