import { getFlowEngine } from '@/lib/flow-engine';

export const dynamic = 'force-dynamic';

/**
 * CSV export of the current flow table for external analysis. The *_5m columns
 * are per-5-minute rates measured over flow_window_min minutes of data ending
 * at data_as_of (the market time the chain reflects; last_updated is the fetch).
 */
export function GET(): Response {
  const rows = getFlowEngine().allFlows();
  const header =
    'symbol,sector,put_call_ratio,put_volume_5m,call_volume_5m,net_flow,session_put_volume,session_call_volume,put_premium,call_premium,spike_level,spike_score,volume_vs_expected,iv30,iv_rank,hv20,rr_skew_25d,oi_put_call,oi_change_pct,implied_move_pct,max_pain,underlying_price,last_updated,data_as_of,flow_window_min';
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
      r.iv30 ?? '',
      r.ivRank ?? '',
      r.hv20 ?? '',
      r.analytics?.rrSkew25 ?? '',
      r.analytics?.oiPutCall ?? '',
      r.oiChangePct ?? '',
      r.analytics?.impliedMovePct ?? '',
      r.analytics?.maxPain ?? '',
      r.underlyingPrice.toFixed(2),
      new Date(r.lastUpdated).toISOString(),
      r.dataAsOf > 0 ? new Date(r.dataAsOf).toISOString() : '',
      r.flowWindowMs !== null ? (r.flowWindowMs / 60_000).toFixed(1) : '',
    ].join(','),
  );
  return new Response([header, ...lines].join('\n'), {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="options-flow-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
