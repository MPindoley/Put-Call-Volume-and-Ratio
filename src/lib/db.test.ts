import { describe, expect, it } from 'vitest';
import { withConnectionDefaults } from './db';

describe('withConnectionDefaults', () => {
  it('adds a 30 s connect timeout and a 5-connection pool, keeping every other parameter', () => {
    const u = new URL(withConnectionDefaults('postgres://avnadmin:p@pg-x.aivencloud.com:12345/defaultdb?sslmode=require'));
    expect(u.searchParams.get('connect_timeout')).toBe('30');
    expect(u.searchParams.get('connection_limit')).toBe('5');
    expect(u.searchParams.get('sslmode')).toBe('require');
    expect(u.hostname).toBe('pg-x.aivencloud.com');
    expect(u.port).toBe('12345');
  });
  it('never overrides what the URL already sets', () => {
    const out = withConnectionDefaults('postgresql://u:p@h/db?connect_timeout=5&connection_limit=9');
    expect(out).toContain('connect_timeout=5');
    expect(out).toContain('connection_limit=9');
  });
  it('passes through anything it cannot parse', () => {
    expect(withConnectionDefaults('not a url')).toBe('not a url');
  });
});
