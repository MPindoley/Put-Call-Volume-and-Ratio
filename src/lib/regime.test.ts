import { describe, expect, it } from 'vitest';
import {
  foldRegime,
  INITIAL_HYSTERESIS,
  nextRegime,
  regimeConfigVersion,
  type HysteresisState,
} from './regime';

const states = (series: HysteresisState[]): string[] => series.map((s) => s.state);

describe('nextRegime — deadband + persistence hysteresis', () => {
  it('starts neutral and needs persistDays beyond the band to establish a state', () => {
    // deadband 0.5, persist 2. Values just above band on two straight days.
    const out = foldRegime([0.6, 0.6, 0.6], 0.5, 2);
    expect(states(out)).toEqual(['neutral', 'pos', 'pos']); // day1 building, day2 flips
  });

  it('in-band noise holds the prior state and clears a pending flip', () => {
    // Establish pos, then one opposite spike interrupted by an in-band day → no flip.
    const out = foldRegime([0.6, 0.6, -0.6, 0.1, -0.6], 0.5, 2);
    //  neutral→build, pos, (neg build 1), (in-band: hold pos, reset), (neg build 1 again)
    expect(states(out)).toEqual(['neutral', 'pos', 'pos', 'pos', 'pos']);
  });

  it('flips only after the opposite side persists persistDays consecutively', () => {
    const out = foldRegime([0.6, 0.6, -0.6, -0.6], 0.5, 2);
    expect(states(out)).toEqual(['neutral', 'pos', 'pos', 'neg']); // 2 straight neg → flip
  });

  it('a value inside the deadband never establishes a state', () => {
    const out = foldRegime([0.3, -0.3, 0.4, -0.4], 0.5, 2);
    expect(states(out)).toEqual(['neutral', 'neutral', 'neutral', 'neutral']);
  });

  it('persistDays = 1 flips immediately (no persistence requirement)', () => {
    const out = foldRegime([0.6, -0.6, 0.6], 0.5, 1);
    expect(states(out)).toEqual(['pos', 'neg', 'pos']);
  });

  it('same-side days beyond the band just confirm, no spurious streak', () => {
    const out = foldRegime([2, 2, 2, 2], 0.5, 2);
    expect(states(out)).toEqual(['neutral', 'pos', 'pos', 'pos']);
  });

  it('is forward-only: a later value never changes an earlier classification', () => {
    const base = foldRegime([0.6, 0.6, 0.6], 0.5, 2);
    const extended = foldRegime([0.6, 0.6, 0.6, -0.6, -0.6], 0.5, 2);
    expect(states(extended).slice(0, 3)).toEqual(states(base)); // prefix immutable
  });

  it('resumes persistence from a stored prior state (incremental, immutable rows)', () => {
    // Simulate day-by-day carry-forward: fold the last state into the next day.
    let s = INITIAL_HYSTERESIS;
    for (const v of [0.6, 0.6]) s = nextRegime(s, v, 0.5, 2);
    expect(s.state).toBe('pos');
    // One opposite day: still pos, streak pending.
    s = nextRegime(s, -0.6, 0.5, 2);
    expect(s.state).toBe('pos');
    expect(s.streak).toBe(-1);
    // Second opposite day: flips.
    s = nextRegime(s, -0.6, 0.5, 2);
    expect(s.state).toBe('neg');
  });
});

describe('regimeConfigVersion', () => {
  it('is stable for the same knobs and changes when any knob changes', () => {
    const a = regimeConfigVersion({ volDeadband: 0.5, trendDeadbandPct: 0.005, gammaDeadbandFrac: 0.1, persistDays: 2 });
    const b = regimeConfigVersion({ volDeadband: 0.5, trendDeadbandPct: 0.005, gammaDeadbandFrac: 0.1, persistDays: 2 });
    const c = regimeConfigVersion({ volDeadband: 0.5, trendDeadbandPct: 0.005, gammaDeadbandFrac: 0.1, persistDays: 3 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });
});
