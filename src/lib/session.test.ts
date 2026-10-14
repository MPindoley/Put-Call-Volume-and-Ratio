import { describe, expect, it } from 'vitest';
import {
  isPublicPath,
  passwordMatches,
  readCookie,
  SESSION_MAX_AGE_S,
  sessionSecret,
  signSession,
  siteLocked,
  verifySession,
} from './session';

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

describe('site lock sessions', () => {
  it('accepts a session it signed', async () => {
    const t = await signSession('s3cret', NOW);
    expect(await verifySession(t, 's3cret', NOW + 1_000)).toBe(true);
  });

  it('rejects a session signed with another secret (e.g. after the password changed)', async () => {
    const t = await signSession('old', NOW);
    expect(await verifySession(t, 'new', NOW)).toBe(false);
  });

  it('rejects a tampered or malformed session', async () => {
    const t = await signSession('s3cret', NOW);
    const [issued, sig] = t.split('.');
    expect(await verifySession(`${Number(issued) + 1}.${sig}`, 's3cret', NOW)).toBe(false);
    expect(await verifySession('garbage', 's3cret', NOW)).toBe(false);
    expect(await verifySession(null, 's3cret', NOW)).toBe(false);
  });

  it('expires sessions after 30 days', async () => {
    const t = await signSession('s3cret', NOW);
    expect(await verifySession(t, 's3cret', NOW + (SESSION_MAX_AGE_S - 60) * 1000)).toBe(true);
    expect(await verifySession(t, 's3cret', NOW + (SESSION_MAX_AGE_S + 60) * 1000)).toBe(false);
  });

  it('checks the password exactly', async () => {
    expect(await passwordMatches('hunter2', 'hunter2')).toBe(true);
    expect(await passwordMatches('hunter', 'hunter2')).toBe(false);
    expect(await passwordMatches('', 'hunter2')).toBe(false);
  });

  it('is off unless SITE_PASSWORD is set, and prefers SESSION_SECRET for signing', () => {
    expect(siteLocked({})).toBe(false);
    expect(siteLocked({ SITE_PASSWORD: 'x' })).toBe(true);
    expect(sessionSecret({ SITE_PASSWORD: 'x' })).toBe('x');
    expect(sessionSecret({ SITE_PASSWORD: 'x', SESSION_SECRET: 'y' })).toBe('y');
  });

  it('reads a cookie from a header', () => {
    expect(readCookie('a=1; of_session=abc.def; b=2', 'of_session')).toBe('abc.def');
    expect(readCookie('a=1', 'of_session')).toBeNull();
    expect(readCookie(undefined, 'of_session')).toBeNull();
  });

  it('leaves only the login flow and the health probe public', () => {
    expect(isPublicPath('/login')).toBe(true);
    expect(isPublicPath('/api/health')).toBe(true);
    expect(isPublicPath('/_next/static/chunk.js')).toBe(true);
    expect(isPublicPath('/')).toBe(false);
    expect(isPublicPath('/api/flow')).toBe(false);
    expect(isPublicPath('/api/schwab/callback')).toBe(false);
  });
});
