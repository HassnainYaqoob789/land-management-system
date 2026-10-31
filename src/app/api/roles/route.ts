import { protect, json, readJson, HttpError } from '@/lib/iam/http';
import { fail, text, roleRows, actorTier, parsePermissions } from './_lib/admin';
import { SCOPES, heldScopes, roleCodeProblem, deniedChanges, type RolePerm } from '@/components/roles/model';

// Role administration. Reading needs roles:read; every change re-authenticates.
// The database decides (row-level security on iam.role / iam.role_permission
// and their guard triggers: delegation, tier, system roles, separation of
// duties); the checks here exist to give a clear answer first.

export const GET = protect({ permission: ['roles', 'read'] }, async (ctx) => {
  try {
    const c = ctx.client;
    const roles = await roleRows(c);
    const perms = (await c.query(
      `SELECT rp.role_id, p.resource, p.action, rp.scope_level
       FROM iam.role_permission rp JOIN iam.permission p ON p.id = rp.permission_id
       ORDER BY p.resource, p.action`)).rows;
    const catalogue = (await c.query(`SELECT resource, action, description, is_sensitive FROM iam.permission ORDER BY resource, action`)).rows;
    const tiers = (await c.query(`SELECT code, name, description, rank FROM lms.app_role ORDER BY rank`)).rows;
    const tier = await actorTier(c);
    const byRole = new Map<string, RolePerm[]>();
    for (const p of perms) {
      const list = byRole.get(p.role_id) ?? [];
      list.push({ resource: p.resource, action: p.action, scope_level: p.scope_level });
      byRole.set(p.role_id, list);
    }
    return json({
      roles: roles.map((r) => ({ ...r, permissions: byRole.get(r.id) ?? [] })),
      catalogue, tiers, scopes: SCOPES,
      actor: {
        id: ctx.user.id, tier: tier.code, tierRank: tier.rank, holds: heldScopes(ctx.perms),
        can: {
          create: ctx.has('roles', 'create'), update: ctx.has('roles', 'update'), delete: ctx.has('roles', 'delete'),
          managePermissions: ctx.has('roles', 'manage_permissions'),
          reviewRead: ctx.has('users', 'read'), reviewWrite: ctx.has('users', 'assign'),
        },
      },
    });
  } catch (e) { return fail(e, ctx.correlationId); }
});

export const POST = protect({ permission: ['roles', 'create'], reauth: true }, async (ctx) => {
  try {
    const b = await readJson(ctx.req, 50_000);
    const code = typeof b.code === 'string' ? b.code.trim() : '';
    const problem = roleCodeProblem(code);
    if (problem) throw new HttpError(400, problem, 'validation');
    const name = text(b, 'name', { min: 3, max: 80 });
    const description = text(b, 'description', { max: 500, optional: true });
    const tierCode = text(b, 'db_role_code', { max: 20, label: 'database tier' });

    const c = ctx.client;
    const tierRow = (await c.query(`SELECT code, rank FROM lms.app_role WHERE code = $1`, [tierCode])).rows[0];
    if (!tierRow) throw new HttpError(400, 'Unknown database tier.', 'validation');
    if (tierRow.code === 'Admin') throw new HttpError(403, 'A custom role cannot use the Admin database tier.', 'forbidden');
    const mine = await actorTier(c);
    if (Number(tierRow.rank) > mine.rank)
      throw new HttpError(403, `You cannot create a role above your own database tier (${mine.code ?? 'none'}).`, 'forbidden');

    const perms = b.permissions === undefined ? [] : await parsePermissions(ctx.client, b.permissions);
    if (perms.length) {
      if (!ctx.has('roles', 'manage_permissions'))
        throw new HttpError(403, 'Adding permissions to a role needs roles:manage_permissions.', 'forbidden');
      const denied = deniedChanges(heldScopes(ctx.perms), { added: perms, removed: [], changed: [] });
      if (denied.length)
        return json({ error: `You cannot grant permissions you do not hold at that scope: ${denied.join(', ')}.`, code: 'forbidden', denied, correlationId: ctx.correlationId }, 403);
    }

    let id: string;
    try {
      id = (await c.query(
        `INSERT INTO iam.role (code, name, description, db_role_code) VALUES ($1, $2, $3, $4) RETURNING id`,
        [code, name, description, tierRow.code])).rows[0].id;
    } catch (e: any) {
      if (e?.code === '23505') throw new HttpError(409, `A role with the code “${code}” already exists.`, 'conflict');
      throw e;
    }
    if (perms.length) {
      // One statement; the guard and separation-of-duties triggers check every row.
      await c.query(
        `INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
         SELECT $1, p.id, x.scope_level
         FROM jsonb_to_recordset($2::jsonb) AS x(resource text, action text, scope_level text)
         JOIN iam.permission p ON p.resource = x.resource AND p.action = x.action`,
        [id, JSON.stringify(perms)]);
    }
    const [role] = await roleRows(c, code);
    return json({ role: { ...role, permissions: perms } }, 201);
  } catch (e) { return fail(e, ctx.correlationId); }
});
