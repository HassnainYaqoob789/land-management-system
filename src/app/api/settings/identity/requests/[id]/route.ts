import { HttpError, json, protect, readJson, str } from '@/lib/iam/http';
import { idOf, noteOf } from '@/lib/iam/sso/admin';

// Decide an access request from a first-time external sign-in
// (iam.decide_provisioning, which needs users:create). Approving creates the
// account — or links an existing one, by username — with NO roles: access
// comes from group mappings at the next sign-in, or from the Users screen.
export const POST = protect({ permission: ['users', 'create'], reauth: true }, async (ctx) => {
  const id = idOf(ctx.params?.id);
  const b = await readJson(ctx.req, 4096);
  const decision = str(b, 'decision', { max: 10 });
  if (decision !== 'approve' && decision !== 'reject') throw new HttpError(400, 'decision must be approve or reject.', 'validation');
  const note = noteOf(b);

  let linkUser: string | null = null;
  const linkUsername = decision === 'approve' ? str(b, 'linkUsername', { max: 64, optional: true }).trim().toLowerCase() : '';
  if (linkUsername) {
    const u = (await ctx.client.query(`SELECT u.id, u.status, u.is_service_account, coalesce(a.is_break_glass, false) AS is_break_glass
        FROM lms.app_user u LEFT JOIN iam.account_security a ON a.user_id = u.id WHERE u.username = $1`, [linkUsername])).rows[0];
    if (!u) throw new HttpError(400, 'No account has that username.', 'validation');
    if (u.status !== 'Active' || u.is_service_account || u.is_break_glass)
      throw new HttpError(400, 'Only an active, ordinary account can be linked (not a service or emergency-access account).', 'validation');
    linkUser = u.id;
  }

  const r = await ctx.client.query(`SELECT iam.decide_provisioning($1, $2, $3, $4, '{}'::text[]) AS user_id`,
    [id, decision === 'approve', note ?? (decision === 'approve' ? 'Approved in Settings' : 'Rejected in Settings'), linkUser]).catch((e) => {
    if (e?.code === 'P0002') throw new HttpError(404, 'That request is no longer pending.', 'not_found');
    if (e?.code === '23505')
      throw new HttpError(409, 'An account or link for this person already exists. Approve by linking it to the existing username.', 'conflict');
    throw e;
  });
  return json({ ok: true, userId: r.rows[0].user_id ?? null });
});
