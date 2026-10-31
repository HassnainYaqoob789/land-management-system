import { protect, json } from '@/lib/iam/http';
import { startTotp } from '@/lib/iam/mfa';

export const POST = protect({ authenticatedOnly: true, allowPendingMfa: true }, async (ctx) => {
  // Once MFA is in place, enrolling a further factor needs fresh proof of identity.
  if (ctx.session.mfaEnrolled && !ctx.session.mfaSatisfiedAt)
    return json({ error: 'Verify your existing factor first.', code: 'mfa_required' }, 403);
  const r = await startTotp(ctx.client, ctx.user.id, ctx.user.email || ctx.user.username);
  // The secret is shown once, for manual entry; it is never retrievable again.
  return json({ otpauthUri: r.uri, secret: r.secret, qrSvg: r.qrSvg });
});
