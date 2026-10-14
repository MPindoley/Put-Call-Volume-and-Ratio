import { describe, expect, it } from 'vitest';
import { withConnectTimeout } from './db';

describe('withConnectTimeout', () => {
  it('adds a 30 s connect timeout, keeping every other parameter', () => {
    const u = new URL(withConnectTimeout('postgresql://u:p@ep-x.neon.tech/neondb?sslmode=require'));
    expect(u.searchParams.get('connect_timeout')).toBe('30');
    expect(u.searchParams.get('sslmode')).toBe('require');
    expect(u.hostname).toBe('ep-x.neon.tech');
  });
  it('never overrides a timeout the URL already sets', () => {
    expect(withConnectTimeout('postgresql://u:p@h/db?connect_timeout=5')).toContain('connect_timeout=5');
  });
  it('passes through anything it cannot parse', () => {
    expect(withConnectTimeout('not a url')).toBe('not a url');
  });
});
