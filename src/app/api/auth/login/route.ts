import { randomUUID } from 'node:crypto';
import { publicRoute } from '@/lib/iam/public';
import { json, readJson, str } from '@/lib/iam/http';
import { withoutActor } from '@/lib/db';
import { attemptLogin, finishLogin, logEvent, mfaPolicy, num, startMfaChallenge, GENERIC_LOGIN_ERROR } from '@/lib/iam/login';
import { requestNet } from '@/lib/iam/session';
import { ldapAuthenticate } from '@/lib/iam/sso/ldap';
import { ACCOUNT_UNAVAILABLE_MESSAGE, PENDING_APPROVAL_MESSAGE, SIGNIN_UNAVAILABLE_MESSAGE } from '@/lib/iam/signin-methods';

// Password sign-in: a local account, or — when `provider` names an LDAP
// directory listed by /api/auth/options — the directory account.
export const POST = publicRoute(async (req) => {
  const b = await readJson(req, 4096);
  const username = str(b, 'username', { max: 128 }), password = str(b, 'password', { max: 1024 });
  const provider = str(b, 'provider', { max: 40, optional: true });
  return provider ? directoryLogin(req, provider, username, password) : attemptLogin(req, username, password);
});

async function directoryLogin(req: Request, provider: string, username: string, password: string): Promise<Response> {
  const corr = randomUUID(), { ip, ua } = requestNet(req);
  const login = username.trim();
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(provider)) return json({ error: GENERIC_LOGIN_ERROR, code: 'invalid', correlationId: corr }, 401);

  // The per-address limit is applied here; ldapAuthenticate applies the
  // per-username one before it contacts the directory.
  if (ip) {
    const win = await num('iam.rate_limit_window_minutes', 15);
    const f = (await withoutActor((c) => c.query('SELECT * FROM iam.failure_counts($1,$2,$3)', [login.toLowerCase(), ip, win]))).rows[0];
    if (Number(f.by_ip) >= (await num('iam.rate_limit_per_ip', 30))) {
      await logEvent('login', 'denied', { username: login.slice(0, 64), ip, ua, corr, meta: { method: 'ldap', reason: 'rate_limited' } });
      return json({ error: 'Too many attempts. Try again later.', code: 'rate_limited', correlationId: corr }, 429, { 'Retry-After': String(win * 60) });
    }
  }

  // Pass the address so directory failures are logged with it and count
  // toward the per-address limit above.
  const r = await ldapAuthenticate(provider, login, password, { ip, ua });
  if (!r.ok) {
    if (r.reason === 'unavailable') return json({ error: SIGNIN_UNAVAILABLE_MESSAGE, code: 'provider_unavailable', correlationId: corr }, 503);
    // The directory accepted the password, so saying why is not a disclosure.
    if (r.reason === 'pending_approval') return json({ error: PENDING_APPROVAL_MESSAGE, code: 'pending_approval', correlationId: corr }, 403);
    if (r.reason === 'inactive') return json({ error: ACCOUNT_UNAVAILABLE_MESSAGE, code: 'account_unavailable', correlationId: corr }, 403);
    return json({ error: GENERIC_LOGIN_ERROR, code: 'invalid', correlationId: corr }, 401);
  }

  // The LMS account's own lockout (second-factor failures) still applies.
  const u = (await withoutActor((c) => c.query('SELECT * FROM iam.authn_lookup($1)', [r.username]))).rows[0];
  const locked = !!u?.locked_until && new Date(u.locked_until) > new Date();
  if (!u || u.user_id !== r.userId || u.status !== 'Active' || locked) {
    await logEvent('login', locked ? 'locked_out' : 'denied', { userId: r.userId, username: r.username, provider: r.providerId, ip, ua, corr,
      meta: { method: 'ldap' } });
    return json({ error: GENERIC_LOGIN_ERROR, code: 'invalid', correlationId: corr }, 401);
  }
  if (u.mfa_enrolled) return startMfaChallenge({ userId: r.userId, username: r.username, method: 'ldap', providerId: r.providerId, corr });
  const pol = await mfaPolicy(r.userId);
  return finishLogin(req, { userId: r.userId, username: r.username, method: 'ldap', providerId: r.providerId,
    enrollmentRequired: pol.required, mustChange: false, corr });
}
