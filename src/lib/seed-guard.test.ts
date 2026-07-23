import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSeedAllowed, isProductionEnv, NOT_SEEDED } from './seed-guard';

/**
 * Enforces decision 2.4 (seed safety) — previously present in code but untested.
 * The production guard and ALLOW_SEED opt-in are the two barriers that keep
 * synthetic rows out of a deployed database; the demo-route guard (4.9) reuses
 * assertSeedAllowed, so this test protects both.
 */
describe('assertSeedAllowed (seed-safety production guard)', () => {
  const env = process.env as Record<string, string | undefined>;
  let origNodeEnv: string | undefined;
  let origAllow: string | undefined;

  beforeEach(() => {
    origNodeEnv = env.NODE_ENV;
    origAllow = env.ALLOW_SEED;
  });
  afterEach(() => {
    env.NODE_ENV = origNodeEnv;
    env.ALLOW_SEED = origAllow;
  });

  it('throws in production even with ALLOW_SEED=1', () => {
    env.NODE_ENV = 'production';
    env.ALLOW_SEED = '1';
    expect(() => assertSeedAllowed('test')).toThrow(/NODE_ENV=production/);
    expect(isProductionEnv()).toBe(true);
  });

  it('throws outside production without ALLOW_SEED=1', () => {
    env.NODE_ENV = 'development';
    delete env.ALLOW_SEED;
    expect(() => assertSeedAllowed('test')).toThrow(/ALLOW_SEED=1/);
    env.ALLOW_SEED = '0';
    expect(() => assertSeedAllowed('test')).toThrow(/ALLOW_SEED=1/);
  });

  it('allows only in non-production WITH ALLOW_SEED=1', () => {
    env.NODE_ENV = 'development';
    env.ALLOW_SEED = '1';
    expect(() => assertSeedAllowed('test')).not.toThrow();
  });

  it('NOT_SEEDED is the exclusion fragment every aggregation must carry', () => {
    expect(NOT_SEEDED).toEqual({ seeded: false });
  });
});
