import { NextResponse } from 'next/server';
import { getFlowEngine } from '@/lib/flow-engine';

export const dynamic = 'force-dynamic';

/**
 * Liveness probe — platform healthchecks (Railway et al.) point here.
 *
 * This answers "is the process serving HTTP?", NOT "is the data fresh?". The
 * two diverge at boot (no poll has completed yet) and whenever the market is
 * closed (the poller idles by design), so gating a deploy on freshness makes a
 * night, weekend or holiday release impossible to bring up.
 *
 * 503 is therefore reserved for a genuine fault: the poller has gone stale
 * while the market is open. `healthy` keeps its freshness meaning in the body
 * for monitoring; `state` explains which case applies.
 */
export function GET(): NextResponse {
  const status = getFlowEngine().status();
  const state = !status.marketOpen
    ? 'idle' // closed session: idle is correct, not a failure
    : status.lastPollAt === 0
      ? 'starting' // open, but the first cycle has not landed yet
      : status.healthy
        ? 'ok'
        : 'stale'; // open and the poller stopped producing — a real fault
  return NextResponse.json({ ...status, state }, { status: state === 'stale' ? 503 : 200 });
}
