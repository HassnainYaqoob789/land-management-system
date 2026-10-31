import { protect, json } from '@/lib/iam/http';
import { regenerateRecoveryCodes } from '@/lib/iam/mfa';
import { logEvent } from '@/lib/iam/login';

// New recovery codes invalidate the old ones; needs a recent re-authentication.
export const POST = protect({ authenticatedOnly: true, reauth: true }, async (ctx) => {
  const enrolled = (await ctx.client.query('SELECT 1 FROM iam.mfa_totp WHERE user_id = $1 AND confirmed_at IS NOT NULL', [ctx.user.id])).rowCount;
  if (!enrolled) return json({ error: 'Enrol an authenticator app first.', code: 'not_enrolled' }, 400);
  const codes = await regenerateRecoveryCodes(ctx.client, ctx.user.id);
  logEvent('recovery_codes_regenerated', 'success', { userId: ctx.user.id, username: ctx.user.username, corr: ctx.correlationId, req: ctx.req }).catch(() => {});
  return json({ recoveryCodes: codes });
});
