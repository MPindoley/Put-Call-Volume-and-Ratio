import { describe, expect, it } from 'vitest';
import {
  classifyDivergence,
  classifyOiFlow,
  defaultInstrument,
  interpretDivergence,
  sideIvChanges,
  skewSentiment,
} from './interpretation';

describe('defaultInstrument', () => {
  it('SQQQ is inverse 3x', () => {
    expect(defaultInstrument('SQQQ')).toEqual({ inverse: true, leverage: 3 });
  });
  it('ordinary name is 1x non-inverse', () => {
    expect(defaultInstrument('AAPL')).toEqual({ inverse: false, leverage: 1 });
  });
});

describe('classifyOiFlow (OI × IV quadrants)', () => {
  it('OI up + IV up = demand', () => {
    expect(classifyOiFlow(10, 2)).toBe('demand');
  });
  it('OI up + IV down = supply', () => {
    expect(classifyOiFlow(10, -2)).toBe('supply');
  });
  it('OI down + IV down = unwind', () => {
    expect(classifyOiFlow(-10, -2)).toBe('unwind');
  });
  it('OI down + IV up = short-cover', () => {
    expect(classifyOiFlow(-10, 2)).toBe('short-cover');
  });
  it('within deadband = null (flat)', () => {
    expect(classifyOiFlow(0.5, 2)).toBeNull(); // OI move < 1%
    expect(classifyOiFlow(10, 0.05)).toBeNull(); // IV move < 0.1
  });
  it('nulls propagate', () => {
    expect(classifyOiFlow(null, 2)).toBeNull();
    expect(classifyOiFlow(10, null)).toBeNull();
  });
});

describe('sideIvChanges (decomposition)', () => {
  it('dIV 1.0, dSkew 0.4 → call +1.2, put +0.8', () => {
    expect(sideIvChanges(1.0, 0.4)).toEqual({ call: 1.2, put: 0.8 });
  });
  it('null dIV → both null', () => {
    expect(sideIvChanges(null, 0.4)).toEqual({ call: null, put: null });
  });
  it('null dSkew treated as 0', () => {
    expect(sideIvChanges(2.0, null)).toEqual({ call: 2.0, put: 2.0 });
  });
});

describe('skewSentiment (inverse-aware)', () => {
  it('positive skew = bullish for a normal product', () => {
    expect(skewSentiment(3, false)).toBe('bullish');
  });
  it('negative skew = bearish for a normal product', () => {
    expect(skewSentiment(-3, false)).toBe('bearish');
  });
  it('inverse product flips call-skew bid to bearish underlying exposure', () => {
    expect(skewSentiment(3, true)).toBe('bearish');
    expect(skewSentiment(-3, true)).toBe('bullish');
  });
  it('neutral stays neutral even when inverse', () => {
    expect(skewSentiment(0, true)).toBe('neutral');
  });
});

describe('classifyDivergence (reads z-trends, both nonflat, opposite dirs)', () => {
  const t = 1.5;
  it('price up + skew-z down = distribution', () => {
    expect(classifyDivergence({ slope: 0.5, t: 2 }, { slope: -0.3, t: 2 }, t)).toBe('distribution');
  });
  it('price down + skew-z up = accumulation', () => {
    expect(classifyDivergence({ slope: -0.5, t: 2 }, { slope: 0.3, t: 2 }, t)).toBe('accumulation');
  });
  it('same direction = no divergence (confirmation)', () => {
    expect(classifyDivergence({ slope: 0.5, t: 2 }, { slope: 0.3, t: 2 }, t)).toBeNull();
  });
  it('flat price (low t) = no divergence', () => {
    expect(classifyDivergence({ slope: 0.5, t: 1.0 }, { slope: -0.3, t: 2 }, t)).toBeNull();
  });
  it('flat skew (low t) = no divergence', () => {
    expect(classifyDivergence({ slope: 0.5, t: 2 }, { slope: -0.3, t: 1.0 }, t)).toBeNull();
  });
  it('nulls → null', () => {
    expect(classifyDivergence({ slope: null, t: null }, { slope: -0.3, t: 2 }, t)).toBeNull();
  });
});

describe('interpretDivergence (inverse flip)', () => {
  it('inverse flips distribution↔accumulation', () => {
    expect(interpretDivergence('distribution', true)).toBe('accumulation');
    expect(interpretDivergence('accumulation', true)).toBe('distribution');
  });
  it('normal product unchanged', () => {
    expect(interpretDivergence('distribution', false)).toBe('distribution');
  });
  it('null stays null', () => {
    expect(interpretDivergence(null, true)).toBeNull();
  });
});
