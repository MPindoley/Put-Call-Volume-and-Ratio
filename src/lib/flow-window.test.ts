import { describe, expect, it } from 'vitest';
import { FLOW_WINDOW_MS, MIN_COVERAGE_MS, pruneIntervals, windowFlow, type FlowInterval } from './flow-window';

const MIN = 60_000;
const iv = (startMin: number, endMin: number, put: number, call: number): FlowInterval => ({
  start: startMin * MIN,
  end: endMin * MIN,
  putVolume: put,
  callVolume: call,
  putPremium: put * 100,
  callPremium: call * 100,
});

describe('windowFlow', () => {
  it('is empty with no intervals', () => {
    const w = windowFlow([]);
    expect(w.putVolume).toBe(0);
    expect(w.endAt).toBeNull();
  });

  it('reports exactly the window when intervals tile it', () => {
    const w = windowFlow([iv(0, 5, 999, 999), iv(5, 7, 200, 100), iv(7, 10, 300, 600)]);
    expect(w.putVolume).toBe(500);
    expect(w.callVolume).toBe(700);
    expect(w.coveredMs).toBe(FLOW_WINDOW_MS);
    expect(w.endAt).toBe(10 * MIN);
  });

  it('takes a straddling interval pro rata', () => {
    // Window = minutes 5..10. Interval 2..8 contributes 3 of its 6 minutes.
    const w = windowFlow([iv(2, 8, 600, 300), iv(8, 10, 100, 100)]);
    expect(w.putVolume).toBe(400); // 600×3/6 + 100
    expect(w.callVolume).toBe(250); // 300×3/6 + 100
  });

  it('scales a long newest interval to a per-5-minute rate (a 9-minute gap is not "5m")', () => {
    // 900 puts over 9 minutes = 500 per 5 minutes.
    const w = windowFlow([iv(0, 9, 900, 450)]);
    expect(w.putVolume).toBe(500);
    expect(w.callVolume).toBe(250);
    expect(w.rawPutVolume).toBe(900); // the measured volume is kept too
    expect(w.coveredMs).toBe(9 * MIN);
  });

  it('makes names refreshed at different speeds comparable', () => {
    // Same underlying pace (100 puts/minute), one refreshed every 2 minutes, one every 9.
    const fast = windowFlow([iv(0, 2, 200, 0), iv(2, 4, 200, 0), iv(4, 6, 200, 0)]);
    const slow = windowFlow([iv(0, 9, 900, 0)]);
    expect(fast.putVolume).toBe(500);
    expect(slow.putVolume).toBe(500);
  });

  it('extrapolates a short history to the window rate', () => {
    // 2 minutes of data, 80 puts → 200 per 5 minutes.
    expect(windowFlow([iv(0, 2, 80, 40)]).putVolume).toBe(200);
  });

  it('refuses to extrapolate from less than a minute of data', () => {
    const w = windowFlow([{ ...iv(0, 0, 50, 50), end: MIN_COVERAGE_MS - 1 }]);
    expect(w.putVolume).toBe(0);
    expect(w.coveredMs).toBe(MIN_COVERAGE_MS - 1);
  });

  it('keeps the P/C ratio of what was measured', () => {
    const w = windowFlow([iv(0, 3, 300, 100), iv(3, 6, 300, 100)]);
    expect(w.putVolume / w.callVolume).toBeCloseTo(3, 1); // up to integer rounding
  });
});

describe('pruneIntervals', () => {
  it('drops intervals that ended more than an hour before the newest', () => {
    const out = pruneIntervals([iv(0, 5, 1, 1), iv(5, 30, 1, 1), iv(30, 70, 1, 1)]);
    expect(out.map((x) => x.end / MIN)).toEqual([30, 70]);
  });
});
