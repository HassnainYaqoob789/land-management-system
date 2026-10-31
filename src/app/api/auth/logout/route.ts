import { NextResponse } from 'next/server';
import { protect } from '@/lib/iam/http';
import { clearSessionCookie } from '@/lib/iam/session';
import { logEvent } from '@/lib/iam/login';

export const POST = protect({ authenticatedOnly: true, allowPendingMfa: true, allowMustChange: true }, async (ctx) => {
  await ctx.client.query('SELECT iam.end_session($1,$2)', [ctx.session.sessionId, 'logout']);
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  // Written after the transaction's own work; a failure here must not undo the logout.
  logEvent('logout', 'success', { userId: ctx.user.id, username: ctx.user.username, session: ctx.session.sessionId, corr: ctx.correlationId, req: ctx.req }).catch(() => {});
  return res;
});
