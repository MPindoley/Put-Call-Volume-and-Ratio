import { describe, expect, it } from 'vitest';
import type { Evidence } from './learning';
import { buildComboBook, COMBO_PARAMS, comboViews, compactComboBook } from './signal-combos';

let day = 0;
/** `n` name-days on which the given signal types fired (same direction), `hits` of them hits, against a 50% base. */
function days(n: number, hits: number, types: string[], over: Partial<Evidence> = {}): Evidence[] {
  const out: Evidence[] = [];
  for (let i = 0; i < n; i++) {
    day += 1;
    for (const signalType of types) {
      out.push({
        signalType,
        direction: 'bullish',
        regime: 'pos|pos',
        sector: 'Technology',
        symbol: `S${day}`,
        firedIdx: 100,
        knownIdx: 100,
        hit: i < hits,
        base: 0.5,
        ...over,
      });
    }
  }
  return out;
}
const view = (evidence: Evidence[], a = 'skew_z', b = 'pc_extreme') =>
  comboViews(buildComboBook(evidence, 100, 120)).find((v) => v.a === a && v.b === b && v.direction === 'bullish');

describe('buildComboBook', () => {
  it('separates days both fired from days each fired without the other', () => {
    const book = buildComboBook(
      [...days(50, 40, ['skew_z', 'pc_extreme']), ...days(60, 30, ['skew_z']), ...days(70, 35, ['pc_extreme'])],
      100,
      120,
    );
    const pair = book['skew_z+pc_extreme|bullish']!;
    expect(pair.together).toMatchObject({ n: 50, nEff: 50 });
    expect(pair.together.excess).toBeCloseTo(40 - 25, 9);
    expect(pair.aAlone.n).toBe(60);
    expect(pair.bAlone.n).toBe(70);
    // A day with only skew_z is also "skew_z without spike_alert", but no spike_alert+pc_own pair exists at all.
    expect(book['skew_z+spike_alert|bullish']!.aAlone.n).toBe(110);
    expect(book['spike_alert+pc_own|bullish']).toBeUndefined();
  });

  it('treats opposite directions as different days for a pair, skips rows without a base rate or not yet knowable', () => {
    const opposite = [...days(5, 5, ['skew_z']), ...days(5, 5, ['pc_extreme'], { direction: 'bearish' })].map((e) => ({
      ...e,
      symbol: 'SAME',
    }));
    const book = buildComboBook(opposite, 100, 120);
    expect(book['skew_z+pc_extreme|bullish']!.together.n).toBe(0);
    expect(book['skew_z+pc_extreme|bearish']!.bAlone.n).toBe(1); // one name-day, collapsed
    expect(buildComboBook(days(5, 5, ['skew_z', 'pc_extreme'], { base: null }), 100, 120)).toEqual({});
    expect(buildComboBook(days(5, 5, ['skew_z', 'pc_extreme'], { knownIdx: 101 }), 100, 120)).toEqual({});
  });

  it('weighs recent co-firings more', () => {
    const book = buildComboBook(days(10, 10, ['skew_z', 'pc_extreme'], { firedIdx: 0, knownIdx: 20 }), 120, 120);
    expect(book['skew_z+pc_extreme|bullish']!.together.nEff).toBeCloseTo(5, 9); // one half-life old
  });
});

describe('comboViews', () => {
  it('calls a pair stronger together only when it clears the better of the two alone', () => {
    const v = view([
      ...days(200, 150, ['skew_z', 'pc_extreme']),
      ...days(200, 110, ['skew_z']),
      ...days(200, 100, ['pc_extreme']),
    ])!;
    expect(v.n).toBe(200);
    expect(v.aAlone).toBeCloseTo((110 - 100) / (200 + COMBO_PARAMS.prior), 9);
    expect(v.bAlone).toBeCloseTo(0, 9);
    // Shrunk toward the average of the two alone edges, not toward zero.
    const parent = (v.aAlone + v.bAlone) / 2;
    expect(v.together).toBeCloseTo((150 - 100 + COMBO_PARAMS.prior * parent) / (200 + COMBO_PARAMS.prior), 9);
    expect(v.verdict).toBe('stronger');
    expect(v.assumed).toBeCloseTo((v.aAlone + v.bAlone) / Math.SQRT2, 9);
    expect(v.together!).toBeGreaterThan(v.assumed); // more than the lean's rule gives it credit for
  });

  it('says no clear difference when company adds nothing, and weaker when it hurts', () => {
    const same = view([
      ...days(200, 120, ['skew_z', 'pc_extreme']),
      ...days(200, 120, ['skew_z']),
      ...days(200, 118, ['pc_extreme']),
    ])!;
    expect(same.verdict).toBe('same');
    const worse = view([
      ...days(200, 80, ['skew_z', 'pc_extreme']),
      ...days(200, 120, ['skew_z']),
      ...days(200, 125, ['pc_extreme']),
    ])!;
    expect(worse.verdict).toBe('weaker');
  });

  it('says nothing about a pair with too few co-firings, however good they look', () => {
    const v = view([
      ...days(COMBO_PARAMS.minGraded - 1, COMBO_PARAMS.minGraded - 1, ['skew_z', 'pc_extreme']),
      ...days(200, 100, ['skew_z']),
    ])!;
    expect(v).toMatchObject({ verdict: 'learning', together: null, n: COMBO_PARAMS.minGraded - 1 });
  });

  it('does not let a few lucky co-firings manufacture a synergy', () => {
    // 30 co-firings, 22 hits: raw +23 points. Against a prior of 40 and its standard error, not enough to claim.
    const v = view([
      ...days(30, 22, ['skew_z', 'pc_extreme']),
      ...days(300, 150, ['skew_z']),
      ...days(300, 150, ['pc_extreme']),
    ])!;
    expect(v.together!).toBeLessThan(0.11);
    expect(v.verdict).toBe('stronger'); // 10 points clears the floor here…
    const fewer = view([
      ...days(30, 19, ['skew_z', 'pc_extreme']),
      ...days(300, 150, ['skew_z']),
      ...days(300, 150, ['pc_extreme']),
    ])!;
    expect(fewer.verdict).toBe('same'); // …a raw +13 does not
  });

  it('lists only pairs that have co-fired, most co-firings first, and survives rounding for storage', () => {
    const book = buildComboBook(
      [...days(40, 20, ['skew_z', 'pc_extreme']), ...days(60, 30, ['pc_extreme', 'spike_alert']), ...days(10, 5, ['divergence'])],
      100,
      120,
    );
    const views = comboViews(book);
    expect(views.map((v) => `${v.a}+${v.b}`)).toEqual(['pc_extreme+spike_alert', 'skew_z+pc_extreme']);
    expect(comboViews(compactComboBook(book))).toEqual(views);
  });
});
