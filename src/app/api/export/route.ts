import { getFlowEngine } from '@/lib/flow-engine';

export const dynamic = 'force-dynamic';

/** CSV export of the current flow table for external analysis. */
export function GET(): Response {
  const rows = getFlowEngine().allFlows();
  const header =
    'symbol,sector,put_call_ratio,put_volume_5m,call_volume_5m,net_flow,session_put_volume,session_call_volume,put_premium,call_premium,spike_level,spike_score,volume_vs_expected,underlying_price,last_updated';
  const lines = rows.map((r) =>
    [
      r.symbol,
      `"${r.sector}"`,
      r.putCallRatio.toFixed(3),
      r.putVolume,
      r.callVolume,
      r.netFlow,
      r.sessionPutVolume,
      r.sessionCallVolume,
      Math.round(r.putPremium),
      Math.round(r.callPremium),
      r.spikeLevel,
      r.spikeScore,
      r.volumeVsExpected.toFixed(2),
      r.underlyingPrice.toFixed(2),
      new Date(r.lastUpdated).toISOString(),
    ].join(','),
  );
  return new Response([header, ...lines].join('\n'), {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="options-flow-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
