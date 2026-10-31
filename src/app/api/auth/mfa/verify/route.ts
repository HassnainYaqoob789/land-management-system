import { publicRoute } from '@/lib/iam/public';
import { json, readJson, str } from '@/lib/iam/http';
import { withActor, withoutActor } from '@/lib/db';
import { sha256 } from '@/lib/iam/crypto';
import { checkTotp, useRecoveryCode } from '@/lib/iam/mfa';
import { LOGIN_METHODS, finishLogin, logEvent, type LoginMethod } from '@/lib/iam/login';
import { requestNet } from '@/lib/iam/session';

type Outcome = { kind: 'ok'; remaining: number } | { kind: 'bad'; left: number } | { kind: 'locked' } | { kind: 'expired' };
const STALE = Symbol('stale');
const isLocked = (u: { locked_until?: string | Date | null } | undefined) => !!u?.locked_until && new Date(u.locked_until) > new Date();

// Second step of sign-in. The challenge proves the first factor passed in the
// last five minutes; it is single-use and allows five attempts in total. The
// challenge table is reached only through the iam.challenge_* routines.
export const POST = publicRoute(async (req, corr) => {
  const b = await readJson(req, 4096);
  const token = str(b, 'challenge', { max: 100 }), code = str(b, 'code', { max: 40 }).trim();
  const method = b.method === 'recovery' ? 'recovery' : 'totp';
  const { ip, ua } = requestNet(req);
  const h = sha256(token);
  const expired = () => json({ error: 'This sign-in has expired. Start again.', code: 'challenge_expired', correlationId: corr }, 401);

  // No actor exists yet: find whose challenge this is (live ones only).
  const ch = (await withoutActor((c) => c.query('SELECT id, user_id, data FROM iam.challenge_find($1,$2)', [h, 'mfa_login']))).rows[0];
  if (!ch?.user_id) return expired();
  const username: string = typeof ch.data?.username === 'string' ? ch.data.username : '';
  const loginMethod: LoginMethod = LOGIN_METHODS.includes(ch.data?.method) ? ch.data.method : 'local';
  const providerId: string | null = typeof ch.data?.providerId === 'string' ? ch.data.providerId : null;

  // The account must still be able to sign in before any code is looked at:
  // a locked, suspended or renamed account ends the attempt here.
  const u = (await withoutActor((c) => c.query('SELECT * FROM iam.authn_lookup($1)', [username]))).rows[0];
  if (!u || u.user_id !== ch.user_id || u.status !== 'Active' || u.is_service_account || isLocked(u)) {
    await withoutActor((c) => c.query('SELECT iam.challenge_consume($1)', [ch.id]));
    await logEvent('mfa', isLocked(u) ? 'locked_out' : 'denied', { userId: ch.user_id, username, ip, ua, corr, meta: { method } });
    return expired();
  }

  let r: Outcome;
  try {
    r = await withActor(ch.user_id, async (c): Promise<Outcome> => {
      // One second-factor check at a time per account, so concurrent requests
      // cannot all read "attempts < 5" before any of them is counted.
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('iam.mfa_login:' || $1::text, 0))`, [ch.user_id]);
      const live = (await c.query('SELECT id FROM iam.challenge_find($1,$2)', [h, 'mfa_login'])).rows[0];
      if (live?.id !== ch.id) return { kind: 'expired' };
      if (isLocked((await c.query('SELECT locked_until FROM iam.authn_lookup($1)', [username])).rows[0])) {
        await c.query('SELECT iam.challenge_consume($1)', [ch.id]);
        return { kind: 'locked' };
      }
      let ok = false, remaining = -1;
      await c.query('SAVEPOINT mfa_check');
      try {
        if (method === 'totp') ok = await checkTotp(c, ch.user_id, code, { requireConfirmed: true });
        else ({ ok, remaining } = await useRecoveryCode(c, ch.user_id, code));
        await c.query('RELEASE SAVEPOINT mfa_check');
      } catch (e) {
        // A fault while checking counts as a wrong code, never as a pass.
        console.error(`[${corr}] mfa check failed`, (e as Error)?.message);
        await c.query('ROLLBACK TO SAVEPOINT mfa_check');
        ok = false;
      }
      if (!ok) {
        const left = Number((await c.query('SELECT iam.challenge_fail($1) AS n', [ch.id])).rows[0]?.n ?? 0);
        await c.query('SELECT iam.note_auth_failure($1)', [ch.user_id]);
        return { kind: 'bad', left };
      }
      // Single use. If it was no longer live, roll back the code just spent.
      if ((await c.query('SELECT iam.challenge_consume($1) AS ok', [ch.id])).rows[0]?.ok !== true) throw STALE;
      return { kind: 'ok', remaining };
    });
  } catch (e: any) {
    // STALE: the challenge expired while we held it. 28000: set_actor refused
    // (the account was suspended in the meantime). Anything else is a fault.
    if (e !== STALE && e?.code !== '28000') throw e;
    r = { kind: 'expired' };
  }

  if (r.kind === 'expired') return expired();
  if (r.kind === 'locked') {
    await logEvent('mfa', 'locked_out', { userId: ch.user_id, username, ip, ua, corr, meta: { method } });
    return expired();
  }
  if (r.kind === 'bad') {
    await logEvent('mfa', 'mfa_failed', { userId: ch.user_id, username, ip, ua, corr, meta: { method, attempts_left: r.left } });
    return json({ error: 'That code is not valid.', code: 'invalid_code', correlationId: corr }, 401);
  }
  await logEvent('mfa', 'success', { userId: ch.user_id, username, ip, ua, corr, meta: { method, codes_remaining: r.remaining } });
  return finishLogin(req, { userId: ch.user_id, username, method: loginMethod, providerId, mfaMethod: method,
    mustChange: !!u.must_change_password, corr });
});
