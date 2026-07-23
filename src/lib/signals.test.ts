import { describe, expect, it } from 'vitest';
import {
  baseHitProb,
  buildMatrix,
  classifyCurveResolution,
  classifyResolution,
  eventTrackSummary,
  mergeCounts,
  thresholdVersion,
  wilsonInterval,
  type MatrixRow,
} from './signals';

describe('thresholdVersion', () => {
  const base = { skewZExtreme: 2.0, pcHigh: 1.3, pcLow: 0.7, divergenceTStat: 1.5 };
  it('is stable and changes when any cutoff changes', () => {
    expect(thresholdVersion(base)).toBe(thresholdVersion({ ...base }));
    expect(thresholdVersion(base)).not.toBe(thresholdVersion({ ...base, pcHigh: 1.25 }));
    expect(thresholdVersion(base)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('wilsonInterval — hand-computed check', () => {
  it('12/20 at z=1.96 → [0.387, 0.781]', () => {
    // p=0.6, n=20, z²=3.8416: center=(0.6+0.09604)/1.19208=0.58389,
    // half=1.96·sqrt(0.012+0.0024)/1.19208=1.96·0.120067/1.19208=0.19740
    const ci = wilsonInterval(12, 20)!;
    expect(ci.lo).toBeCloseTo(0.3865, 3);
    expect(ci.hi).toBeCloseTo(0.7813, 3);
  });
  it('n=0 → null; extremes clamp to [0,1]', () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    const all = wilsonInterval(10, 10)!;
    expect(all.hi).toBe(1);
    expect(all.lo).toBeLessThan(1);
  });
});

describe('classifyCurveResolution (primary, curve shape)', () => {
  it('near end fell to meet the back → front_collapse (fear passed)', () => {
    // Entry: near 55, far 40 (slope −15). Exit: near 42, far 41 → near fell 13, far rose 1.
    expect(classifyCurveResolution(55, 40, 42, 41)).toBe('front_collapse');
  });
  it('far end rose to meet the front → back_lift (fear repriced durable)', () => {
    // Entry: near 50, far 42. Exit: near 49, far 48 → near fell 1, far rose 6.
    expect(classifyCurveResolution(50, 42, 49, 48)).toBe('back_lift');
  });
  it('equal contributions break toward front_collapse', () => {
    expect(classifyCurveResolution(50, 42, 46, 46)).toBe('front_collapse'); // −ΔNear 4 = ΔFar 4
  });
  it('missing components → unknown, never guessed', () => {
    expect(classifyCurveResolution(null, 40, 42, 41)).toBe('unknown');
    expect(classifyCurveResolution(55, 40, 42, null)).toBe('unknown');
  });
  it('neither side normalized → unknown', () => {
    expect(classifyCurveResolution(50, 45, 52, 44)).toBe('unknown'); // near rose, far fell
  });
});

describe('classifyResolution (secondary outcome)', () => {
  it('≥5% cumulative move → realized_move (even with IV crush)', () => {
    expect(classifyResolution(-0.06, 60, 40)).toBe('realized_move');
  });
  it('IV −5pts with small move → iv_crush', () => {
    expect(classifyResolution(0.01, 45, 39)).toBe('iv_crush');
  });
  it('neither → faded', () => {
    expect(classifyResolution(0.01, 45, 43)).toBe('faded');
  });
});

describe('base rates', () => {
  it('baseHitProb: bullish = pos share, bearish = neg share (zeros count against)', () => {
    const c = { pos: 30, neg: 18, total: 50 }; // 2 zero days
    expect(baseHitProb(c, 'bullish')).toBeCloseTo(0.6, 10);
    expect(baseHitProb(c, 'bearish')).toBeCloseTo(0.36, 10);
    expect(baseHitProb({ pos: 0, neg: 0, total: 0 }, 'bullish')).toBeNull();
  });
  it('mergeCounts pools cohort members', () => {
    expect(mergeCounts([{ pos: 1, neg: 2, total: 3 }, { pos: 4, neg: 0, total: 5 }])).toEqual({ pos: 5, neg: 2, total: 8 });
  });
});

describe('buildMatrix', () => {
  const row = (over: Partial<MatrixRow>): MatrixRow => ({
    signalType: 'skew_z',
    direction: 'bullish',
    regimeVol: 'pos',
    regimeTrend: 'pos',
    regimeGamma: 'pos',
    ret: 0.01,
    baseHitProb: 0.5,
    baseSource: 'ticker',
    ...over,
  });

  it('hit rate, base rate, excess and Wilson — hand-checked cell', () => {
    // 25 bullish rows: 15 with ret>0 (hits), 10 with ret<0; base prob 0.52 each.
    const rows = [
      ...Array.from({ length: 15 }, () => row({ ret: 0.02, baseHitProb: 0.52 })),
      ...Array.from({ length: 10 }, () => row({ ret: -0.01, baseHitProb: 0.52 })),
    ];
    const m = buildMatrix(rows, 20);
    expect(m.cells).toHaveLength(1);
    const c = m.cells[0]!;
    expect(c.n).toBe(25);
    expect(c.hitRate).toBeCloseTo(0.6, 10);
    expect(c.baseRate).toBeCloseTo(0.52, 10);
    expect(c.excess).toBeCloseTo(0.08, 10); // headline = hit − base
    expect(c.avgRet).toBeCloseTo((15 * 0.02 - 10 * 0.01) / 25, 10);
    expect(c.suppressed).toBe(false);
    expect(c.wilson!.lo).toBeGreaterThan(0.4);
  });

  it('bearish hits on negative returns', () => {
    const rows = [
      ...Array.from({ length: 20 }, () => row({ direction: 'bearish', ret: -0.02, baseHitProb: 0.45 })),
      ...Array.from({ length: 5 }, () => row({ direction: 'bearish', ret: 0.01, baseHitProb: 0.45 })),
    ];
    const c = buildMatrix(rows, 20).cells[0]!;
    expect(c.hitRate).toBeCloseTo(0.8, 10);
  });

  it('null gamma buckets as its own "na" cell (2-D older signals kept, not dropped)', () => {
    const rows = [
      ...Array.from({ length: 20 }, () => row({ regimeGamma: null })),
      ...Array.from({ length: 20 }, () => row({ regimeGamma: 'pos' })),
    ];
    const m = buildMatrix(rows, 20);
    expect(m.cells).toHaveLength(2);
    expect(m.cells.map((c) => c.regimeGamma).sort()).toEqual(['na', 'pos']);
  });

  it('suppression below minCellSample; cellsTested and expectedByChance reported', () => {
    const rows = [
      ...Array.from({ length: 25 }, () => row({})),
      ...Array.from({ length: 5 }, () => row({ signalType: 'pc_extreme' })),
    ];
    const m = buildMatrix(rows, 20);
    expect(m.cellsTested).toBe(2);
    expect(m.suppressedCells).toBe(1);
    expect(m.cells.find((c) => c.signalType === 'pc_extreme')!.suppressed).toBe(true);
    expect(m.expectedByChance).toBeCloseTo(0.1, 5); // 2 cells × 0.05
  });

  it('mixed base sources labeled; rows with null returns excluded', () => {
    const rows = [
      ...Array.from({ length: 10 }, () => row({ baseSource: 'ticker' })),
      ...Array.from({ length: 12 }, () => row({ baseSource: 'cohort' })),
      row({ ret: null }),
    ];
    const c = buildMatrix(rows, 20).cells[0]!;
    expect(c.n).toBe(22);
    expect(c.baseSource).toBe('mixed');
  });
});

describe('eventTrackSummary', () => {
  it('rich hits when realized < implied, cheap when realized > implied; base = undershoot share', () => {
    const predicted = [
      { prediction: 'rich' as const, impliedMove: 0.06, realizedMove: 0.03 }, // hit
      { prediction: 'rich' as const, impliedMove: 0.05, realizedMove: 0.07 }, // miss
      { prediction: 'cheap' as const, impliedMove: 0.03, realizedMove: 0.05 }, // hit
    ];
    const baseEvents = [
      ...predicted,
      { impliedMove: 0.05, realizedMove: 0.04 }, // a 'fair' event feeding the base only
    ];
    const s = eventTrackSummary(predicted, baseEvents);
    expect(s.n).toBe(3);
    expect(s.hits).toBe(2);
    expect(s.hitRate).toBeCloseTo(2 / 3, 10);
    expect(s.undershootBase).toBeCloseTo(2 / 4, 10); // 2 of 4 events undershot implied
  });
});
