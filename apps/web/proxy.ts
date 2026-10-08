import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC = [/^\/login$/, /^\/forgot-password$/, /^\/invite\//, /^\/reset-password\//, /^\/r\//];

/**
 * Fast redirect for signed-out browsers. This only checks that a session cookie exists;
 * the API validates the session on every request and the app shell handles 401s.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC.some((re) => re.test(pathname))) return NextResponse.next();
  if (!request.cookies.get('ph_session')) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api/|git/|_next/|favicon.ico|icon.svg|.*\\.(?:png|svg|jpg|ico|webp|woff2?)$).*)'],
};
