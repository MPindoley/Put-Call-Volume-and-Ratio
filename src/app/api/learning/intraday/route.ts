import { NextResponse } from 'next/server';
import { getFlowEngine } from '@/lib/flow-engine';
import { clockSummary, type ClockSummary } from '@/lib/intraday-jobs';
import { loadSpikeSummary, type SpikeSummary } from '@/lib/spike-outcome-jobs';

export const dynamic = 'force-dynamic';

export interface IntradayLearningResponse {
  clock: ClockSummary;
  spikes: SpikeSummary;
}

/** Time-of-day learning across all names: the daily clocks and spike follow-through. */
export async function GET(): Promise<NextResponse> {
  const engine = getFlowEngine();
  const body: IntradayLearningResponse = { clock: clockSummary(engine), spikes: await loadSpikeSummary(engine) };
  return NextResponse.json(body);
}
