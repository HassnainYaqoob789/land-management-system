import { protect, json, readJson, str } from '@/lib/iam/http';
import { confirmTotp } from '@/lib/iam/mfa';
import { logEvent } from '@/lib/iam/login';

export const POST = protect({ authenticatedOnly: true, allowPendingMfa: true }, async (ctx) => {
  const codes = await confirmTotp(ctx.client, ctx.user.id, str(await readJson(ctx.req, 1024), 'code', { max: 10 }).trim());
  if (!codes) return json({ error: 'That code is not valid. Check the time on your device and try again.', code: 'invalid_code' }, 400);
  // Enrolling satisfies MFA for the current session.
  await ctx.client.query('SELECT iam.mark_session_mfa($1,$2)', [ctx.session.sessionId, 'totp']);
  logEvent('mfa_enrolled', 'success', { userId: ctx.user.id, username: ctx.user.username, session: ctx.session.sessionId, corr: ctx.correlationId, req: ctx.req, meta: { method: 'totp' } }).catch(() => {});
  return json({ ok: true, recoveryCodes: codes });
});
