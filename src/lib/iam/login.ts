import { NextResponse, after } from 'next/server';
import { randomUUID } from 'node:crypto';
import { withActor, withoutActor } from '../db';
import { json } from './http';
import { newToken, sha256 } from './crypto';
import { burnTime, hashPassword, verifyPassword } from './password';
import { mfaRequiredFor } from './mfa';
import { clientIp, createSession, csrfFor, setSessionCookie, userAgent, type LoginMethod } from './session';
import { loginAlertsOn, loginContext, sendLoginAlert } from './loginAlert';

export const num = async (key: string, d: number) =>
  Number((await withoutActor((c) => c.query('SELECT iam.setting_num($1,$2) AS n', [key, d]))).rows[0].n);
export const txt = async (key: string, d: string) =>
  (await withoutActor((c) => c.query('SELECT iam.setting_txt($1,$2) AS t', [key, d]))).rows[0].t as string;

/** Writes one row to the authentication log. Pass `req` (or ip/ua) so the
 * source address is recorded: every authentication event carries it. */
export async function logEvent(type: string, outcome: string, o: { userId?: string | null; username?: string | null; actor?: string | null;
  target?: string | null; provider?: string | null; ip?: string | null; ua?: string | null; session?: string | null; corr?: string | null;
  meta?: object; req?: Request } = {}) {
  const ip = o.ip !== undefined ? o.ip : o.req ? clientIp(o.req) : null;
  const ua = o.ua !== undefined ? o.ua : o.req ? userAgent(o.req) : null;
  await withoutActor((c) => c.query('SELECT iam.log_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [type, outcome, o.userId ?? null, o.username ?? null, o.actor ?? null, o.target ?? null, o.provider ?? null,
     ip, ua, o.session ?? null, o.corr ?? null, JSON.stringify(o.meta ?? {})]));
}

export const GENERIC_LOGIN_ERROR = 'Invalid credentials, or the account is unavailable.';
const GENERIC = GENERIC_LOGIN_ERROR;

/** MFA policy for one account, read as that account. `required` comes from
 * iam.mfa_required_for (sensitive permissions count, not only role codes);
 * `roles` (its active roles) is informational. Used after every first factor:
 * local, directory and external sign-ins alike. */
export async function mfaPolicy(userId: string): Promise<{ required: boolean; roles: string[] }> {
  return withActor(userId, async (c) => {
    const roles = (await c.query(`SELECT r.code FROM iam.user_role ur JOIN iam.role r ON r.id = ur.role_id
      WHERE ur.user_id = $1 AND ur.revoked_at IS NULL AND (ur.expires_at IS NULL OR ur.expires_at > now()) AND r.status = 'active'`,
      [userId])).rows.map((r) => r.code as string);
    return { roles, required: await mfaRequiredFor(c, userId) };
  });
}

export type { LoginMethod };
export const LOGIN_METHODS: readonly LoginMethod[] = ['local', 'ldap', 'oidc', 'saml', 'passkey', 'break_glass'];
export const MFA_CHALLENGE_SECONDS = 300;

/** The second factors an account can use at the MFA step. Read as that
 * account (its own rows only). */
export async function secondFactors(userId: string): Promise<('totp' | 'recovery' | 'passkey')[]> {
  const r = (await withActor(userId, (c) => c.query(
    `SELECT EXISTS (SELECT 1 FROM iam.mfa_totp WHERE user_id = $1 AND confirmed_at IS NOT NULL) AS totp,
            EXISTS (SELECT 1 FROM iam.mfa_webauthn WHERE user_id = $1) AS passkey`, [userId]))).rows[0];
  return [...(r.totp ? ['totp', 'recovery'] as const : []), ...(r.passkey ? ['passkey'] as const : [])];
}

/** First factor passed: issue the single-use, five-attempt MFA challenge.
 * Only iam.challenge_issue touches the challenge table. */
export async function startMfaChallenge(p: { userId: string; username: string; method: LoginMethod; providerId?: string | null; corr: string }): Promise<NextResponse> {
  const token = newToken(32);
  await withoutActor((c) => c.query('SELECT iam.challenge_issue($1,$2,$3,$4,$5)', [sha256(token), 'mfa_login', p.userId,
    JSON.stringify({ method: p.method, username: p.username, providerId: p.providerId ?? null }), MFA_CHALLENGE_SECONDS]));
  return json({ ok: true, mfaRequired: true, challenge: token, methods: await secondFactors(p.userId), correlationId: p.corr });
}

export async function finishLogin(req: Request, p: { userId: string; username: string; method: LoginMethod;
  providerId?: string | null; mfaMethod?: string | null; enrollmentRequired?: boolean; mustChange?: boolean; corr: string }): Promise<NextResponse> {
  const ip = clientIp(req), ua = userAgent(req);
  const { token, sessionId } = await createSession({ userId: p.userId, method: p.method, providerId: p.providerId, ip, ua, mfaMethod: p.mfaMethod });
  await withoutActor((c) => c.query('SELECT iam.note_auth_success($1)', [p.userId]));
  await logEvent('login', 'success', { userId: p.userId, username: p.username, ip, ua, session: sessionId, corr: p.corr, provider: p.providerId,
    meta: { method: p.method, mfa: p.mfaMethod ?? 'none' } });
  if (p.method === 'break_glass') {
    await logEvent('emergency_access', 'info', { userId: p.userId, username: p.username, ip, ua, session: sessionId, corr: p.corr });
    console.warn(`[SECURITY] emergency-access sign-in by ${p.username} (correlation ${p.corr})`);
  }
  if (loginAlertsOn()) {
    // Sign-in alert e-mail (LOGIN_ALERT_TO), sent after the answer so it never delays a sign-in.
    const ctx = loginContext(req, { userId: p.userId, username: p.username, method: p.method, mfaMethod: p.mfaMethod ?? null,
      providerId: p.providerId ?? null, sessionId, corr: p.corr }, { ip, ua });
    const job = () => sendLoginAlert(ctx);
    try { after(job); } catch { void job(); }
  }
  const absolute = await num('iam.session_absolute_hours', 12);
  const res = json({ ok: true, csrfToken: csrfFor(sessionId), mfaEnrollmentRequired: !!p.enrollmentRequired, mustChangePassword: !!p.mustChange });
  setSessionCookie(res, token, absolute * 3600);
  return res;
}

export async function attemptLogin(req: Request, usernameRaw: string, password: string): Promise<NextResponse> {
  const corr = randomUUID(), ip = clientIp(req), ua = userAgent(req);
  const username = usernameRaw.trim().toLowerCase().slice(0, 64);
  if (!username || !password || password.length > 1024) { await burnTime(password || ''); return json({ error: GENERIC, code: 'invalid', correlationId: corr }, 401); }

  const win = await num('iam.rate_limit_window_minutes', 15);
  const f = (await withoutActor((c) => c.query('SELECT * FROM iam.failure_counts($1,$2,$3)', [username, ip, win]))).rows[0];
  if (Number(f.by_user) >= (await num('iam.rate_limit_per_user', 10)) || (ip && Number(f.by_ip) >= (await num('iam.rate_limit_per_ip', 30)))) {
    await burnTime(password);
    await logEvent('login', 'denied', { username, ip, ua, corr, meta: { reason: 'rate_limited' } });
    return json({ error: 'Too many attempts. Try again later.', code: 'rate_limited', correlationId: corr }, 429, { 'Retry-After': String(win * 60) });
  }

  const u = (await withoutActor((c) => c.query('SELECT * FROM iam.authn_lookup($1)', [username]))).rows[0];
  const localOn = (await txt('iam.local_login_enabled', 'true')) === 'true';
  const fail = async (outcome: string, userId?: string) => {
    await logEvent('login', outcome, { userId, username, ip, ua, corr });
    return json({ error: GENERIC, code: 'invalid', correlationId: corr }, 401);
  };

  if (!u || u.is_service_account) { await burnTime(password); return fail('unknown_user'); }
  if (u.status !== 'Active') { await burnTime(password); return fail('suspended', u.user_id); }
  if (!localOn && !u.is_break_glass) { await burnTime(password); return fail('denied', u.user_id); }
  if (u.locked_until && new Date(u.locked_until) > new Date()) { await burnTime(password); return fail('locked_out', u.user_id); }

  const v = await verifyPassword(u.password_hash, password);
  if (!v.ok) {
    const locked = await withoutActor((c) => c.query('SELECT iam.note_auth_failure($1) AS l', [u.user_id])).then((r) => r.rows[0].l);
    return fail(locked ? 'locked_out' : 'bad_password', u.user_id);
  }
  if (v.needsRehash) {
    const nh = await hashPassword(password);
    await withoutActor((c) => c.query('SELECT iam.rehash_password($1,$2,$3)', [u.user_id, u.password_hash, nh]));
  }

  const method: LoginMethod = u.is_break_glass ? 'break_glass' : 'local';
  if (u.mfa_enrolled) return startMfaChallenge({ userId: u.user_id, username, method, corr });
  const pol = await mfaPolicy(u.user_id);
  return finishLogin(req, { userId: u.user_id, username, method, enrollmentRequired: pol.required || method === 'break_glass',
    mustChange: !!u.must_change_password, corr });
}
