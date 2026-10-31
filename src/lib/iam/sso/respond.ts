import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { appOrigin } from '../config';
import {
  ACCOUNT_UNAVAILABLE_MESSAGE, PENDING_APPROVAL_MESSAGE, SIGNIN_FAILED_MESSAGE, SIGNIN_UNAVAILABLE_MESSAGE,
} from '../signin-methods';
import { describeError } from './providers';

// What the browser sees at the end of an external sign-in that did not end in
// a session: one plain, branded page with the reason in words — never a stack
// trace, a provider error or a configuration detail. The correlation id lets
// support find the technical reason in the security log.

export type Outcome = 'pending' | 'unavailable' | 'failed' | 'inactive' | 'busy';
const COPY: Record<Outcome, { title: string; message: string; code: string }> = {
  pending: { title: 'Access requested', message: PENDING_APPROVAL_MESSAGE, code: 'pending_approval' },
  unavailable: { title: 'Sign-in unavailable', message: SIGNIN_UNAVAILABLE_MESSAGE, code: 'signin_unavailable' },
  failed: { title: 'Sign-in not completed', message: SIGNIN_FAILED_MESSAGE, code: 'signin_failed' },
  inactive: { title: 'Account unavailable', message: ACCOUNT_UNAVAILABLE_MESSAGE, code: 'account_unavailable' },
  busy: { title: 'Please wait', message: 'Too many sign-in attempts are in progress. Please wait a moment and try again.', code: 'rate_limited' },
};
const STATUS: Record<Outcome, number> = { pending: 403, unavailable: 503, failed: 400, inactive: 403, busy: 429 };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** A JSON client asked explicitly; a browser navigation gets the page. */
export function wantsJson(req: Request): boolean {
  const a = req.headers.get('accept') ?? '';
  return a.includes('application/json') && !a.includes('text/html');
}

const PAGE_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function outcomePage(req: Request, outcome: Outcome, corr: string, status = STATUS[outcome]): NextResponse {
  const c = COPY[outcome];
  if (wantsJson(req)) {
    return NextResponse.json({ error: c.message, code: c.code, correlationId: corr },
      { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(c.title)} · Mari Energies LMS</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;
       background:#0f2a43;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1d2733}
  main{background:#fff;border-radius:12px;max-width:440px;width:100%;padding:28px 24px;box-shadow:0 12px 32px rgba(0,0,0,.25);text-align:center}
  img{height:48px;width:auto;margin-bottom:12px}
  h1{font-size:1.25rem;margin:.25rem 0 .75rem}
  p{margin:0 0 1rem}
  .ref{font-size:.8rem;color:#5b6773;word-break:break-all}
  a{display:inline-block;margin-top:.5rem;padding:.55rem 1.1rem;border-radius:8px;background:#0b5394;color:#fff;text-decoration:none;font-weight:600}
  a:focus-visible{outline:3px solid #f1c232;outline-offset:2px}
</style></head>
<body><main data-signin-status="${esc(c.code)}">
<img src="/images/mari-energies-logo.png" alt="Mari Energies">
<h1>${esc(c.title)}</h1>
<p role="${outcome === 'pending' ? 'status' : 'alert'}">${esc(c.message)}</p>
<p class="ref">Reference: ${esc(corr)}</p>
<a href="/login">Return to sign-in</a>
</main></body></html>`;
  return new NextResponse(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
               'Content-Security-Policy': PAGE_CSP, 'Referrer-Policy': 'no-referrer', ...(outcome === 'busy' ? { 'Retry-After': '10' } : {}) },
  });
}

/** 303 to a path of this application (or an absolute IdP URL), carrying any
 * cookies another response set (the session cookie from finishLogin). */
export function redirectTo(target: string, carry?: Response): NextResponse {
  const to = /^https?:\/\//i.test(target) ? target : new URL(target, appOrigin()).toString();
  const res = NextResponse.redirect(to, 303);
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('Referrer-Policy', 'no-referrer');
  // Carry them through res.cookies, not as raw headers: a later res.cookies.set()
  // (clearBinding) rewrites every set-cookie header from that store and would
  // silently drop a raw one, so the session cookie never reached the browser.
  if (carry instanceof NextResponse) for (const c of carry.cookies.getAll()) res.cookies.set(c);
  else for (const c of carry?.headers.getSetCookie() ?? []) res.headers.append('set-cookie', c);
  return res;
}

/** Route wrapper for the sign-in endpoints: any unexpected error becomes the
 * generic page with a correlation id; the detail goes to the server log. */
export function ssoRoute(handler: (req: Request, corr: string, params: Record<string, string>) => Promise<Response>) {
  return async (req: Request, ctx: { params: Promise<any> }) => {
    const corr = randomUUID();
    try {
      const params = ctx?.params ? await ctx.params : {};
      return await handler(req, corr, typeof params === 'object' && params ? params : {});
    } catch (e) {
      console.error(`[${corr}] external sign-in error:`, describeError(e));
      return outcomePage(req, 'failed', corr, 500);
    }
  };
}
