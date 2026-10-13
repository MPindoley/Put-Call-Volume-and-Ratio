/**
 * Builds src/lib/universe-extended.ts: liquid optionable names beyond the
 * hand-curated core in src/lib/universe.ts, chosen by MEASURED options
 * activity rather than guesswork. All sources are free and public:
 *
 *   1. CBOE's equity/index options symbol directory — every listed underlying.
 *   2. Nasdaq's screener — price, share volume, sector and industry per stock
 *      (pre-ranking + sector), and the ETF list. Undocumented endpoint, used
 *      only here at build time, never by the running app.
 *   3. CBOE's delayed-quotes chain per candidate — total open interest and
 *      today's option volume, the actual measure of how much a name trades.
 *
 * Selection: candidates are pre-ranked by share dollar volume (stocks) or quote
 * dollar volume (ETFs), the top slice is measured, and names are kept in order
 * of open interest — positioning, which is stable day to day, unlike one
 * session's volume — until the universe reaches --target names. Leveraged and
 * inverse ETFs are skipped: their skew reads backwards and they need explicit
 * instrument config (src/lib/interpretation.ts) to interpret correctly.
 *
 * Sectors are mapped from Nasdaq's industry text to the app's GICS-style
 * sectors (industry first: Nasdaq's own sector field is noisy). It is an
 * approximation; the script prints its agreement with the curated core so the
 * mapping can be judged, and a sector can be overridden per name in the DB.
 *
 * Usage:  node scripts/build-universe.mjs [--target 1400] [--rps 3] [--refresh]
 * Inputs are cached under scripts/.universe-cache/ (gitignored); --refresh
 * re-downloads them. Re-run every few months as liquidity shifts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
};
const TARGET_TOTAL = arg('--target', 1400);
const RPS = arg('--rps', 3);
const REFRESH = process.argv.includes('--refresh');
/** How many pre-ranked candidates get a chain measurement. */
const STOCK_PREFILTER = arg('--stock-pool', 2000);
const ETF_PREFILTER = arg('--etf-pool', 300);
/** Minimum total open interest (contracts) for a name to be worth tracking. */
const MIN_OI = arg('--min-oi', 10_000);
const MIN_PRICE = 3;

const CACHE = new URL('./.universe-cache/', import.meta.url);
const UA = 'Mozilla/5.0 (put-call-volume-and-ratio universe builder)';
const CBOE = 'https://cdn.cboe.com/api/global/delayed_quotes';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(CACHE, { recursive: true });

async function cached(name, fetcher) {
  const file = new URL(name, CACHE);
  if (!REFRESH && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const value = await fetcher();
  writeFileSync(file, JSON.stringify(value));
  return value;
}

async function getText(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

// ── Sector mapping ──────────────────────────────────────────────────────────
/**
 * Rules over "<nasdaq sector> | <industry>", checked in order (first match
 * wins). Industry text is more reliable than Nasdaq's own sector field, except
 * for catch-all industries (Business Services, Industrial Machinery, Marine
 * Transportation…) whose members span sectors — those fall through to the
 * sector fallback below.
 */
const INDUSTRY_RULES = [
  [/real estate investment trust|\| real estate|building operators/i, 'Real Estate'],
  [/^telecommunications \|/i, 'Communication Services'],
  [/insurance|insurer|bank|savings institution|investment manager|investment banker|broker|finance|financial|credit|trusts except|blank check/i, 'Financials'],
  [/^utilities \| (electric|natural gas distribution|water|power generation)|electric utilit|power generation|water supply|water sewer/i, 'Utilities'],
  [/environmental services/i, 'Industrials'],
  [/^technology \| consumer electronics/i, 'Industrials'],
  [/retail/i, 'Consumer Discretionary'],
  [/semiconductor|computer|software|edp services|electronic components|electrical products|peripheral|radio and television broadcasting and communications equipment|telecommunications equipment/i, 'Technology'],
  [/biotech|pharma|medic|health|hospital|ophthalmic|dental|diagnostic|nursing/i, 'Healthcare'],
  [/oil|natural gas|coal|petroleum|oilfield/i, 'Energy'],
  [/cable|broadcasting|movies|advertising|publishing|newspaper|internet and information/i, 'Communication Services'],
  [/precious metal|metal mining|steel|chemical|paints|coatings|paper|forest product|other metals|mining & quarrying|building materials|aluminum|plastic/i, 'Materials'],
  [/packaged foods|beverage|food chain|meat|poultry|farming|seeds|specialty foods|tobacco|cosmetics|package goods|household|grocery/i, 'Consumer Staples'],
  [/aerospace|military|railroad|trucking|air freight|freight|logistics|construction|engineering|fluid control|metal fabrication|ordnance|professional services|rental|leasing|^miscellaneous \| industrial machinery/i, 'Industrials'],
  [/office equipment/i, 'Technology'],
  [/restaurant|hotel|resort|apparel|clothing|shoe|stores|auto|homebuilding|home furnishings|recreation|toys|amusement|leisure|motor vehicles|textiles|catalog|consumer services|consumer specialties/i, 'Consumer Discretionary'],
];
const SECTOR_FALLBACK = {
  Technology: 'Technology',
  Finance: 'Financials',
  'Health Care': 'Healthcare',
  Energy: 'Energy',
  Industrials: 'Industrials',
  'Consumer Discretionary': 'Consumer Discretionary',
  'Consumer Staples': 'Consumer Staples',
  Utilities: 'Utilities',
  'Basic Materials': 'Materials',
  'Real Estate': 'Real Estate',
  Telecommunications: 'Communication Services',
};
/** Hand fixes for names the rules misfile or leave Unknown (catch-all "Miscellaneous" classifications). */
const SECTOR_OVERRIDES = {
  QS: 'Consumer Discretionary', // battery maker for autos (GICS automobile components)
  PBI: 'Industrials', // mailing & shipping services
  APPS: 'Technology', // mobile ad software ("Multi-Sector Companies" at Nasdaq)
};
function mapSector(nasdaqSector, industry) {
  const key = `${(nasdaqSector ?? '').trim()} | ${(industry ?? '').trim()}`;
  for (const [re, sector] of INDUSTRY_RULES) if (re.test(key)) return sector;
  return SECTOR_FALLBACK[(nasdaqSector ?? '').trim()] ?? 'Unknown';
}

/** Leveraged / inverse products: skipped (see header). "Short-Term" is not "short". */
const LEVERAGED_OR_INVERSE =
  /\b(ultra|ultrapro|inverse|bear|bull|leveraged|lvrgd|lev|daily)\b|\b-?[1-9](\.\d)?x\b|\bshort\b(?!-term)/i;

// ── Inputs ──────────────────────────────────────────────────────────────────
function curatedCore() {
  const src = readFileSync(new URL('../src/lib/universe.ts', import.meta.url), 'utf8');
  const body = src.split('const BY_SECTOR')[1]?.split('Unknown: []')[0] ?? '';
  const out = new Map();
  for (const block of body.matchAll(/(?:'([^']+)'|([A-Za-z]+)):\s*\[([\s\S]*?)\]/g)) {
    const sector = block[1] ?? block[2];
    for (const m of block[3].matchAll(/'([A-Z][A-Z0-9.]{0,6})'/g)) if (!out.has(m[1])) out.set(m[1], sector);
  }
  return out;
}

const optionable = await cached('cboe-symbols.json', async () => {
  const csv = await getText('https://www.cboe.com/us/options/symboldir/equity_index_options/?download=csv');
  return csv
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]))
    .filter((cols) => cols.length >= 2)
    .map(([name, symbol]) => ({ name, symbol: symbol.trim() }));
});
const stocks = await cached('nasdaq-stocks.json', async () =>
  JSON.parse(await getText('https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true', { Accept: 'application/json' }))
    .data.rows,
);
const etfs = await cached('nasdaq-etfs.json', async () =>
  JSON.parse(await getText('https://api.nasdaq.com/api/screener/etf?tableonly=true&download=true', { Accept: 'application/json' }))
    .data.data.rows,
);

const core = curatedCore();
const stockBySymbol = new Map(stocks.map((r) => [r.symbol.replace('/', '.').trim(), r]));
const etfNames = new Map(etfs.map((r) => [r.symbol.trim(), r.companyName ?? '']));
const etfSymbols = new Set(etfNames.keys());
console.log(`optionable underlyings: ${optionable.length} · nasdaq stocks: ${stocks.length} · etfs: ${etfs.length} · curated core: ${core.size}`);

// Mapping quality: how often the rules agree with the hand-curated sectors.
{
  let agree = 0;
  let total = 0;
  const misses = {};
  for (const [symbol, sector] of core) {
    const r = stockBySymbol.get(symbol);
    if (!r || sector === 'ETF') continue;
    total += 1;
    const mapped = mapSector(r.sector, r.industry);
    if (mapped === sector) agree += 1;
    else misses[`${sector} → ${mapped}`] = (misses[`${sector} → ${mapped}`] ?? 0) + 1;
  }
  console.log(`sector mapping agrees with curated core on ${agree}/${total} (${Math.round((100 * agree) / total)}%)`);
  console.log('  most common disagreements:', Object.entries(misses).sort((a, b) => b[1] - a[1]).slice(0, 8));
}

if (process.argv.includes('--mapping-only')) process.exit(0);

const validSymbol = (s) => /^[A-Z]{1,5}(\.[A-Z])?$/.test(s);
const num = (s) => Number(String(s ?? '').replace(/[$,%]/g, '')) || 0;

const stockCandidates = optionable
  .filter(({ symbol }) => validSymbol(symbol) && !core.has(symbol) && stockBySymbol.has(symbol))
  .map(({ symbol }) => {
    const r = stockBySymbol.get(symbol);
    const price = num(r.lastsale);
    const sector = SECTOR_OVERRIDES[symbol] ?? mapSector(r.sector, r.industry);
    return { symbol, kind: 'stock', price, dollarVolume: price * num(r.volume), sector };
  })
  .filter((c) => c.price >= MIN_PRICE)
  .sort((a, b) => b.dollarVolume - a.dollarVolume)
  .slice(0, STOCK_PREFILTER);

// ETFs have no volume in the screener: rank them by CBOE's (tiny) quote endpoint.
const etfPool = optionable.filter(
  ({ symbol, name }) =>
    validSymbol(symbol) &&
    !core.has(symbol) &&
    etfSymbols.has(symbol) &&
    // CBOE abbreviates ("DAILY LVRGD"); Nasdaq spells it out — test both.
    !LEVERAGED_OR_INVERSE.test(`${name} ${etfNames.get(symbol) ?? ''}`),
);
const etfQuotes = await cached('etf-quotes.json', async () => {
  const out = {};
  for (const [i, { symbol }] of etfPool.entries()) {
    try {
      const res = await fetch(`${CBOE}/quotes/${encodeURIComponent(symbol)}.json`, { headers: { 'User-Agent': UA } });
      if (res.ok) {
        const d = (await res.json()).data ?? {};
        out[symbol] = (d.current_price ?? 0) * (d.volume ?? 0);
      }
    } catch {
      /* skip */
    }
    if (i % 200 === 0) console.log(`  etf quotes ${i}/${etfPool.length}`);
    await sleep(1000 / (RPS * 2));
  }
  return out;
});
const etfCandidates = etfPool
  .map(({ symbol }) => ({ symbol, kind: 'etf', dollarVolume: etfQuotes[symbol] ?? 0, sector: 'ETF' }))
  .filter((c) => c.dollarVolume > 0)
  .sort((a, b) => b.dollarVolume - a.dollarVolume)
  .slice(0, ETF_PREFILTER);

// ── Measure options activity ────────────────────────────────────────────────
const candidates = [...stockCandidates, ...etfCandidates];
console.log(`measuring option chains for ${candidates.length} candidates at ~${RPS}/s…`);
let rateLimited = 0;
let measuredNow = false;
const measured = await cached('measured.json', async () => {
  measuredNow = true;
  const out = {};
  for (const [i, c] of candidates.entries()) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const t0 = Date.now();
      try {
        const res = await fetch(`${CBOE}/options/${encodeURIComponent(c.symbol)}.json`, { headers: { 'User-Agent': UA } });
        if (res.status === 429) {
          rateLimited += 1;
          await sleep(5_000 * (attempt + 1));
          continue;
        }
        if (res.ok) {
          const j = await res.json();
          let oi = 0;
          let volume = 0;
          for (const o of j.data?.options ?? []) {
            oi += o.open_interest ?? 0;
            volume += o.volume ?? 0;
          }
          const ageDays = j.timestamp ? (Date.now() - Date.parse(`${j.timestamp.replace(' ', 'T')}Z`)) / 86_400_000 : null;
          out[c.symbol] = { oi, volume, contracts: j.data?.options?.length ?? 0, ageDays };
        }
      } catch {
        /* network blip: leave unmeasured */
      }
      await sleep(Math.max(0, 1000 / RPS - (Date.now() - t0)));
      break;
    }
    if (i % 100 === 0) console.log(`  ${i}/${candidates.length} measured · 429s so far: ${rateLimited}`);
  }
  return out;
});
console.log(
  measuredNow
    ? `chain measurement done · HTTP 429 (rate-limited) responses: ${rateLimited} of ~${candidates.length} requests`
    : 'chain measurements reused from cache (run with --refresh to re-measure)',
);

const slots = Math.max(0, TARGET_TOTAL - core.size);
const chosen = candidates
  .map((c) => ({ ...c, ...(measured[c.symbol] ?? {}) }))
  .filter((c) => (c.oi ?? 0) >= MIN_OI && (c.contracts ?? 0) >= 20 && (c.ageDays ?? 0) < 5)
  .sort((a, b) => b.oi - a.oi)
  .slice(0, slots);

const bySector = {};
for (const c of chosen) bySector[c.sector] = (bySector[c.sector] ?? 0) + 1;
const floorOi = chosen.at(-1)?.oi ?? 0;
console.log(`selected ${chosen.length} names (core ${core.size} → total ${core.size + chosen.length}); smallest OI kept: ${floorOi}`);
console.log('  by sector:', bySector);

const today = new Date().toISOString().slice(0, 10);
const lines = chosen.map((c) => `  ['${c.symbol}', '${c.sector}'],`).join('\n');
writeFileSync(
  new URL('../src/lib/universe-extended.ts', import.meta.url),
  `/**
 * GENERATED by scripts/build-universe.mjs on ${today} — do not edit by hand;
 * re-run the script instead (see its header for method and sources).
 *
 * ${chosen.length} optionable names beyond the curated core, ordered by total
 * open interest (most first), each with ≥ ${MIN_OI.toLocaleString('en-US')} contracts of OI when measured
 * (smallest kept: ${floorOi.toLocaleString('en-US')}). Sectors are mapped from Nasdaq industry
 * text and are approximate; leveraged/inverse ETFs are excluded.
 */
import type { Sector } from '@/types';

export const EXTENDED_UNIVERSE: readonly (readonly [string, Sector])[] = [
${lines}
];
`,
);
console.log('wrote src/lib/universe-extended.ts');
