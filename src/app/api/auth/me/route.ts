import { protect, json } from '@/lib/iam/http';
import { csrfFor } from '@/lib/iam/session';
import { sessionRequiresMfa } from '@/lib/iam/mfa';

export const GET = protect({ authenticatedOnly: true, allowPendingMfa: true, allowMustChange: true }, async (ctx) => {
  // The same policy as sign-in (iam.mfa_required_for), so the shell can send
  // anyone who must enrol to the security page.
  const needMfa = await sessionRequiresMfa(ctx.client, ctx.session);
  const prof = (await ctx.client.query('SELECT position, department, office_code FROM lms.app_user WHERE id = $1', [ctx.user.id])).rows[0] || {};
  // Approval positions held (lms.app_user_group), so screens offer only the steps this user may take.
  const groups: string[] = (await ctx.client.query('SELECT lms.actor_groups() AS g')).rows[0]?.g ?? [];
  return json({
    user: { id: ctx.user.id, username: ctx.user.username, fullName: ctx.user.fullName, email: ctx.user.email,
            role_code: ctx.user.dbRole, full_name: ctx.user.fullName,
            position: prof.position ?? null, department: prof.department ?? null, office_code: prof.office_code ?? null, groups },
    roles: ctx.roles,
    provinces: ctx.provinces,
    permissions: ctx.perms.map((p) => `${p.resource}:${p.action}`),
    csrfToken: csrfFor(ctx.session.sessionId),
    session: { method: ctx.session.authMethod, expiresAt: ctx.session.expiresAt, mfaSatisfied: !!ctx.session.mfaSatisfiedAt },
    mfa: { enrolled: ctx.session.mfaEnrolled, required: needMfa, enrolmentOutstanding: needMfa && !ctx.session.mfaSatisfiedAt },
    mustChangePassword: ctx.session.mustChangePassword,
  });
});
