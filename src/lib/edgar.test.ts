import { describe, expect, it } from 'vitest';
import {
  deriveReportTiming,
  etReportDate,
  extractEarningsFilings,
  parseCikMap,
  selectQuarterlyEvents,
  type EarningsFiling,
} from './edgar';

describe('deriveReportTiming (ET, DST-aware)', () => {
  it('after 16:00 ET → amc (summer EDT: 20:30Z = 16:30 ET)', () => {
    expect(deriveReportTiming(new Date('2025-07-31T20:30:00Z'))).toBe('amc');
  });
  it('after 16:00 ET → amc (winter EST: 21:30Z = 16:30 ET)', () => {
    expect(deriveReportTiming(new Date('2026-01-29T21:30:00Z'))).toBe('amc');
  });
  it('before 09:30 ET → bmo (13:00Z = 09:00 ET summer)', () => {
    expect(deriveReportTiming(new Date('2025-07-31T13:00:00Z'))).toBe('bmo');
  });
  it('mid-session → intraday (17:00Z = 13:00 ET summer)', () => {
    expect(deriveReportTiming(new Date('2025-07-31T17:00:00Z'))).toBe('intraday');
  });
  it('etReportDate uses the ET calendar date', () => {
    // 2025-08-01T01:00Z = 2025-07-31 21:00 ET → report date is the 31st.
    expect(etReportDate(new Date('2025-08-01T01:00:00Z'))).toBe('2025-07-31');
  });
});

describe('extractEarningsFilings', () => {
  const recent = {
    form: ['8-K', '10-Q', '8-K', '8-K/A', '8-K'],
    items: ['2.02,9.01', '', '7.01', '2.02', '2.02,9.01'],
    filingDate: ['2025-07-31', '2025-08-01', '2025-06-01', '2025-05-02', '2025-05-01'],
    acceptanceDateTime: [
      '2025-07-31T20:30:00Z',
      '2025-08-01T10:00:00Z',
      '2025-06-01T18:00:00Z', // item 7.01, not earnings
      '2025-05-02T12:00:00Z', // 8-K/A amendment → skipped
      '2025-05-01T20:30:00Z',
    ],
  };
  it('keeps only 8-K Item 2.02, drops 10-Q, 7.01 and 8-K/A, sorted ascending', () => {
    const filings = extractEarningsFilings(recent);
    expect(filings.map((f) => f.reportDate)).toEqual(['2025-05-01', '2025-07-31']);
    expect(filings.every((f) => f.form === '8-K')).toBe(true);
    expect(filings[0]!.timing).toBe('amc');
  });
});

describe('selectQuarterlyEvents', () => {
  const f = (isoAccept: string): EarningsFiling => ({
    acceptedAt: new Date(isoAccept),
    reportDate: etReportDate(new Date(isoAccept)),
    timing: 'amc',
    filingDate: isoAccept.slice(0, 10),
    form: '8-K',
  });

  it('accepts quarterly-spaced reports and flags a too-soon filing for review', () => {
    const filings = [
      f('2025-01-30T21:30:00Z'),
      f('2025-02-05T21:30:00Z'), // 6 days later → prelim/guidance/amendment → pendingReview
      f('2025-05-01T20:30:00Z'), // ~quarter later → accepted
      f('2025-07-31T20:30:00Z'), // ~quarter later → accepted
    ];
    const sel = selectQuarterlyEvents(filings, 45);
    expect(sel.map((s) => s.confirmed)).toEqual([true, false, true, true]);
    expect(sel.map((s) => s.pendingReview)).toEqual([false, true, false, false]);
  });

  it('accepts a larger-than-quarter gap (a real quarter with missing neighbours)', () => {
    const sel = selectQuarterlyEvents([f('2025-01-30T21:30:00Z'), f('2025-08-01T20:30:00Z')], 45);
    expect(sel.every((s) => s.confirmed)).toBe(true);
  });
});

describe('parseCikMap', () => {
  it('maps upper-cased tickers to zero-padded 10-digit CIKs', () => {
    const map = parseCikMap({
      '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
      '1': { cik_str: 789019, ticker: 'MSFT', title: 'Microsoft' },
    });
    expect(map.get('AAPL')).toBe('0000320193');
    expect(map.get('MSFT')).toBe('0000789019');
  });
});
