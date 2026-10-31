import { protect, json, readJson, str } from '@/lib/iam/http';
import { verifyPassword } from '@/lib/iam/password';
import { checkTotp } from '@/lib/iam/mfa';
import { logEvent } from '@/lib/iam/login';

// Fresh proof of identity before a sensitive change. Accepts the password or,
// for an account with an authenticator, a current code. It is a guessable
// check like sign-in, so it shares the account lockout: failures count
// towards it and nothing is checked while the account is locked.
export const POST = protect({ authenticatedOnly: true }, async (ctx) => {
  const b = await readJson(ctx.req, 2048);
  const log = (outcome: string, meta: object) => logEvent('reauth', outcome, { userId: ctx.user.id, username: ctx.user.username,
    session: ctx.session.sessionId, corr: ctx.correlationId, req: ctx.req, meta });
  const via = typeof b.code === 'string' ? 'totp' : 'password';
  // One check at a time per account (the same lock as the MFA sign-in step).
  await ctx.client.query(`SELECT pg_advisory_xact_lock(hashtextextended('iam.mfa_login:' || $1::text, 0))`, [ctx.user.id]);
  const sec = (await ctx.client.query('SELECT locked_until FROM iam.account_security WHERE user_id = $1', [ctx.user.id])).rows[0];
  if (sec?.locked_until && new Date(sec.locked_until) > new Date()) {
    await log('locked_out', { method: via });
    return json({ error: 'Too many failed attempts. Try again in a few minutes.', code: 'locked', correlationId: ctx.correlationId }, 429);
  }
  let ok = false;
  if (via === 'totp') ok = await checkTotp(ctx.client, ctx.user.id, String(b.code).trim(), { requireConfirmed: true });
  else {
    const row = (await ctx.client.query('SELECT password_hash FROM lms.app_user WHERE id = $1', [ctx.user.id])).rows[0];
    ok = (await verifyPassword(row?.password_hash ?? null, str(b, 'password', { max: 1024 }))).ok;
  }
  if (!ok) {
    await ctx.client.query('SELECT iam.note_auth_failure($1)', [ctx.user.id]);
    await log('failure', { method: via });
    return json({ error: 'That did not match.', code: 'invalid', correlationId: ctx.correlationId }, 401);
  }
  await ctx.client.query('SELECT iam.mark_session_reauth($1)', [ctx.session.sessionId]);
  await log('success', { method: via });
  return json({ ok: true });
});
