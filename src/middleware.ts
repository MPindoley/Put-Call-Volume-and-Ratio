/**
 * Site lock (session.ts): with SITE_PASSWORD set, every page and API route
 * needs a valid session cookie. Pages redirect to /login; API calls get 401.
 * The live socket is checked separately (websocket.ts), since socket.io
 * answers its own path before Next sees the request.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { isPublicPath, SESSION_COOKIE, sessionSecret, siteLocked, verifySession } from '@/lib/session';

export async function middleware(req: NextRequest): Promise<NextResponse> {
  if (!siteLocked() || isPublicPath(req.nextUrl.pathname)) return NextResponse.next();
  const secret = sessionSecret();
  if (secret && (await verifySession(req.cookies.get(SESSION_COOKIE)?.value, secret))) return NextResponse.next();

  if (req.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'locked' }, { status: 401 });
  }
  const login = req.nextUrl.clone();
  login.pathname = '/login';
  login.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
