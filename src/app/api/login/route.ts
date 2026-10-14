import { NextResponse } from 'next/server';
import { passwordMatches, SESSION_COOKIE, SESSION_MAX_AGE_S, sessionSecret, signSession, siteLocked } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Exchange the site password for a session cookie (session.ts). */
export async function POST(req: Request): Promise<NextResponse> {
  if (!siteLocked()) return NextResponse.json({ ok: true, locked: false });
  const body = (await req.json().catch(() => null)) as { password?: unknown } | null;
  const given = typeof body?.password === 'string' ? body.password : '';
  const ok = await passwordMatches(given, process.env.SITE_PASSWORD ?? '');
  if (!ok) {
    // A small fixed delay makes guessing slow without locking out the owner.
    await new Promise((r) => setTimeout(r, 750));
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await signSession(sessionSecret() as string), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_S,
  });
  return res;
}
