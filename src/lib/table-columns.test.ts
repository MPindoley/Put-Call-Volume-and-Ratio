import { describe, expect, it } from 'vitest';
import { COLUMN_DEFS, fitColumns, rowWidth, type ColumnId } from './table-columns';

const ALL = COLUMN_DEFS.map((c) => c.id);
const none = new Set<ColumnId>();

describe('fitColumns', () => {
  it('shows every column when there is room', () => {
    const fit = fitColumns(rowWidth(ALL), none);
    expect(fit.visible).toEqual(ALL);
    expect(fit.droppedForSpace).toEqual([]);
  });

  it('needs ~1,428px for all 18 columns (the old 17 were 1,356px; Mkt Cap adds 64 + a gap)', () => {
    expect(rowWidth(ALL)).toBe(1428);
  });

  it('drops the least important columns first, one group at a time', () => {
    const fit = fitColumns(rowWidth(ALL) - 1, none);
    expect(fit.droppedForSpace).toEqual(['lastUpdated']);
    expect(rowWidth(fit.visible)).toBeLessThanOrEqual(rowWidth(ALL) - 1);
  });

  it('drops Puts 5m and Calls 5m together, never one without the other', () => {
    // Narrow enough that the pair must go.
    const fit = fitColumns(1000, none);
    const hasPuts = fit.visible.includes('putVolume');
    expect(fit.visible.includes('callVolume')).toBe(hasPuts);
    expect(hasPuts).toBe(false);
  });

  it('fits a 1440px laptop with the side panel open (~1,060px) without sideways scrolling', () => {
    const fit = fitColumns(1060, none);
    expect(rowWidth(fit.visible)).toBeLessThanOrEqual(1060);
    // The columns that matter most survive.
    for (const id of ['symbol', 'livePrice', 'conviction', 'putCallRatio', 'netFlow', 'iv30', 'spikeScore'] as const) {
      expect(fit.visible).toContain(id);
    }
  });

  it('never drops the core columns, even when they alone do not fit', () => {
    const fit = fitColumns(200, none);
    expect(fit.visible).toEqual(['symbol', 'livePrice', 'conviction', 'putCallRatio', 'netFlow', 'iv30', 'spikeScore']);
  });

  it('keeps display order regardless of drop order', () => {
    const fit = fitColumns(1100, none);
    const order = ALL.filter((id) => fit.visible.includes(id));
    expect(fit.visible).toEqual(order);
  });

  it('honours columns the user hid, and they free room for others', () => {
    const hidden = new Set<ColumnId>(['sparkline', 'premium']);
    // Sparkline (112) + premium (80) + their two gaps (16) = 208px freed.
    const fit = fitColumns(rowWidth(ALL) - 208, hidden);
    expect(fit.visible).not.toContain('sparkline');
    expect(fit.visible).not.toContain('premium');
    expect(fit.droppedForSpace).toEqual([]); // hiding those two made room for the rest
  });

  it('cannot hide the ticker column', () => {
    expect(fitColumns(5000, new Set<ColumnId>(['symbol'])).visible).toContain('symbol');
  });
});
