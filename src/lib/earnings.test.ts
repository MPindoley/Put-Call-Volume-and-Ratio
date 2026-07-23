import { describe, expect, it } from 'vitest';
import { realizedEventMove, richCheapGauge, type GaugeEvent } from './earnings';

describe('realizedEventMove (timing-aware)', () => {
  const sessions = ['2026-04-20', '2026-04-21', '2026-04-22'];
  const closeByDate = new Map([
    ['2026-04-20', 100],
    ['2026-04-21', 110],
    ['2026-04-22', 105],
  ]);

  it('bmo measures prior-close → event-close', () => {
    const m = realizedEventMove('2026-04-21', 'bmo', closeByDate, sessions);
    expect(m?.movePct).toBeCloseTo(Math.abs(Math.log(110 / 100)), 8);
    expect(m?.timingUncertain).toBe(false);
    expect(m?.session).toBe('2026-04-21');
  });

  it('amc measures event-close → next-close', () => {
    const m = realizedEventMove('2026-04-21', 'amc', closeByDate, sessions);
    expect(m?.movePct).toBeCloseTo(Math.abs(Math.log(105 / 110)), 8);
    expect(m?.timingUncertain).toBe(false);
    expect(m?.session).toBe('2026-04-22');
  });

  it('unknown measures amc convention but flags timing-uncertain', () => {
    const m = realizedEventMove('2026-04-21', 'unknown', closeByDate, sessions);
    expect(m?.movePct).toBeCloseTo(Math.abs(Math.log(105 / 110)), 8);
    expect(m?.timingUncertain).toBe(true);
  });

  it('returns null when the required neighbouring session is missing', () => {
    expect(realizedEventMove('2026-04-20', 'bmo', closeByDate, sessions)).toBeNull(); // no prior
    expect(realizedEventMove('2026-04-22', 'amc', closeByDate, sessions)).toBeNull(); // no next
  });
});

describe('richCheapGauge (confirmed events only)', () => {
  const confirmed = (move: number, source: 'manual' | 'forward' = 'manual'): GaugeEvent => ({
    source,
    confirmed: true,
    realizedMovePct: move,
    realizedTimingUncertain: false,
  });

  it('stays suppressed (no number) below the confirmed threshold', () => {
    const g = richCheapGauge(0.05, [confirmed(0.04), confirmed(0.06)], 8);
    expect(g.display).toBe(false);
    expect(g.percentile).toBeNull();
    expect(g.medianRealized).toBeNull();
    expect(g.confirmedCount).toBe(2);
  });

  it('displays once enough confirmed events accrue', () => {
    const events = Array.from({ length: 8 }, (_, i) => confirmed(0.03 + i * 0.005));
    const g = richCheapGauge(0.08, events, 8);
    expect(g.display).toBe(true);
    expect(g.confirmedCount).toBe(8);
    expect(g.percentile).toBe(100); // 0.08 above every realized move → richly priced
    expect(g.richCheapRatio).toBeGreaterThan(1);
  });

  it('counts forward-confirmed alongside manual, but excludes unconfirmed and timing-uncertain', () => {
    const events: GaugeEvent[] = [
      ...Array.from({ length: 5 }, () => confirmed(0.05, 'manual')),
      ...Array.from({ length: 3 }, () => confirmed(0.05, 'forward')),
      { source: 'forward', confirmed: false, realizedMovePct: 0.05, realizedTimingUncertain: false }, // unconfirmed
      { source: 'manual', confirmed: true, realizedMovePct: 0.05, realizedTimingUncertain: true }, // timing-uncertain
    ];
    const g = richCheapGauge(0.05, events, 8);
    expect(g.confirmedCount).toBe(8); // 5 manual + 3 forward-confirmed
    expect(g.display).toBe(true);
  });

  it('a realized move of null does not count', () => {
    const events: GaugeEvent[] = [
      ...Array.from({ length: 7 }, () => confirmed(0.05)),
      { source: 'forward', confirmed: true, realizedMovePct: null, realizedTimingUncertain: false },
    ];
    const g = richCheapGauge(0.05, events, 8);
    expect(g.confirmedCount).toBe(7);
    expect(g.display).toBe(false);
  });
});
