/**
 * SEC EDGAR — historical earnings confirmation from 8-K Item 2.02 filings.
 *
 * Earnings results are furnished on a Form 8-K under Item 2.02 ("Results of
 * Operations and Financial Condition"). EDGAR is official, free and reliable, so
 * it is the ground-truth source for CONFIRMED earnings history (and for
 * auto-confirming a forward event once the company actually reports). It is NOT a
 * forward schedule — those stay bulge-identified + operator-confirmed.
 *
 * The win: the filing's **acceptance timestamp** gives report timing for free. A
 * release accepted ≥16:00 ET is after-market (reaction is the next session); one
 * accepted <09:30 ET is before-open (reaction is that session). That retires the
 * timing-uncertain bucket for EDGAR-sourced events, so they enter the rich/cheap
 * statistic measured on the correct session.
 *
 * Caveats handled here: SEC requires a declared User-Agent with a contact email
 * and rate-limits (we throttle + identify); acceptance datetime is used, not the
 * filing date; ticker→CIK uses the official mapping file; not every Item 2.02 is a
 * quarterly report (we require quarterly spacing before accepting, else flag for
 * review); amendments must not duplicate (8-K/A is skipped and spacing dedups);
 * every fetch is cached.
 *
 * The pure core (timing derivation, filing extraction, quarterly selection) is
 * unit-tested; the network client is a thin, throttled, cached wrapper.
 */
import { etTimeParts } from './trading-calendar';

export type EdgarTiming = 'bmo' | 'amc' | 'intraday';

/**
 * Classify an 8-K acceptance instant (UTC) into report timing, ET-wall-clock and
 * DST aware. ≥16:00 ET → after-market; <09:30 ET → before-open; otherwise a rare
 * intraday release (measured like before-open: last-uninformed close → that close).
 */
export function deriveReportTiming(acceptedAt: Date): EdgarTiming {
  const { minutesOfDay } = etTimeParts(acceptedAt);
  if (minutesOfDay >= 16 * 60) return 'amc';
  if (minutesOfDay < 9 * 60 + 30) return 'bmo';
  return 'intraday';
}

/** ET calendar date (YYYY-MM-DD) of an acceptance instant — the report date. */
export function etReportDate(acceptedAt: Date): string {
  return etTimeParts(acceptedAt).dateKey;
}

export interface EarningsFiling {
  /** Acceptance instant (UTC). */
  acceptedAt: Date;
  /** ET report date (YYYY-MM-DD). */
  reportDate: string;
  timing: EdgarTiming;
  /** Original SEC filingDate string (for audit). */
  filingDate: string;
  form: string;
}

interface SubmissionsRecent {
  form?: string[];
  items?: string[];
  filingDate?: string[];
  acceptanceDateTime?: string[];
}

/**
 * Extract earnings 8-K Item 2.02 filings from a parsed EDGAR submissions payload.
 * Amendments (8-K/A) are skipped so they can never create a duplicate event.
 * Returns ascending by acceptance time.
 */
export function extractEarningsFilings(recent: SubmissionsRecent): EarningsFiling[] {
  const forms = recent.form ?? [];
  const items = recent.items ?? [];
  const dates = recent.filingDate ?? [];
  const accepted = recent.acceptanceDateTime ?? [];
  const out: EarningsFiling[] = [];
  for (let i = 0; i < forms.length; i++) {
    if (forms[i] !== '8-K') continue; // exclude 8-K/A amendments
    if (!(items[i] ?? '').split(/[,\s]+/).includes('2.02')) continue;
    const acc = accepted[i];
    if (!acc) continue;
    const acceptedAt = new Date(acc);
    if (Number.isNaN(acceptedAt.getTime())) continue;
    out.push({
      acceptedAt,
      reportDate: etReportDate(acceptedAt),
      timing: deriveReportTiming(acceptedAt),
      filingDate: dates[i] ?? '',
      form: forms[i]!,
    });
  }
  return out.sort((a, b) => a.acceptedAt.getTime() - b.acceptedAt.getTime());
}

export interface SelectedEvent extends EarningsFiling {
  /** Accepted as a quarterly report (spacing cleared) → confirmed ground truth. */
  confirmed: boolean;
  /** Too close to the prior accepted report (likely prelim/guidance/amendment) → flag for review. */
  pendingReview: boolean;
}

/**
 * Require quarterly cadence before accepting. Walking ascending, a filing is
 * accepted (confirmed) when it is ≥ `minSpacingDays` after the last accepted one;
 * a filing that lands too soon is flagged `pendingReview` (a preliminary result,
 * a guidance update, or an amendment re-using Item 2.02 — not a new quarter), never
 * silently dropped. Larger-than-a-quarter gaps still accept (a real quarter we
 * simply lack the neighbours for).
 */
export function selectQuarterlyEvents(filings: EarningsFiling[], minSpacingDays = 45): SelectedEvent[] {
  const DAY = 86_400_000;
  let lastAccepted: number | null = null;
  return filings.map((f) => {
    const t = f.acceptedAt.getTime();
    const tooSoon = lastAccepted !== null && (t - lastAccepted) / DAY < minSpacingDays;
    if (tooSoon) return { ...f, confirmed: false, pendingReview: true };
    lastAccepted = t;
    return { ...f, confirmed: true, pendingReview: false };
  });
}

/** Parse the official company_tickers.json into a TICKER → zero-padded-10 CIK map. */
export function parseCikMap(json: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (json && typeof json === 'object') {
    for (const row of Object.values(json as Record<string, { cik_str?: number; ticker?: string }>)) {
      if (row?.ticker && typeof row.cik_str === 'number') {
        map.set(row.ticker.toUpperCase(), String(row.cik_str).padStart(10, '0'));
      }
    }
  }
  return map;
}

// ─── Network client (throttled, cached, identified) ───────────────────────────

const CIK_MAP_URL = 'https://www.sec.gov/files/company_tickers.json';
const SUBMISSIONS_URL = (cik: string): string => `https://data.sec.gov/submissions/CIK${cik}.json`;
const MIN_INTERVAL_MS = 130; // < 10 req/s, well within SEC's limit

export interface EdgarCacheStore {
  get(key: string): Promise<string | null>;
  put(key: string, json: string): Promise<void>;
}

export class EdgarClient {
  private readonly userAgent: string;
  private readonly cache: EdgarCacheStore | null;
  private lastFetch = 0;

  constructor(contactEmail: string | undefined, cache: EdgarCacheStore | null = null) {
    if (!contactEmail) {
      throw new Error('SEC_CONTACT_EMAIL is required — SEC blocks requests without a declared contact.');
    }
    this.userAgent = `Put-Call-Volume-and-Ratio/1.0 (${contactEmail})`;
    this.cache = cache;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastFetch + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastFetch = Date.now();
  }

  /** Fetch (or read cached) JSON text for a key. */
  private async fetchText(url: string, cacheKey: string): Promise<string> {
    const cached = this.cache ? await this.cache.get(cacheKey) : null;
    if (cached !== null) return cached;
    await this.throttle();
    const res = await fetch(url, { headers: { 'User-Agent': this.userAgent, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`EDGAR ${res.status} for ${cacheKey}`);
    const text = await res.text();
    if (this.cache) await this.cache.put(cacheKey, text);
    return text;
  }

  async cikMap(): Promise<Map<string, string>> {
    return parseCikMap(JSON.parse(await this.fetchText(CIK_MAP_URL, 'company_tickers')));
  }

  /** Confirmed + flagged quarterly earnings events for a CIK, newest first. */
  async earningsEvents(cik: string, minSpacingDays = 45): Promise<SelectedEvent[]> {
    const json = JSON.parse(await this.fetchText(SUBMISSIONS_URL(cik), `sub:${cik}`)) as {
      filings?: { recent?: SubmissionsRecent };
    };
    const filings = extractEarningsFilings(json.filings?.recent ?? {});
    return selectQuarterlyEvents(filings, minSpacingDays).reverse();
  }
}
