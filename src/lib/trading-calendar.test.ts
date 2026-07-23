import { describe, expect, it } from 'vitest';
import {
  closeMinutesEt,
  easterSunday,
  isEarlyClose,
  isMarketHoliday,
  isTradingDay,
  tradingDaysBetween,
} from './trading-calendar';

describe('easterSunday', () => {
  it('2025 → April 20', () => {
    expect(easterSunday(2025)).toEqual({ month: 4, day: 20 });
  });
  it('2026 → April 5', () => {
    expect(easterSunday(2026)).toEqual({ month: 4, day: 5 });
  });
});

describe('isMarketHoliday', () => {
  it('2025 fixed + floating holidays', () => {
    expect(isMarketHoliday(2025, 1, 1)).toBe(true); // New Year
    expect(isMarketHoliday(2025, 1, 20)).toBe(true); // MLK
    expect(isMarketHoliday(2025, 2, 17)).toBe(true); // Presidents
    expect(isMarketHoliday(2025, 4, 18)).toBe(true); // Good Friday
    expect(isMarketHoliday(2025, 5, 26)).toBe(true); // Memorial
    expect(isMarketHoliday(2025, 6, 19)).toBe(true); // Juneteenth
    expect(isMarketHoliday(2025, 7, 4)).toBe(true); // Independence
    expect(isMarketHoliday(2025, 9, 1)).toBe(true); // Labor
    expect(isMarketHoliday(2025, 11, 27)).toBe(true); // Thanksgiving
    expect(isMarketHoliday(2025, 12, 25)).toBe(true); // Christmas
  });
  it('observance: July 4 2026 (Sat) observed Fri July 3', () => {
    expect(isMarketHoliday(2026, 7, 3)).toBe(true);
    expect(isMarketHoliday(2026, 7, 4)).toBe(false); // the Saturday itself is not "the holiday"
  });
  it('a normal trading day is not a holiday', () => {
    expect(isMarketHoliday(2025, 3, 12)).toBe(false);
  });
});

describe('isTradingDay', () => {
  it('weekend → false', () => {
    expect(isTradingDay(2025, 3, 15)).toBe(false); // Saturday
    expect(isTradingDay(2025, 3, 16)).toBe(false); // Sunday
  });
  it('holiday → false, normal weekday → true', () => {
    expect(isTradingDay(2025, 12, 25)).toBe(false);
    expect(isTradingDay(2025, 12, 26)).toBe(true);
  });
});

describe('isEarlyClose', () => {
  it('Black Friday 2025 (Nov 28) is a half day', () => {
    expect(isEarlyClose(2025, 11, 28)).toBe(true);
  });
  it('Christmas Eve 2025 (Dec 24, Wed) is a half day', () => {
    expect(isEarlyClose(2025, 12, 24)).toBe(true);
  });
  it('a holiday is never an early close', () => {
    expect(isEarlyClose(2025, 12, 25)).toBe(false);
  });
});

describe('tradingDaysBetween (half-open (from, to])', () => {
  const d = (iso: string): Date => new Date(`${iso}T12:00:00Z`);
  it('Mon→Fri of a clean week is 4 sessions', () => {
    // 2025-03-10 Mon … 2025-03-14 Fri, no holidays.
    expect(tradingDaysBetween(d('2025-03-10'), d('2025-03-14'))).toBe(4);
  });
  it('skips the weekend: Fri→Mon is 1 session', () => {
    expect(tradingDaysBetween(d('2025-03-14'), d('2025-03-17'))).toBe(1);
  });
  it('skips a holiday inside the span (Christmas 2025)', () => {
    // 2025-12-24 Wed (half day, still a session) → 2025-12-26 Fri: only the 26th counts (25th holiday).
    expect(tradingDaysBetween(d('2025-12-24'), d('2025-12-26'))).toBe(1);
  });
  it('non-positive spans return 0, never negative', () => {
    expect(tradingDaysBetween(d('2025-03-14'), d('2025-03-14'))).toBe(0);
    expect(tradingDaysBetween(d('2025-03-14'), d('2025-03-10'))).toBe(0);
  });
});

describe('closeMinutesEt', () => {
  it('regular day → 16:00 = 960', () => {
    expect(closeMinutesEt(2025, 3, 12)).toBe(960);
  });
  it('early close → 13:00 = 780', () => {
    expect(closeMinutesEt(2025, 11, 28)).toBe(780);
  });
  it('holiday → null', () => {
    expect(closeMinutesEt(2025, 12, 25)).toBeNull();
  });
});
