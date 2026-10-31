import { NextResponse, type NextRequest } from 'next/server';
import { contentSecurityPolicy } from '@/lib/csp';

// A coarse first gate for PAGES only: no session cookie, no page. It cannot
// validate the session (that needs the database), so it is not the security
// boundary — every API route re-checks through protect(). Its job is to stop
// an anonymous visitor seeing an empty application shell.
const PUBLIC = ['/login', '/forgot-password', '/reset-password', '/accept-invitation'];

/** Let a page through with a per-request nonce and the CSP that names it. */
function page(req: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce, process.env.NODE_ENV !== 'production');
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('Content-Security-Policy', csp);
  return res;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith('/api/') || pathname.startsWith('/_next/') || pathname.startsWith('/images/') ||
      pathname === '/favicon.ico' || pathname === '/theme-init.js') {
    return NextResponse.next();
  }
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(p + '/'))) return page(req);
  const has = req.cookies.get('__Host-lms_session') || req.cookies.get('lms_session');
  if (!has) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }
  return page(req);
}

export const config = { matcher: ['/((?!_next/static|_next/image).*)'] };
