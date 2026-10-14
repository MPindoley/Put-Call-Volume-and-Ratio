import { NextResponse } from 'next/server';
import { authorizeUrl, newOAuthState, schwabConfig, STATE_COOKIE } from '@/lib/schwab-auth';
import { siteLocked } from '@/lib/session';
import { backToSources } from '../redirect';

export const dynamic = 'force-dynamic';

/** Start the Schwab sign-in (schwab-auth.ts). */
export function GET(): NextResponse {
  const cfg = schwabConfig();
  if (!cfg) return backToSources('unconfigured');
  // The data is licensed to the account holder: never connect an open site.
  if (!siteLocked()) return backToSources('unlocked');
  const state = newOAuthState();
  const res = NextResponse.redirect(authorizeUrl(cfg, state), 303);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // Lax: sent on Schwab's top-level redirect back to the callback.
    sameSite: 'lax',
    path: '/api/schwab',
    maxAge: 600,
  });
  return res;
}
