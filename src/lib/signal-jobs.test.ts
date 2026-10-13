import { describe, expect, it } from 'vitest';
import { forwardEndpoint, TERMINAL_QUIET_SESSIONS } from './signal-jobs';
import { sectorWithFallback } from './sector-benchmarks';

/** n consecutive pseudo-sessions s00, s01, … (ISO-sortable like real dates). */
const sessions = (n: number): string[] => Array.from({ length: n }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`);
const closesOn = (days: string[], px = 100): Map<string, number> => new Map(days.map((d) => [d, px]));

describe('forwardEndpoint', () => {
  const S = sessions(31); // index 0..30

  it('uses the scheduled session when the name traded that day', () => {
    const closes = closesOn(S);
    expect(forwardEndpoint(closes, S, 0, 20)).toEqual({ date: S[20], terminal: false });
  });

  it('grades a name that stopped trading mid-window to its last close (survivorship)', () => {
    // Acquired: trades through session 7, then nothing, ever.
    const closes = closesOn(S.slice(0, 8));
    expect(forwardEndpoint(closes, S, 0, 20)).toEqual({ date: S[7], terminal: true });
    // Every horizon past the stop resolves to the same terminal close.
    expect(forwardEndpoint(closes, S, 0, 10)).toEqual({ date: S[7], terminal: true });
    // A horizon before the stop is an ordinary grade.
    expect(forwardEndpoint(closes, S, 0, 5)).toEqual({ date: S[5], terminal: false });
  });

  it('treats a hole followed by later closes as a data gap, not a delisting', () => {
    // Capture failed on session 20 (a 429 storm), but the name kept trading.
    const closes = closesOn(S.filter((_, i) => i !== 20));
    expect(forwardEndpoint(closes, S, 0, 20)).toBeNull();
  });

  it('does not call a name terminal until it has been silent long enough', () => {
    // Last close is only 2 sessions before "today" — may just be lagging capture.
    const short = sessions(23); // 0..22, target 20 missing, last close 20? no: last close 19
    const closes = closesOn(short.slice(0, 20)); // trades 0..19, silent 20..22 (3 sessions)
    expect(short.length - 1 - 19).toBeLessThan(TERMINAL_QUIET_SESSIONS);
    expect(forwardEndpoint(closes, short, 0, 20)).toBeNull();
  });

  it('refuses when the name never traded after the signal fired', () => {
    const closes = closesOn([S[0]!]);
    expect(forwardEndpoint(closes, S, 0, 20)).toBeNull();
  });

  it('refuses when the window has not elapsed', () => {
    expect(forwardEndpoint(closesOn(S), S, 25, 20)).toBeNull();
  });

  it('refuses on an empty close history', () => {
    expect(forwardEndpoint(new Map(), S, 0, 20)).toBeNull();
  });
});

describe('sectorWithFallback', () => {
  it('prefers the live universe classification', () => {
    expect(sectorWithFallback('AAPL', new Map([['AAPL', 'Financials']]))).toBe('Technology');
  });

  it('recovers the persisted sector for a name removed from the universe', () => {
    // BK was removed after delisting; the live map now says Unknown.
    expect(sectorWithFallback('BK', new Map([['BK', 'Financials']]))).toBe('Financials');
  });

  it('stays Unknown when there is no record either way', () => {
    expect(sectorWithFallback('ZZZZ', new Map())).toBe('Unknown');
  });
});
