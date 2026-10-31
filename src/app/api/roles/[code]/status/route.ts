import { json, readJson, HttpError } from '@/lib/iam/http';
import { fail, gatedMutation, text, roleRows } from '../../_lib/admin';
import { ROLE_CODE_RE, statusTargets, STATUS_LABEL, type RoleStatus } from '@/components/roles/model';

// Activate, suspend (inactive) or retire a role through iam.set_role_status,
// with a reason. Retiring is a deletion of the role's authority: roles:delete;
// the other two need roles:update. Both re-authenticate.

export const POST = gatedMutation(
  (b) => (b.status === 'retired' ? { permission: ['roles', 'delete'] }
    : b.status === 'active' || b.status === 'inactive' ? { permission: ['roles', 'update'] } : null),
  async (ctx) => {
    try {
      const code = typeof ctx.params?.code === 'string' ? ctx.params.code : '';
      if (!ROLE_CODE_RE.test(code)) throw new HttpError(404, 'No such role.', 'not_found');
      const b = await readJson(ctx.req, 5_000);
      const status = b.status as RoleStatus;
      const reason = text(b, 'reason', { min: 5, max: 300 });

      const [role] = await roleRows(ctx.client, code);
      if (!role) throw new HttpError(404, 'No such role.', 'not_found');
      if (role.is_system) throw new HttpError(409, 'System roles are always active.', 'conflict');
      if (role.status === status) throw new HttpError(409, `The role is already ${STATUS_LABEL[status].toLowerCase()}.`, 'conflict');
      if (!statusTargets(role.status, role.is_system).includes(status))
        throw new HttpError(409, `A ${STATUS_LABEL[role.status as RoleStatus]?.toLowerCase() ?? role.status} role cannot become ${STATUS_LABEL[status].toLowerCase()}.`, 'conflict');
      if (status === 'retired') {
        // Expired but unrevoked assignments count too: the database refuses them as well.
        const open = Number((await ctx.client.query(
          `SELECT count(*) AS n FROM iam.user_role WHERE role_id = $1 AND revoked_at IS NULL`, [role.id])).rows[0].n);
        if (open > 0) throw new HttpError(409, `The role still has ${open} assignment(s); revoke them before retiring it.`, 'conflict');
      }
      if (!role.grantable)
        throw new HttpError(403, 'You cannot change the status of a role containing permissions you do not hold.', 'forbidden');

      await ctx.client.query('SELECT iam.set_role_status($1, $2, $3)', [code, status, reason]);
      const [after] = await roleRows(ctx.client, code);
      return json({ role: after });
    } catch (e) { return fail(e, ctx.correlationId); }
  });
