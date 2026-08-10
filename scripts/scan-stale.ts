/* Audit: which universe symbols is CBOE serving a FROZEN snapshot for?
 * CBOE returns a plausible price forever after a name stops trading, so the
 * payload's own `timestamp` is the only reliable liveness signal.
 * Paced + retried: an unpaced sweep gets throttled and every failure then
 * looks like staleness, which would condemn perfectly live tickers. */
import { TRACKED_UNIVERSE } from '../src/lib/universe';

const BASE = 'https://cdn.cboe.com/api/global/delayed_quotes/quotes';
const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Row { sym: string; ageDays: number | null; px: number; vol: number }

async function one(sym: string, tries = 3): Promise<Row> {
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(`${BASE}/${encodeURIComponent(sym)}.json`, { cache: 'no-store' });
      if (r.status === 404) return { sym, ageDays: Infinity, px: 0, vol: 0 };
      if (!r.ok) { await sleep(400 * (t + 1)); continue; }
      const j: any = await r.json();
      const stamp = Date.parse(String(j.timestamp ?? '').replace(' ', 'T') + 'Z');
      if (!Number.isFinite(stamp)) { await sleep(400 * (t + 1)); continue; }
      return { sym, ageDays: (Date.now() - stamp) / DAY, px: j.data?.current_price ?? 0, vol: j.data?.volume ?? 0 };
    } catch { await sleep(400 * (t + 1)); }
  }
  return { sym, ageDays: null, px: 0, vol: 0 }; // null = could not determine
}

async function main(): Promise<void> {
  const syms = TRACKED_UNIVERSE.map((u) => u.symbol);
  const rows: Row[] = [];
  for (let i = 0; i < syms.length; i += 4) {
    rows.push(...(await Promise.all(syms.slice(i, i + 4).map((s) => one(s)))));
    await sleep(120);
  }
  const unknown = rows.filter((r) => r.ageDays === null);
  const stale = rows.filter((r) => r.ageDays !== null && r.ageDays > 3).sort((a, b) => b.ageDays! - a.ageDays!);
  const fresh = rows.filter((r) => r.ageDays !== null && r.ageDays <= 3);
  console.log(`scanned=${rows.length}  fresh=${fresh.length}  stale=${stale.length}  undetermined=${unknown.length}`);
  if (unknown.length) console.log('UNDETERMINED (excluded from any action):', unknown.map((u) => u.sym).join(','));
  console.log('\nFROZEN:');
  for (const s of stale) console.log(`  ${s.sym.padEnd(6)} ${(s.ageDays === Infinity ? '404' : s.ageDays!.toFixed(0)).padStart(6)}d  px=${s.px}  vol=${s.vol}`);
  console.log('\nLIST:', stale.map((s) => s.sym).join(','));
}
void main();
