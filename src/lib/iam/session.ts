import { NextResponse } from 'next/server';
import { isIP } from 'node:net';
import { withoutActor } from '../db';
import { SESSION_COOKIE, cookieSecure } from './config';
import { hmac, newToken, safeEqual, sha256 } from './crypto';

export interface SessionInfo {
  sessionId: string; userId: string; username: string; fullName: string; email: string | null;
  dbRole: string; authMethod: string; mfaSatisfiedAt: Date | null; mfaMethod: string | null;
  reauthAt: Date | null; startedAt: Date; expiresAt: Date; mustChangePassword: boolean; mfaEnrolled: boolean;
}

export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.get('cookie');
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
}

export async function resolveSession(req: Request): Promise<SessionInfo | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || token.length < 20 || token.length > 100) return null;
  const r = await withoutActor((c) => c.query('SELECT * FROM iam.resolve_session($1)', [sha256(token)]));
  const s = r.rows[0];
  if (!s) return null;
  return { sessionId: s.session_id, userId: s.user_id, username: s.username, fullName: s.full_name, email: s.email,
    dbRole: s.role_code, authMethod: s.auth_method, mfaSatisfiedAt: s.mfa_satisfied_at, mfaMethod: s.mfa_method,
    reauthAt: s.reauth_at, startedAt: s.started_at, expiresAt: s.expires_at, mustChangePassword: !!s.must_change_password, mfaEnrolled: !!s.mfa_enrolled };
}

/** How a session was established (lms.login_session.auth_method). */
export type LoginMethod = 'local' | 'ldap' | 'oidc' | 'saml' | 'passkey' | 'break_glass';

export async function createSession(p: { userId: string; method: LoginMethod; providerId?: string | null;
  ip: string | null; ua: string | null; mfaMethod?: string | null }): Promise<{ token: string; sessionId: string }> {
  const token = newToken(32);
  const r = await withoutActor((c) => c.query('SELECT iam.create_session($1,$2,$3,$4,$5,$6,$7) AS id',
    [p.userId, sha256(token), p.method, p.providerId ?? null, p.ip, p.ua, p.mfaMethod ?? null]));
  return { token, sessionId: r.rows[0].id };
}

export function setSessionCookie(res: NextResponse, token: string, maxAgeSeconds: number) {
  res.cookies.set(SESSION_COOKIE, token, { httpOnly: true, secure: cookieSecure, sameSite: 'lax', path: '/', maxAge: maxAgeSeconds });
}
export function clearSessionCookie(res: NextResponse) {
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, secure: cookieSecure, sameSite: 'lax', path: '/', maxAge: 0 });
}

/** Per-session CSRF token. Stateless: an HMAC of the session id, so it cannot
 * be forged without the server key and dies with the session. */
export const csrfFor = (sessionId: string) => hmac('csrf', sessionId).toString('base64url');
export const csrfValid = (sessionId: string, presented: string | null) => !!presented && safeEqual(csrfFor(sessionId), presented);

// ---- client address --------------------------------------------------------
// A route handler never sees the socket. Next.js 15 (base-server.js,
// handleRequestImpl) records it only as `x-forwarded-for ??= socket.remoteAddress`:
// it fills the header when the request has none and otherwise passes the
// client's own value through untouched. So:
//   TRUST_PROXY_HOPS=0 (default, no proxy): the one address Next wrote is used.
//     A list can only have come from the client and is ignored. (A client that
//     talks to `next start` directly can still send a single forged value — Next
//     gives no way to tell — so production belongs behind a proxy, below.)
//   TRUST_PROXY_HOPS=N: N reverse proxies, each appending the address it was
//     connected from. The client is N entries from the right; everything
//     further left was written by the client and is ignored.
let hopsCache: number | undefined;
export function trustedProxyHops(): number {
  if (hopsCache !== undefined) return hopsCache;
  const raw = process.env.TRUST_PROXY_HOPS?.trim();
  let n = 0;
  if (raw) {
    if (/^\d{1,2}$/.test(raw)) n = Number(raw);
    else console.error('[SECURITY] TRUST_PROXY_HOPS must be the number of trusted reverse proxies (0-99); treating it as 0');
  } else if (process.env.IAM_TRUST_PROXY === 'true') {
    console.warn('[SECURITY] IAM_TRUST_PROXY is replaced by TRUST_PROXY_HOPS; treating it as TRUST_PROXY_HOPS=1');
    n = 1;
  }
  return (hopsCache = n);
}

/** One address in canonical form (no port, brackets or zone; IPv4-mapped
 * IPv6 as IPv4, so one client has one rate-limit key), or null if invalid. */
export function normalizeIp(raw: string | null | undefined): string | null {
  let s = (raw ?? '').trim();
  if (!s || s.length > 64) return null;
  const bracketed = /^\[([0-9a-fA-F:.]+)(?:%[\w.-]+)?\](?::\d{1,5})?$/.exec(s);
  if (bracketed) s = bracketed[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(s)) s = s.slice(0, s.lastIndexOf(':'));
  const zone = s.indexOf('%');
  if (zone > 0) s = s.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (mapped) s = mapped[1];
  return isIP(s) ? s.toLowerCase() : null;
}

/** The client address per the trust model above, or null when unknown. */
export function clientIpFrom(xForwardedFor: string | null | undefined, hops = trustedProxyHops()): string | null {
  const chain = (xForwardedFor ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!chain.length) return null;
  if (hops === 0) return chain.length === 1 ? normalizeIp(chain[0]) : null;
  // Only the right-most `hops` entries were written by trusted proxies; however
  // long the client-written prefix is, it cannot move the answer.
  return normalizeIp(chain[Math.max(0, chain.length - hops)]);
}

export const clientIp = (req: Request): string | null => clientIpFrom(req.headers.get('x-forwarded-for'));
export const userAgent = (req: Request) => req.headers.get('user-agent');
/** Address and user agent, for every authentication event. */
export const requestNet = (req: Request) => ({ ip: clientIp(req), ua: userAgent(req) });
