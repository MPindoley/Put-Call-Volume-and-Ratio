import { NextResponse } from 'next/server';
import { tryDb } from '@/lib/db';
import { getFlowEngine } from '@/lib/flow-engine';
import { loadCoverageRows, summarizeCoverage, type StockCoverage } from '@/lib/learning-coverage';

export const dynamic = 'force-dynamic';

const TTL_MS = 10 * 60_000;
let cache: { at: number; data: Awaited<ReturnType<typeof loadCoverageRows>> } | null = null;

/**
 * Is every stock's data reaching every stage of the learning? The summary
 * (stage counts + stocks needing attention), or one stock's row with
 * ?symbol=AAPL. Grouped queries over the whole database, cached 10 minutes.
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const data = await tryDb('learning coverage', (db) => loadCoverageRows(db, getFlowEngine()));
    if (!data) return NextResponse.json({ error: 'database unavailable' }, { status: 503 });
    cache = { at: Date.now(), data };
  }
  const { rows, sessions, latest, thresholds } = cache.data;
  const symbol = new URL(req.url).searchParams.get('symbol')?.trim().toUpperCase();
  if (symbol) {
    const row: StockCoverage | undefined = rows.find((r) => r.symbol === symbol);
    if (!row) return NextResponse.json({ error: `${symbol} is not in the tracked universe` }, { status: 404 });
    return NextResponse.json({ ...row, thresholds, sessions });
  }
  return NextResponse.json(summarizeCoverage(rows, sessions, latest, thresholds));
}
