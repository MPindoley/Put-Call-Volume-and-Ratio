import { describe, expect, it } from 'vitest';
import {
  iqrBounds,
  linregSlope,
  mean,
  median,
  percentileRank,
  quantile,
  slopeTStat,
  slopeTStatNW,
  stdev,
  weightedMean,
  zScore,
  zScoreGuarded,
} from './sector-stats';

describe('median', () => {
  it('odd length → middle value', () => {
    expect(median([3, 1, 2])).toBe(2);
  });
  it('even length → mean of two middle', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it('empty → null', () => {
    expect(median([])).toBeNull();
  });
  it('ignores non-finite', () => {
    expect(median([1, NaN, 3])).toBe(2);
  });
});

describe('mean', () => {
  it('arithmetic mean', () => {
    expect(mean([2, 4, 6])).toBe(4);
  });
  it('empty → null', () => {
    expect(mean([])).toBeNull();
  });
});

describe('stdev (sample, n-1)', () => {
  it('hand-computed: [2,4,4,4,5,5,7,9] → 2.138…', () => {
    // mean=5, squared devs sum=32, /(8-1)=4.5714…, sqrt=2.13809…
    const s = stdev([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s).toBeCloseTo(2.13809, 4);
  });
  it('needs ≥2 points', () => {
    expect(stdev([5])).toBeNull();
  });
  it('flat window → 0', () => {
    expect(stdev([3, 3, 3])).toBe(0);
  });
});

describe('zScore', () => {
  it('hand-computed: value 8 vs window mean 5 stdev 2.13809… → 1.40312', () => {
    // window [2,4,4,4,5,5,7,9]: mean 5, sample stdev 2.1380899… → (8-5)/2.1380899
    expect(zScore(8, [2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(1.40312, 4);
  });
  it('flat window → null (undefined, not zero)', () => {
    expect(zScore(5, [3, 3, 3])).toBeNull();
  });
});

describe('zScoreGuarded (obs guard + stdev floor)', () => {
  const window20 = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 4 : 6)); // mean 5, stdev ~1.03
  it('returns null below minObs', () => {
    expect(zScoreGuarded(8, window20, 21, 0.1)).toBeNull(); // 20 < 21
    expect(zScoreGuarded(8, [1, 2, 3], 20, 0.1)).toBeNull();
  });
  it('computes normally when obs met and stdev above floor', () => {
    // window mean 5, sample stdev = sqrt(20*1/19)=1.0260; (8-5)/1.0260
    expect(zScoreGuarded(8, window20, 20, 0.1)).toBeCloseTo(3 / 1.02598, 3);
  });
  it('floors a near-constant window so z cannot blow up', () => {
    const flat = Array.from({ length: 20 }, () => 5.0); // stdev 0
    // raw would be undefined/inf; guarded floors denom at 0.5 → (10-5)/0.5 = 10
    expect(zScoreGuarded(10, flat, 20, 0.5)).toBeCloseTo(10, 6);
  });
  it('tiny-but-nonzero stdev is clamped by the floor', () => {
    const nearly = Array.from({ length: 20 }, (_, i) => 5 + (i === 0 ? 0.001 : 0)); // stdev ~0.0002
    // without floor z would be ~ huge; with floor 0.5 → (7 - 5.00005)/0.5 ≈ 4.0
    const z = zScoreGuarded(7, nearly, 20, 0.5);
    expect(z).not.toBeNull();
    expect(Math.abs(z as number)).toBeLessThan(5);
  });
});

describe('quantile', () => {
  it('median via q=0.5', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });
  it('q1/q3 with interpolation on 0..8', () => {
    expect(quantile([0, 1, 2, 3, 4, 5, 6, 7, 8], 0.25)).toBe(2);
    expect(quantile([0, 1, 2, 3, 4, 5, 6, 7, 8], 0.75)).toBe(6);
  });
});

describe('iqrBounds (outlier fence)', () => {
  it('hand-computed: 0..8, mult 1.5 → Q1 2, Q3 6, IQR 4 → [-4, 12]', () => {
    expect(iqrBounds([0, 1, 2, 3, 4, 5, 6, 7, 8], 1.5)).toEqual({ lo: -4, hi: 12 });
  });
  it('flags a far outlier outside the fence', () => {
    const b = iqrBounds([20, 21, 22, 23, 24, 25, 200], 2.5);
    expect(b).not.toBeNull();
    expect(200).toBeGreaterThan((b as { hi: number }).hi);
  });
  it('null below minN', () => {
    expect(iqrBounds([1, 2], 2.5)).toBeNull();
  });
});

describe('linregSlope', () => {
  it('perfect line y=2x → slope 2', () => {
    expect(linregSlope([0, 2, 4, 6, 8])).toBeCloseTo(2, 10);
  });
  it('descending → negative slope', () => {
    expect(linregSlope([10, 8, 6, 4])).toBeCloseTo(-2, 10);
  });
  it('needs ≥3 points', () => {
    expect(linregSlope([1, 2])).toBeNull();
  });
});

describe('slopeTStat', () => {
  it('perfect line → infinite t (zero residual)', () => {
    expect(slopeTStat([0, 1, 2, 3, 4])).toBe(Number.POSITIVE_INFINITY);
  });
  it('flat line → t of 0', () => {
    expect(slopeTStat([5, 5, 5, 5])).toBe(0);
  });
});

describe('slopeTStatNW (Newey-West HAC)', () => {
  it('perfect line → infinite t (zero residual)', () => {
    expect(slopeTStatNW([0, 1, 2, 3, 4, 5])).toBe(Number.POSITIVE_INFINITY);
  });
  it('flat line → t of 0', () => {
    expect(slopeTStatNW([5, 5, 5, 5, 5])).toBe(0);
  });
  it('deflates the OLS t when residuals are positively autocorrelated', () => {
    // trend + slow wave ⇒ serially correlated residuals ⇒ HAC SE larger ⇒ |t| smaller
    const y = Array.from({ length: 24 }, (_, t) => t + 4 * Math.sin(t / 2));
    const ols = slopeTStat(y) as number;
    const nw = slopeTStatNW(y) as number;
    expect(nw).not.toBeNull();
    expect(Math.abs(nw)).toBeLessThan(Math.abs(ols));
    expect(Math.sign(nw)).toBe(Math.sign(ols));
  });
  it('needs ≥3 points', () => {
    expect(slopeTStatNW([1, 2])).toBeNull();
  });
});

describe('percentileRank', () => {
  it('hand-computed: 7 in 0..9 (10 samples) → 70', () => {
    expect(percentileRank(7, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5)).toBe(70);
  });
  it('below minSamples → null', () => {
    expect(percentileRank(7, [1, 2, 3], 20)).toBeNull();
  });
});

describe('weightedMean', () => {
  it('hand-computed: values [10,20] weights [1,3] → 17.5', () => {
    expect(weightedMean([10, 20], [1, 3])).toBe(17.5);
  });
  it('zero weights → null', () => {
    expect(weightedMean([10, 20], [0, 0])).toBeNull();
  });
});
