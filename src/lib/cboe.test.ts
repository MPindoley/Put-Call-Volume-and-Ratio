import { describe, expect, it } from 'vitest';
import { MAX_SNAPSHOT_AGE_MS, parseOcc, snapshotAgeMs, snapshotDataTime } from './cboe';

/**
 * Delisted names are the motivating case: CBOE serves their last snapshot
 * forever with HTTP 200 and a plausible price, so only the payload timestamp
 * distinguishes them from a live quote.
 */
describe('snapshotAgeMs', () => {
  // CBOE stamps are UTC, formatted "YYYY-MM-DD HH:MM:SS" (verified live:
  // an AAPL snapshot stamped 13:08:07 arrived at 13:08 UTC).
  const now = Date.parse('2026-08-10T13:00:00Z');

  it('reads the CBOE stamp as UTC', () => {
    expect(snapshotAgeMs('2026-08-10 12:00:00', now)).toBe(3_600_000);
  });

  it('measures a frozen snapshot in days', () => {
    // BK, measured live: 81 days stale at $137.16 with an empty chain.
    const age = snapshotAgeMs('2026-05-21 02:04:54', now);
    expect(age).not.toBeNull();
    expect(age! / 86_400_000).toBeGreaterThan(80);
    expect(age!).toBeGreaterThan(MAX_SNAPSHOT_AGE_MS);
  });

  it('returns null — not 0, not Infinity — when the stamp is missing', () => {
    // Null means "cannot tell", and callers must fail OPEN on it.
    expect(snapshotAgeMs(undefined, now)).toBeNull();
  });

  it('returns null on an unparseable stamp so a format change cannot kill the feed', () => {
    expect(snapshotAgeMs('not-a-date', now)).toBeNull();
    expect(snapshotAgeMs('', now)).toBeNull();
  });

  it('accepts a normal weekend as fresh', () => {
    // Friday close → Monday open must NOT trip the guard.
    const friday = snapshotAgeMs('2026-08-07 20:00:00', now);
    expect(friday!).toBeLessThan(MAX_SNAPSHOT_AGE_MS);
  });

  it('tolerates a long weekend plus a holiday', () => {
    const fourDays = snapshotAgeMs('2026-08-06 13:00:00', now);
    expect(fourDays!).toBeLessThan(MAX_SNAPSHOT_AGE_MS);
  });
});

describe('parseOcc', () => {
  it('parses a standard OCC symbol', () => {
    const p = parseOcc('AAPL260117C00150000');
    expect(p).toEqual({ type: 'call', strike: 150, expiration: Date.UTC(2026, 0, 17) });
  });

  it('rejects malformed input rather than guessing', () => {
    expect(parseOcc('SHORT')).toBeNull();
    expect(parseOcc('AAPL260117X00150000')).toBeNull(); // not C/P
  });
});

describe('snapshotDataTime', () => {
  const iso = (v: number | null): string | null => (v === null ? null : new Date(v).toISOString());
  it('is the generation time minus the 15-minute delay during the session', () => {
    expect(iso(snapshotDataTime('2026-10-14 18:30:00'))).toBe('2026-10-14T18:15:00.000Z');
  });
  it('pins re-stamped closing snapshots to the close (16:00 ET = 20:00 UTC)', () => {
    expect(iso(snapshotDataTime('2026-10-14 20:29:45'))).toBe('2026-10-14T20:00:00.000Z');
    expect(iso(snapshotDataTime('2026-10-14 23:50:00'))).toBe('2026-10-14T20:00:00.000Z');
  });
  it('leaves a snapshot reaching exactly the close, and unknown stamps, alone', () => {
    expect(iso(snapshotDataTime('2026-10-14 20:15:00'))).toBe('2026-10-14T20:00:00.000Z');
    expect(snapshotDataTime(undefined)).toBeNull();
    expect(snapshotDataTime('garbage')).toBeNull();
  });
});
