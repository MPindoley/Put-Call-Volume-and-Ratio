import { NextResponse } from 'next/server';
import { getFlowEngine } from '@/lib/flow-engine';

export const dynamic = 'force-dynamic';

/**
 * Session leaders, computed from live in-memory state (works without a DB):
 * most unusual, biggest premium, and strongest directional net flow.
 */
export function GET(): NextResponse {
  const engine = getFlowEngine();
  const rows = engine.allFlows().filter((r) => r.lastUpdated > 0);

  const pick = (list: typeof rows, n = 8): { symbol: string; value: number; ratio: number; level: string }[] =>
    list.slice(0, n).map((r) => ({
      symbol: r.symbol,
      value: 0,
      ratio: Number(r.putCallRatio.toFixed(2)),
      level: r.spikeLevel,
    }));

  const topUnusual = [...rows].sort((a, b) => b.spikeScore - a.spikeScore);
  const topPremium = [...rows].sort(
    (a, b) => b.putPremium + b.callPremium - (a.putPremium + a.callPremium),
  );
  const topBullish = [...rows].sort((a, b) => b.netFlow - a.netFlow);
  const topBearish = [...rows].sort((a, b) => a.netFlow - b.netFlow);

  return NextResponse.json({
    asOf: Date.now(),
    alertsToday: engine.getAlerts(200).filter((a) => a.createdAt > Date.now() - 86_400_000).length,
    topUnusual: pick(topUnusual).map((e, i) => ({ ...e, value: topUnusual[i]?.spikeScore ?? 0 })),
    topPremium: pick(topPremium).map((e, i) => ({
      ...e,
      value: Math.round((topPremium[i]?.putPremium ?? 0) + (topPremium[i]?.callPremium ?? 0)),
    })),
    topBullish: pick(topBullish, 5).map((e, i) => ({ ...e, value: topBullish[i]?.netFlow ?? 0 })),
    topBearish: pick(topBearish, 5).map((e, i) => ({ ...e, value: topBearish[i]?.netFlow ?? 0 })),
  });
}
