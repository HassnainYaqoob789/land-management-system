import { protect, json, readJson, HttpError } from '@/lib/iam/http';
import { fail, parsePermissions } from '../../_lib/admin';
import { ROLE_CODE_RE, diffPermissions, deniedChanges, fingerprint, heldScopes, sameFingerprint, type RolePerm } from '@/components/roles/model';

// Replace a role's permission set (roles:manage_permissions, re-authenticated).
// The request carries the whole set and, as `base`, the fingerprint of the set
// it was edited from: a concurrent change is refused instead of overwritten.
// Only the differences are written, each through the guard triggers
// (delegation for what is added, removed or re-scoped; system and retired
// roles fixed; separation of duties).

export const PUT = protect({ permission: ['roles', 'manage_permissions'], reauth: true }, async (ctx) => {
  try {
    const code = typeof ctx.params?.code === 'string' ? ctx.params.code : '';
    if (!ROLE_CODE_RE.test(code)) throw new HttpError(404, 'No such role.', 'not_found');
    const b = await readJson(ctx.req, 60_000);
    const next = await parsePermissions(ctx.client, b.permissions);
    const c = ctx.client;

    // Serialise edits of one role's permissions. An advisory lock, not FOR UPDATE:
    // row security would hide the role row from an editor without roles:update.
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('iam.role_permission:' || $1, 0))`, [code]);
    const role = (await c.query(`SELECT id, is_system, status FROM iam.role WHERE code = $1`, [code])).rows[0];
    if (!role) throw new HttpError(404, 'No such role.', 'not_found');
    if (role.is_system) throw new HttpError(409, 'The permissions of a system role are fixed.', 'conflict');
    if (role.status === 'retired') throw new HttpError(409, 'A retired role cannot be changed.', 'conflict');

    const current: RolePerm[] = (await c.query(
      `SELECT p.resource, p.action, rp.scope_level FROM iam.role_permission rp JOIN iam.permission p ON p.id = rp.permission_id
       WHERE rp.role_id = $1`, [role.id])).rows;
    if (b.base !== undefined) {
      if (!Array.isArray(b.base) || !b.base.every((x: unknown) => typeof x === 'string'))
        throw new HttpError(400, 'base must be the list the edit started from.', 'validation');
      if (!sameFingerprint(fingerprint(current), [...b.base].sort()))
        throw new HttpError(409, 'Someone else changed this role\'s permissions meanwhile. Reload it and try again.', 'conflict');
    }

    const d = diffPermissions(current, next);
    if (!d.added.length && !d.removed.length && !d.changed.length) return json({ permissions: current, added: 0, removed: 0, changed: 0 });
    const denied = deniedChanges(heldScopes(ctx.perms), d);
    if (denied.length)
      return json({ error: `You cannot change permissions you do not hold at that scope: ${denied.join(', ')}.`, code: 'forbidden', denied,
        correlationId: ctx.correlationId }, 403);

    const set = (list: { resource: string; action: string; scope_level?: string; to?: string }[]) =>
      JSON.stringify(list.map((p) => ({ resource: p.resource, action: p.action, scope_level: p.to ?? p.scope_level })));
    if (d.removed.length)
      await c.query(
        `DELETE FROM iam.role_permission rp USING iam.permission p, jsonb_to_recordset($2::jsonb) AS x(resource text, action text, scope_level text)
         WHERE rp.role_id = $1 AND rp.permission_id = p.id AND p.resource = x.resource AND p.action = x.action`, [role.id, set(d.removed)]);
    if (d.changed.length)
      await c.query(
        `UPDATE iam.role_permission rp SET scope_level = x.scope_level
         FROM iam.permission p, jsonb_to_recordset($2::jsonb) AS x(resource text, action text, scope_level text)
         WHERE rp.role_id = $1 AND rp.permission_id = p.id AND p.resource = x.resource AND p.action = x.action`, [role.id, set(d.changed)]);
    if (d.added.length)
      await c.query(
        `INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
         SELECT $1, p.id, x.scope_level FROM jsonb_to_recordset($2::jsonb) AS x(resource text, action text, scope_level text)
         JOIN iam.permission p ON p.resource = x.resource AND p.action = x.action`, [role.id, set(d.added)]);

    const permissions = (await c.query(
      `SELECT p.resource, p.action, rp.scope_level FROM iam.role_permission rp JOIN iam.permission p ON p.id = rp.permission_id
       WHERE rp.role_id = $1 ORDER BY p.resource, p.action`, [role.id])).rows;
    return json({ permissions, added: d.added.length, removed: d.removed.length, changed: d.changed.length });
  } catch (e) { return fail(e, ctx.correlationId); }
});
