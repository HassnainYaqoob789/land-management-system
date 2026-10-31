import { protect, json, readJson, str, HttpError } from '@/lib/iam/http';
import { checkPasswordPolicy, hashPassword, matchesHistory, verifyPassword } from '@/lib/iam/password';
import { logEvent } from '@/lib/iam/login';

// Change your own password. Needs the current one: a stolen session alone
// cannot set a new password and lock the owner out. Guessing the current one
// counts towards the account lockout, as at sign-in.
export const POST = protect({ authenticatedOnly: true, allowPendingMfa: true, allowMustChange: true }, async (ctx) => {
  const b = await readJson(ctx.req, 4096);
  const current = str(b, 'currentPassword', { max: 1024 }), next = str(b, 'newPassword', { max: 1024 });
  await ctx.client.query(`SELECT pg_advisory_xact_lock(hashtextextended('iam.mfa_login:' || $1::text, 0))`, [ctx.user.id]);
  const sec = (await ctx.client.query('SELECT locked_until FROM iam.account_security WHERE user_id = $1', [ctx.user.id])).rows[0];
  if (sec?.locked_until && new Date(sec.locked_until) > new Date()) {
    await logEvent('password_change', 'locked_out', { userId: ctx.user.id, username: ctx.user.username, corr: ctx.correlationId, req: ctx.req });
    throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.', 'locked');
  }
  const row = (await ctx.client.query('SELECT password_hash FROM lms.app_user WHERE id = $1', [ctx.user.id])).rows[0];
  if (!(await verifyPassword(row?.password_hash ?? null, current)).ok) {
    await ctx.client.query('SELECT iam.note_auth_failure($1)', [ctx.user.id]);
    await logEvent('password_change', 'failure', { userId: ctx.user.id, username: ctx.user.username, corr: ctx.correlationId, req: ctx.req, meta: { reason: 'wrong_current' } });
    // Answered (not thrown) so the transaction commits and the failure counts.
    return json({ error: 'The current password is incorrect.', code: 'bad_current', correlationId: ctx.correlationId }, 400);
  }
  const min = Number((await ctx.client.query(`SELECT iam.setting_num('security.password_min_length',12) AS n`)).rows[0].n);
  const errs = checkPasswordPolicy(next, { username: ctx.user.username, fullName: ctx.user.fullName, minLength: min });
  if (errs.length) throw new HttpError(400, errs.join(' '), 'weak_password');
  const hist = (await ctx.client.query('SELECT * FROM iam.recent_password_hashes($1, NULL)', [ctx.user.id])).rows.map((r) => r.recent_password_hashes as string);
  if (await matchesHistory(next, hist)) throw new HttpError(400, 'Choose a password you have not used recently.', 'reused');
  await ctx.client.query('SELECT iam.change_password($1,$2)', [await hashPassword(next), ctx.session.sessionId]);
  await logEvent('password_change', 'success', { userId: ctx.user.id, username: ctx.user.username, session: ctx.session.sessionId, corr: ctx.correlationId, req: ctx.req });
  return json({ ok: true });
});
