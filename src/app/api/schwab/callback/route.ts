import { timingSafeEqual } from 'node:crypto';
import type { NextRequest, NextResponse } from 'next/server';
import { getSchwabAuth, STATE_COOKIE } from '@/lib/schwab-auth';
import { siteLocked } from '@/lib/session';
import { backToSources } from '../redirect';

export const dynamic = 'force-dynamic';

function sameState(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Schwab redirects here after sign-in. The site lock (middleware) already
 * requires the owner's session; the `state` check additionally ties this
 * callback to a sign-in this browser started, so a link someone else crafted
 * cannot attach their Schwab login to this dashboard.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const params = req.nextUrl.searchParams;
  const expected = req.cookies.get(STATE_COOKIE)?.value;
  const finish = (outcome: string): NextResponse => {
    const res = backToSources(outcome);
    res.cookies.set(STATE_COOKIE, '', { path: '/api/schwab', maxAge: 0 });
    return res;
  };

  const auth = getSchwabAuth();
  if (!auth || !siteLocked()) return finish('unconfigured');
  if (params.get('error')) return finish('denied');
  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state || !expected || !sameState(state, expected)) return finish('state');
  try {
    await auth.connect(code);
  } catch (err) {
    console.warn('[schwab] sign-in failed:', err instanceof Error ? err.message : err);
    return finish('failed');
  }
  console.log('[schwab] connected');
  return finish('connected');
}
