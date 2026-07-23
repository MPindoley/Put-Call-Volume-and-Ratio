import { describe, expect, it } from 'vitest';
import { compositionVersionFor, computeDispersion, resolveWeightMethod, selectMedianMembers, type WeightMethod } from './sector-analytics';

const cfg0 = {
  minConstituents: 5, regimeDetachSigma: 1, z30Window: 30, z90Window: 90,
  earningsWindowBeforeDays: 7, earningsWindowAfterDays: 1, captureDelayMin: 20, captureWindowMin: 30,
  zMinObs30: 20, zMinObs90: 60, zStdevFloor: 0.1, medianMinOI: 0, medianMinVolume: 0, medianIqrMult: 2.5,
};

interface C {
  symbol: string;
  iv30: number | null;
  skew: number | null;
  oiPc: number | null;
  ivHv: number | null;
  totalOI: number | null;
  optVolume: number | null;
  cap: number | null;
}
const c = (symbol: string, iv30: number, totalOI: number | null, cap: number | null): C => ({
  symbol,
  iv30,
  skew: null,
  oiPc: null,
  ivHv: null,
  totalOI,
  optVolume: null,
  cap,
});

describe('resolveWeightMethod (cap → oi → equal cascade)', () => {
  it('cap when every constituent has a positive cap', () => {
    expect(resolveWeightMethod([c('A', 20, 100, 5), c('B', 30, 200, 8)])).toBe<WeightMethod>('cap');
  });
  it('oi when caps are incomplete but all have OI', () => {
    expect(resolveWeightMethod([c('A', 20, 100, 5), c('B', 30, 200, null)])).toBe<WeightMethod>('oi');
  });
  it('equal when neither caps nor OI are complete', () => {
    expect(resolveWeightMethod([c('A', 20, 100, null), c('B', 30, null, null)])).toBe<WeightMethod>('equal');
  });
  it('empty set → equal', () => {
    expect(resolveWeightMethod([])).toBe<WeightMethod>('equal');
  });
});

describe('computeDispersion (benchmark IV ÷ weighted constituent IV)', () => {
  it('equal-weighted: bench 25 over mean(20,30)=25 → 1.0', () => {
    expect(computeDispersion(25, [c('A', 20, 1, null), c('B', 30, 1, null)], 'equal')).toBeCloseTo(1.0, 10);
  });
  it('cap-weighted: bench 24 over (20*1+30*3)/4=27.5 → 0.8727', () => {
    // weighted mean = (20*1 + 30*3)/(1+3) = 110/4 = 27.5; 24/27.5
    expect(computeDispersion(24, [c('A', 20, 5, 1), c('B', 30, 5, 3)], 'cap')).toBeCloseTo(24 / 27.5, 6);
  });
  it('oi-weighted: bench 30 over (20*100+40*300)/400=35 → 0.8571', () => {
    expect(computeDispersion(30, [c('A', 20, 100, null), c('B', 40, 300, null)], 'oi')).toBeCloseTo(30 / 35, 6);
  });
  it('null benchmark → null', () => {
    expect(computeDispersion(null, [c('A', 20, 1, 1)], 'equal')).toBeNull();
  });
  it('no constituents with IV → null', () => {
    expect(computeDispersion(25, [], 'equal')).toBeNull();
  });
  it('ignores constituents without IV in the weighted mean', () => {
    // Only A(20) counts; bench 20 / 20 = 1.0
    expect(computeDispersion(20, [c('A', 20, 1, null), { ...c('B', 0, 1, null), iv30: null }], 'equal')).toBeCloseTo(1.0, 10);
  });
});

describe('selectMedianMembers (membership filter)', () => {
  const cfg = { medianMinOI: 0, medianMinVolume: 0, medianIqrMult: 2.5 };

  it('excludes a far IV outlier (AAPL-in-quantum-bucket case)', () => {
    // Tight cluster 25-31 plus one 180-IV name; the outlier is fenced out.
    const set = [
      c('A', 25, 100, null), c('B', 27, 100, null), c('C', 28, 100, null),
      c('D', 29, 100, null), c('E', 30, 100, null), c('F', 31, 100, null),
      c('MEME', 180, 100, null),
    ];
    const { members, excluded } = selectMedianMembers(set, cfg);
    expect(members.map((m) => m.symbol)).not.toContain('MEME');
    expect(excluded.map((e) => e.symbol)).toContain('MEME');
    expect(members).toHaveLength(6);
  });

  it('keeps a tight cluster intact (no false exclusions)', () => {
    const set = [c('A', 20, 1, null), c('B', 22, 1, null), c('C', 24, 1, null), c('D', 26, 1, null), c('E', 28, 1, null)];
    expect(selectMedianMembers(set, cfg).excluded).toHaveLength(0);
  });

  it('applies the OI liquidity floor', () => {
    const set = [c('A', 25, 500, null), c('B', 26, 50, null), c('C', 27, 500, null), c('D', 28, 500, null)];
    const { members, excluded } = selectMedianMembers(set, { ...cfg, medianMinOI: 100 });
    expect(members.map((m) => m.symbol)).not.toContain('B');
    expect(excluded[0]?.reason).toContain('OI');
  });

  it('too few names → IQR filter no-ops, liquid set returned', () => {
    const set = [c('A', 20, 1, null), c('B', 99, 1, null)];
    expect(selectMedianMembers(set, cfg).members).toHaveLength(2);
  });
});

describe('compositionVersionFor (definition hash)', () => {
  const cohorts = new Map([['XLK', { label: 'Technology (XLK)', members: ['AAPL', 'MSFT', 'ORCL'] }]]);

  it('is deterministic for the same definition', () => {
    expect(compositionVersionFor('XLK', cohorts, cfg0)).toBe(compositionVersionFor('XLK', cohorts, cfg0));
  });
  it('changes when a member leaves the cohort (semis exit)', () => {
    const after = new Map([['XLK', { label: 'Technology (XLK)', members: ['AAPL', 'MSFT'] }]]); // ORCL removed
    expect(compositionVersionFor('XLK', cohorts, cfg0)).not.toBe(compositionVersionFor('XLK', after, cfg0));
  });
  it('changes when a membership-filter param changes', () => {
    expect(compositionVersionFor('XLK', cohorts, cfg0)).not.toBe(
      compositionVersionFor('XLK', cohorts, { ...cfg0, medianIqrMult: 1.5 }),
    );
  });
  it('is 8 hex chars', () => {
    expect(compositionVersionFor('XLK', cohorts, cfg0)).toMatch(/^[0-9a-f]{8}$/);
  });
});
