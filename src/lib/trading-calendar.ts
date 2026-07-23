/**
 * US equity/options market trading calendar (NYSE/CBOE rules), self-contained
 * — no external dependency, works for any year.
 *
 * Handles full-day holidays (with NYSE weekend-observance rules) and half
 * days (1:00pm ET early close). Used to gate the end-of-day capture so it
 * fires at the right post-close time on early-close days and not at all on
 * holidays — cross-sectional medians require every ticker captured at a
 * comparable, real session close.
 *
 * The numeric core (year, month 1-12, day) is pure and unit-tested; the Date
 * wrappers derive the ET calendar date first so a UTC server clock is safe.
 */

const REGULAR_CLOSE_ET_MIN = 16 * 60; // 16:00 ET
const EARLY_CLOSE_ET_MIN = 13 * 60; // 13:00 ET

/** Anonymous Gregorian computus → Easter Sunday for a given year. */
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=March, 4=April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** Day-of-week for a Y/M/D (UTC-safe, calendar-only). 0=Sun … 6=Sat. */
function dow(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** nth (1-based) given weekday of a month; e.g. 3rd Monday. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  const first = dow(year, month, 1);
  const offset = (weekday - first + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}

/** Last given weekday of a month; e.g. last Monday of May. */
function lastWeekday(year: number, month: number, weekday: number): number {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = dow(year, month, daysInMonth);
  const offset = (last - weekday + 7) % 7;
  return daysInMonth - offset;
}

/** NYSE observance: Sat holiday → observed Fri, Sun → observed Mon. */
function observed(year: number, month: number, day: number): { month: number; day: number } {
  const d = dow(year, month, day);
  if (d === 6) {
    // Saturday → previous Friday (may cross to prior month; rare for these dates)
    const prev = new Date(Date.UTC(year, month - 1, day - 1));
    return { month: prev.getUTCMonth() + 1, day: prev.getUTCDate() };
  }
  if (d === 0) {
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    return { month: next.getUTCMonth() + 1, day: next.getUTCDate() };
  }
  return { month, day };
}

function sameDay(a: { month: number; day: number }, month: number, day: number): boolean {
  return a.month === month && a.day === day;
}

/** Full-day market holidays for a year, as {month, day} (already observed). */
export function marketHolidays(year: number): { month: number; day: number }[] {
  const easter = easterSunday(year);
  const goodFriday = new Date(Date.UTC(year, easter.month - 1, easter.day - 2));
  const holidays: { month: number; day: number }[] = [
    observed(year, 1, 1), // New Year's Day
    { month: 1, day: nthWeekday(year, 1, 1, 3) }, // MLK — 3rd Monday
    { month: 2, day: nthWeekday(year, 2, 1, 3) }, // Presidents — 3rd Monday
    { month: goodFriday.getUTCMonth() + 1, day: goodFriday.getUTCDate() }, // Good Friday
    { month: 5, day: lastWeekday(year, 5, 1) }, // Memorial — last Monday
    observed(year, 7, 4), // Independence Day
    { month: 9, day: nthWeekday(year, 9, 1, 1) }, // Labor — 1st Monday
    { month: 11, day: nthWeekday(year, 11, 4, 4) }, // Thanksgiving — 4th Thursday
    observed(year, 12, 25), // Christmas
  ];
  if (year >= 2022) holidays.push(observed(year, 6, 19)); // Juneteenth (federal from 2021, NYSE from 2022)
  return holidays;
}

export function isMarketHoliday(year: number, month: number, day: number): boolean {
  return marketHolidays(year).some((h) => sameDay(h, month, day));
}

export function isTradingDay(year: number, month: number, day: number): boolean {
  const d = dow(year, month, day);
  if (d === 0 || d === 6) return false;
  return !isMarketHoliday(year, month, day);
}

/**
 * Early-close (1pm ET) days: day after Thanksgiving, Dec 24 (when a weekday),
 * and July 3 (when a weekday and the 4th is the holiday). Returns false on
 * non-trading days.
 */
export function isEarlyClose(year: number, month: number, day: number): boolean {
  if (!isTradingDay(year, month, day)) return false;
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  if (month === 11 && day === thanksgiving + 1) return true; // Black Friday
  if (month === 12 && day === 24) return true; // Christmas Eve (weekday only, gated above)
  if (month === 7 && day === 3) return true; // day before Independence Day
  return false;
}

/** Close time in ET minutes-since-midnight, or null if not a trading day. */
export function closeMinutesEt(year: number, month: number, day: number): number | null {
  if (!isTradingDay(year, month, day)) return null;
  return isEarlyClose(year, month, day) ? EARLY_CLOSE_ET_MIN : REGULAR_CLOSE_ET_MIN;
}

// ─── Date wrappers (derive the ET calendar date first) ────────────────────────

function etParts(now: Date): { year: number; month: number; day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const hour = get('hour') % 24;
  return { year: get('year'), month: get('month'), day: get('day'), minutes: hour * 60 + get('minute') };
}

export function isTradingDayNow(now = new Date()): boolean {
  const { year, month, day } = etParts(now);
  return isTradingDay(year, month, day);
}

/**
 * True when `now` sits in the post-close capture window for today's session:
 * [close + delayMin, close + delayMin + windowMin). The delay accounts for the
 * 15-minute feed lag flushing after the bell.
 */
export function inCaptureWindow(now = new Date(), delayMin = 20, windowMin = 30): boolean {
  const { year, month, day, minutes } = etParts(now);
  const close = closeMinutesEt(year, month, day);
  if (close === null) return false;
  const start = close + delayMin;
  return minutes >= start && minutes < start + windowMin;
}

/** ET calendar date (midnight UTC-stamped) for keying daily rows. */
export function etDateKey(now = new Date()): Date {
  const { year, month, day } = etParts(now);
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * ET wall-clock parts of an instant: the ET calendar date (ISO YYYY-MM-DD) and
 * minutes-since-ET-midnight. DST-aware. Used to classify an SEC filing's
 * acceptance timestamp (given in UTC) into before-open / after-close.
 */
export function etTimeParts(now: Date): { dateKey: string; minutesOfDay: number } {
  const { year, month, day, minutes } = etParts(now);
  const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { dateKey, minutesOfDay: minutes };
}

/**
 * Count of NYSE/CBOE trading sessions in the half-open interval (from, to] —
 * i.e. sessions strictly after `from` up to and including `to`. Both bounds are
 * reduced to their ET calendar date first, so a UTC server clock is safe.
 *
 * Convention (used by the event-variance decomposition): time-to-expiry is
 * measured in *trading days* from today's session to the expiry session, so a
 * contract expiring on the next trading day counts 1. If `to <= from` the
 * result is 0 (never negative). This is the counter behind τ = tradingDays/252,
 * documented in METRICS.md — calendar days would overstate diffusive variance
 * across weekends and holidays when no trading (hence no diffusion) occurs.
 */
export function tradingDaysBetween(from: Date, to: Date): number {
  const start = etDateKey(from);
  const end = etDateKey(to);
  if (end.getTime() <= start.getTime()) return 0;
  let count = 0;
  const cursor = new Date(start.getTime());
  // Walk one calendar day at a time from the day after `from` through `to`.
  while (cursor.getTime() < end.getTime()) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (isTradingDay(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate())) {
      count += 1;
    }
  }
  return count;
}
