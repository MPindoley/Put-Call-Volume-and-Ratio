import { NextResponse } from 'next/server';
import { getFlowEngine } from '@/lib/flow-engine';
import { loadClockReport, type ClockReport } from '@/lib/intraday-jobs';
import { loadSpikeReport, type SpikeReport } from '@/lib/spike-outcome-jobs';
import { TRACKED_UNIVERSE } from '@/lib/universe';

export const dynamic = 'force-dynamic';

interface Params {
  params: { symbol: string };
}

export interface IntradayResponse {
  clock: ClockReport;
  spikes: SpikeReport;
}

/**
 * Time-of-day learning for one name: its daily clock beside what it traded on
 * its latest session, and what has followed its (and its sector's) spike alerts.
 */
export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
  const symbol = params.symbol.toUpperCase();
  if (!TRACKED_UNIVERSE.some((u) => u.symbol === symbol)) {
    return NextResponse.json({ error: `unknown or untracked ticker: ${symbol}` }, { status: 404 });
  }
  const engine = getFlowEngine();
  const [clock, spikes] = await Promise.all([loadClockReport(engine, symbol), loadSpikeReport(engine, symbol)]);
  const body: IntradayResponse = { clock, spikes };
  return NextResponse.json(body);
}
