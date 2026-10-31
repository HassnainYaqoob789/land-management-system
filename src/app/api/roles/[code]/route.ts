import { protect, json, readJson, HttpError } from '@/lib/iam/http';
import { fail, text, roleRows } from '../_lib/admin';
import { ROLE_CODE_RE } from '@/components/roles/model';

// One role: its permissions and its members (GET, roles:read); its name and
// description (PATCH, roles:update, re-authenticated, optimistic on version).

function codeOf(params: any): string {
  const code = typeof params?.code === 'string' ? params.code : '';
  if (!ROLE_CODE_RE.test(code)) throw new HttpError(404, 'No such role.', 'not_found');
  return code;
}

export const GET = protect({ permission: ['roles', 'read'] }, async (ctx) => {
  try {
    const [role] = await roleRows(ctx.client, codeOf(ctx.params));
    if (!role) throw new HttpError(404, 'No such role.', 'not_found');
    const permissions = (await ctx.client.query(
      `SELECT p.resource, p.action, rp.scope_level, p.description, p.is_sensitive
       FROM iam.role_permission rp JOIN iam.permission p ON p.id = rp.permission_id
       WHERE rp.role_id = $1 ORDER BY p.resource, p.action`, [role.id])).rows;
    // Names come from the definer look-ups so a roles:read holder sees who the
    // members are; status and code only where row security shows the account.
    const members = (await ctx.client.query(
      `SELECT ur.id AS assignment_id, ur.user_id, lms.user_username(ur.user_id)::text AS username,
              lms.user_full_name(ur.user_id) AS full_name, u.code AS user_code, u.status AS user_status,
              ur.scope_province, ur.granted_at, lms.user_full_name(ur.granted_by) AS granted_by_name,
              ur.expires_at, ur.reason, (ur.expires_at IS NOT NULL AND ur.expires_at <= now()) AS expired
       FROM iam.user_role ur LEFT JOIN lms.app_user u ON u.id = ur.user_id
       WHERE ur.role_id = $1 AND ur.revoked_at IS NULL
       ORDER BY 4, ur.granted_at
       LIMIT 2000`, [role.id])).rows;
    return json({ role, permissions, members });
  } catch (e) { return fail(e, ctx.correlationId); }
});

export const PATCH = protect({ permission: ['roles', 'update'], reauth: true }, async (ctx) => {
  try {
    const code = codeOf(ctx.params);
    const b = await readJson(ctx.req, 10_000);
    const version = Number(b.version);
    if (!Number.isInteger(version) || version < 1) throw new HttpError(400, 'The version of the role you edited is required.', 'validation');
    const name = text(b, 'name', { min: 3, max: 80, optional: true }) || null;
    const description = b.description === undefined ? null : text(b, 'description', { max: 500, optional: true });
    if (name === null && description === null) throw new HttpError(400, 'Nothing to change.', 'validation');

    const cur = (await ctx.client.query(`SELECT id, is_system, status, version FROM iam.role WHERE code = $1 FOR UPDATE`, [code])).rows[0];
    if (!cur) throw new HttpError(404, 'No such role.', 'not_found');
    if (cur.is_system) throw new HttpError(409, 'System roles are defined by migration and cannot be edited.', 'conflict');
    if (cur.status === 'retired') throw new HttpError(409, 'A retired role cannot be changed.', 'conflict');
    if (cur.version !== version) throw new HttpError(409, 'Someone else changed this role meanwhile. Reload it and try again.', 'conflict');
    await ctx.client.query(
      `UPDATE iam.role SET name = coalesce($2, name), description = coalesce($3, description) WHERE id = $1`,
      [cur.id, name, description]);
    const [role] = await roleRows(ctx.client, code);
    return json({ role });
  } catch (e) { return fail(e, ctx.correlationId); }
});
