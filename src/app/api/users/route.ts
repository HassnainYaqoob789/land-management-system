import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { protect, json, readJson, HttpError, type Ctx } from '@/lib/iam/http';
import { fail, gatedMutation, text, uuid, refusalText, actorTier, PROVINCE_RE, UUID_RE } from '../roles/_lib/admin';
import { ROLE_CODE_RE, scopeRank } from '@/components/roles/model';

// Account administration. GET (users:read) lists accounts, grants and — with
// sessions:read — sessions; ?effective=<id> resolves one account's effective
// permissions and ?history=<id> its role history. Every POST action names the
// permission it needs and re-authenticates (see GATES). The database decides
// in the end: the identity routines, row-level security on iam.user_role and
// its guards (delegation, tier, separation of duties, the last administrator,
// no self-assignment, no time-limited administrator); the checks here give a
// clear answer first.

const SYSADMIN = 'system-administrator';
const MAX_BULK = 200;
const MAX_EXPIRY_MS = 10 * 365 * 24 * 3600 * 1000;

const GATES: Record<string, [string, string]> = {
  create_user: ['users', 'create'], set_status: ['users', 'update'], update_user: ['users', 'update'],
  reset_mfa: ['users', 'reset_mfa'], revoke_sessions: ['users', 'revoke_sessions'],
  assign_role: ['users', 'assign'], revoke_role: ['users', 'assign'], set_role_expiry: ['users', 'assign'],
  bulk_assign: ['users', 'assign'], bulk_revoke: ['users', 'assign'],
  anonymise_user: ['users', 'delete'], set_break_glass: ['identity_settings', 'configure'], unlink_identity: ['users', 'update'],
};

/** Provinces this actor may hand out or limit a grant to: all of them in the Admin tier (as the database rules say), else their own. */
async function grantableProvinces(ctx: Ctx): Promise<string[]> {
  if ((await actorTier(ctx.client)).code === 'Admin')
    return (await ctx.client.query(`SELECT code::text AS code FROM lms.province ORDER BY display_order`)).rows.map((r) => r.code);
  return ctx.provinces;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
export const GET = protect({ permission: ['users', 'read'] }, async (ctx) => {
  try {
    const sp = new URL(ctx.req.url).searchParams;
    if (sp.has('effective')) return await effective(ctx, sp.get('effective') ?? '');
    if (sp.has('history')) return await history(ctx, sp.get('history') ?? '');
    const c = ctx.client;
    const canSessions = ctx.has('sessions', 'read');

    const users = (await c.query(`
      SELECT u.id, u.code, u.username::text AS username, u.full_name, u.email::text AS email,
             u.role_code, u.department, u.position, u.office_code, u.status,
             u.is_service_account, u.last_login_at, u.created_at,
             sec.is_break_glass, sec.must_change_password, sec.failed_count, sec.locked_until, sec.anonymised_at,
             coalesce(m.totp, false) AS mfa_totp, coalesce(m.passkeys, 0) AS passkeys,
             (coalesce(m.totp, false) OR coalesce(m.passkeys, 0) > 0) AS mfa_enrolled,
             COALESCE((SELECT array_agg(up.province_code::text ORDER BY up.province_code) FROM lms.app_user_province up WHERE up.user_id = u.id), '{}') AS provinces,
             COALESCE((SELECT array_agg(ug.group_code ORDER BY ug.group_code) FROM lms.app_user_group ug WHERE ug.user_id = u.id), '{}') AS groups,
             COALESCE((SELECT array_agg(r.code ORDER BY r.code) FROM iam.user_role ur JOIN iam.role r ON r.id = ur.role_id
                        WHERE ur.user_id = u.id AND ur.revoked_at IS NULL AND (ur.expires_at IS NULL OR ur.expires_at > now())), '{}') AS iam_roles
      FROM lms.app_user u
      LEFT JOIN iam.account_security sec ON sec.user_id = u.id
      LEFT JOIN iam.user_mfa_summary() m ON m.user_id = u.id
      WHERE u.is_service_account = false
      ORDER BY u.code ASC`)).rows;
    const roles = (await c.query(`
      SELECT r.id, r.code, r.name, r.description, r.status, r.is_system, r.db_role_code, iam.actor_covers_role(r.id) AS grantable,
             COALESCE((SELECT json_agg(p.resource || ':' || p.action ORDER BY p.resource, p.action)
                       FROM iam.role_permission rp JOIN iam.permission p ON p.id = rp.permission_id
                       WHERE rp.role_id = r.id), '[]'::json) AS permissions
      FROM iam.role r ORDER BY r.is_system DESC, r.name ASC`)).rows;
    const permissions = (await c.query(`SELECT resource, action, description, is_sensitive FROM iam.permission ORDER BY resource, action`)).rows;
    const groups = (await c.query(`
      SELECT g.*, EXISTS (SELECT 1 FROM lms.workflow_step_group s WHERE s.group_code = g.code) AS is_position
      FROM lms.approval_group g ORDER BY g.display_order ASC`)).rows;
    const offices = (await c.query(`SELECT * FROM lms.office ORDER BY code ASC`)).rows;
    const provisioning = (await c.query(`SELECT * FROM iam.provisioning_request ORDER BY requested_at DESC LIMIT 50`)).rows;
    const sessions = canSessions ? (await c.query(`
      SELECT ls.id, ls.user_id, ls.started_at, ls.last_seen_at, ls.expires_at, ls.source_ip::text AS source_ip,
             ls.auth_method, lms.user_username(ls.user_id)::text AS username, lms.user_full_name(ls.user_id) AS full_name
      FROM lms.login_session ls
      WHERE ls.ended_at IS NULL AND ls.expires_at > now()
      ORDER BY ls.last_seen_at DESC LIMIT 1000`)).rows : [];
    const assignments = (await c.query(`
      SELECT ur.id, ur.user_id, r.code AS role_code, r.name AS role_name, r.status AS role_status, ur.scope_province,
             ur.granted_at, ur.expires_at, (ur.expires_at IS NOT NULL AND ur.expires_at <= now()) AS expired,
             lms.user_full_name(ur.granted_by) AS granted_by_name, ur.reason
      FROM iam.user_role ur JOIN iam.role r ON r.id = ur.role_id
      WHERE ur.revoked_at IS NULL
      ORDER BY ur.granted_at DESC`)).rows;
    const identities = (await c.query(`
      SELECT e.id, e.user_id, e.subject, e.linked_at, e.last_login_at, ap.display_name AS provider, ap.kind
      FROM iam.external_identity e LEFT JOIN iam.auth_provider ap ON ap.id = e.provider_id
      WHERE e.unlinked_at IS NULL ORDER BY e.linked_at`)).rows;

    return json({
      users, roles, permissions, approval_groups: groups, offices, provisioning_requests: provisioning,
      active_sessions: sessions, assignments, identities,
      actor: { id: ctx.user.id, grantableProvinces: await grantableProvinces(ctx), canReadSessions: canSessions },
    });
  } catch (e) { return fail(e, ctx.correlationId); }
});

/** What one account can actually do now: iam.effective_permissions, grouped by permission with every grant behind it. */
async function effective(ctx: Ctx, id: string) {
  if (!UUID_RE.test(id)) throw new HttpError(404, 'No such account.', 'not_found');
  const user = (await ctx.client.query(
    `SELECT id, code, username::text AS username, full_name, status FROM lms.app_user WHERE id = $1 AND NOT is_service_account`, [id])).rows[0];
  if (!user) throw new HttpError(404, 'No such account.', 'not_found');
  const rows = (await ctx.client.query(
    `SELECT e.resource, e.action, e.scope_level, e.scope_province::text AS scope_province, e.scope_project, e.role_code
     FROM iam.effective_permissions($1) e`, [id])).rows;
  type Grant = { role: string; scope_level: string; scope_province: string | null; scope_project: string | null };
  type Eff = { key: string; resource: string; action: string; widest: string; grants: Grant[] };
  const by = new Map<string, Eff>();
  for (const r of rows) {
    const key = `${r.resource}:${r.action}`;
    const p: Eff = by.get(key) ?? { key, resource: r.resource, action: r.action, widest: r.scope_level, grants: [] };
    if (scopeRank(r.scope_level) > scopeRank(p.widest)) p.widest = r.scope_level;
    p.grants.push({ role: r.role_code, scope_level: r.scope_level, scope_province: r.scope_province, scope_project: r.scope_project });
    by.set(key, p);
  }
  return json({ user, permissions: [...by.values()], roles: [...new Set(rows.map((r) => r.role_code))].sort() });
}

/** Every grant this account has had, open or revoked, and the account events about it. */
async function history(ctx: Ctx, id: string) {
  if (!UUID_RE.test(id)) throw new HttpError(404, 'No such account.', 'not_found');
  const assignments = (await ctx.client.query(`
    SELECT ur.id, r.code AS role_code, r.name AS role_name, ur.scope_province, ur.granted_at,
           lms.user_full_name(ur.granted_by) AS granted_by_name, ur.expires_at, ur.reason,
           ur.revoked_at, lms.user_full_name(ur.revoked_by) AS revoked_by_name, ur.revoke_reason
    FROM iam.user_role ur JOIN iam.role r ON r.id = ur.role_id
    WHERE ur.user_id = $1
    ORDER BY coalesce(ur.revoked_at, ur.granted_at) DESC LIMIT 500`, [id])).rows;
  // Row-level security limits these to administrators and Internal Audit.
  const events = (await ctx.client.query(`
    SELECT e.id, e.occurred_at, e.event_type, e.outcome, lms.user_full_name(e.actor_user_id) AS actor_name, e.metadata
    FROM audit.auth_event e
    WHERE e.target_user_id = $1
      AND e.event_type IN ('user_created','user_updated','user_status','role_granted','role_revoked','mfa_reset_by_admin',
                           'user_anonymised','break_glass_designated','access_review_decision')
    ORDER BY e.occurred_at DESC LIMIT 200`, [id])).rows;
  return json({ assignments, events });
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------
export const POST = gatedMutation((b) => {
  const a = typeof b.action === 'string' ? b.action : '';
  if (a === 'issue_token') {
    if (b.purpose === 'invitation') return { permission: ['users', 'create'] };
    if (b.purpose === undefined || b.purpose === 'password_reset') return { permission: ['users', 'update'] };
    return null;
  }
  return Object.hasOwn(GATES, a) ? { permission: GATES[a] } : null;
}, async (ctx) => {
  try {
    const b = await readJson(ctx.req, 60_000);
    switch (b.action) {
      case 'create_user': return await createUser(ctx, b);
      case 'issue_token': return await issueToken(ctx, b);
      case 'set_status': return await setStatus(ctx, b);
      case 'update_user': return await updateUser(ctx, b);
      case 'reset_mfa': return await resetMfa(ctx, b);
      case 'revoke_sessions': return await revokeSessions(ctx, b);
      case 'assign_role': return await assignRole(ctx, b);
      case 'revoke_role': return await revokeRole(ctx, b);
      case 'set_role_expiry': return await setRoleExpiry(ctx, b);
      case 'bulk_assign': return await bulkAssign(ctx, b);
      case 'bulk_revoke': return await bulkRevoke(ctx, b);
      case 'anonymise_user': return await anonymise(ctx, b);
      case 'set_break_glass': return await breakGlass(ctx, b);
      case 'unlink_identity': return await unlinkIdentity(ctx, b);
    }
    throw new HttpError(400, 'Invalid action.', 'bad_request');
  } catch (e) { return fail(e, ctx.correlationId); }
});

/** A different, existing, non-service account. */
async function target(ctx: Ctx, id: string, what: string) {
  if (id === ctx.user.id) throw new HttpError(403, `You cannot ${what} on your own account.`, 'forbidden');
  const u = (await ctx.client.query(
    `SELECT u.id, u.username::text AS username, u.status, u.is_service_account, sec.anonymised_at
     FROM lms.app_user u LEFT JOIN iam.account_security sec ON sec.user_id = u.id WHERE u.id = $1`, [id])).rows[0];
  if (!u || u.is_service_account) throw new HttpError(404, 'No such account.', 'not_found');
  return u as { id: string; username: string; status: string; anonymised_at: string | null };
}

function strList(v: unknown, label: string, max: number, re?: RegExp): string[] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === 'string' && x.length <= 80 && (!re || re.test(x))))
    throw new HttpError(400, `${label} must be a list of valid values.`, 'validation');
  return [...new Set(v as string[])];
}

async function checkGroups(c: PoolClient, groups: string[]) {
  if (!groups.length) return;
  const bad = (await c.query(`SELECT x FROM unnest($1::text[]) x WHERE NOT EXISTS (SELECT 1 FROM lms.approval_group g WHERE g.code = x)`, [groups])).rows;
  if (bad.length) throw new HttpError(400, `Unknown approval position: ${bad.map((r) => r.x).join(', ')}.`, 'validation');
}

async function createUser(ctx: Ctx, b: Record<string, any>) {
  // Creating an account hands out roles and province access, so it is an assignment as well.
  if (!ctx.has('users', 'assign')) throw new HttpError(403, 'Creating an account also grants access: it needs users:assign.', 'forbidden');
  const username = text(b, 'username', { min: 3, max: 40 }).toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new HttpError(400, 'The username may use lower-case letters, digits, dot, hyphen and underscore.', 'validation');
  const fullName = text(b, 'full_name', { min: 2, max: 120 });
  const email = text(b, 'email', { max: 254, optional: true });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'The email address is not valid.', 'validation');
  const department = text(b, 'department', { max: 120, optional: true });
  const position = text(b, 'position', { max: 120, optional: true });
  const office = text(b, 'office_code', { max: 20, optional: true });
  const provinces = strList(b.provinces, 'Provinces', 10, PROVINCE_RE) ?? [];
  const groups = strList(b.groups, 'Approval positions', 20) ?? [];
  const roleCodes = strList(b.role_codes, 'Roles', 10, ROLE_CODE_RE) ?? [];
  // Access is granted explicitly: no default role and no default province.
  if (!roleCodes.length || !provinces.length) throw new HttpError(400, 'Choose at least one role and one province for the new account.', 'validation');
  const allowed = await grantableProvinces(ctx);
  const outside = provinces.filter((p) => !allowed.includes(p));
  if (outside.length) throw new HttpError(403, `You cannot grant access to ${outside.join(', ')}, which you do not hold.`, 'forbidden');
  await checkGroups(ctx.client, groups);

  const c = ctx.client;
  let id: string;
  try {
    id = (await c.query(`SELECT iam.create_user($1, $2, $3, $4, $5, $6, $7::text[], $8::text[], $9::text[]) AS id`,
      [username, fullName, email || null, department || null, position || null, office || null, provinces, groups, roleCodes])).rows[0].id;
  } catch (e: any) {
    if (e?.code === '23505') throw new HttpError(409, `The username “${username}” is already taken.`, 'conflict');
    throw e;
  }
  const raw = crypto.randomBytes(24).toString('base64url');
  const exp = (await c.query(`SELECT iam.issue_token($1, 'invitation', $2) AS expires_at`,
    [id, crypto.createHash('sha256').update(raw).digest()])).rows[0].expires_at;
  return json({ success: true, user_id: id, invitation_url: `/accept-invitation?token=${raw}`, expires_at: exp });
}

async function issueToken(ctx: Ctx, b: Record<string, any>) {
  const purpose = b.purpose === 'invitation' ? 'invitation' : 'password_reset';
  const u = await target(ctx, uuid(b, 'user_id', 'account'), 'issue a recovery link');
  if (u.status === 'Deactivated') throw new HttpError(409, 'A deactivated account cannot be recovered.', 'conflict');
  const raw = crypto.randomBytes(24).toString('base64url');
  const exp = (await ctx.client.query(`SELECT iam.issue_token($1, $2, $3) AS expires_at`,
    [u.id, purpose, crypto.createHash('sha256').update(raw).digest()])).rows[0].expires_at;
  const path = purpose === 'invitation' ? '/accept-invitation' : '/reset-password';
  return json({ success: true, url: `${path}?token=${raw}`, expires_at: exp });
}

async function setStatus(ctx: Ctx, b: Record<string, any>) {
  const status = b.status;
  if (!['Active', 'Suspended', 'Deactivated'].includes(status)) throw new HttpError(400, 'The status must be Active, Suspended or Deactivated.', 'validation');
  const reason = text(b, 'reason', { min: 5, max: 300 });
  const u = await target(ctx, uuid(b, 'user_id', 'account'), 'change the status');
  await ctx.client.query(`SELECT iam.set_user_status($1, $2, $3)`, [u.id, status, reason]);
  return json({ success: true });
}

async function updateUser(ctx: Ctx, b: Record<string, any>) {
  const id = uuid(b, 'user_id', 'account');
  const provinces = strList(b.provinces, 'Provinces', 10, PROVINCE_RE);
  const groups = strList(b.groups, 'Approval positions', 20);
  // Province access and approval positions are delegated authority (AUTHZ-08):
  // users:assign, and never on your own account.
  if (provinces !== null || groups !== null) {
    if (!ctx.has('users', 'assign'))
      throw new HttpError(403, 'Changing province access or approval positions needs users:assign.', 'forbidden');
    if (id === ctx.user.id)
      throw new HttpError(403, 'You cannot change your own province access or approval positions.', 'forbidden');
    if (groups) await checkGroups(ctx.client, groups);
  }
  const opt = (k: string, max: number) => (b[k] === undefined ? null : text(b, k, { max, optional: true }));
  const fullName = b.full_name === undefined ? null : text(b, 'full_name', { min: 2, max: 120 });
  const email = opt('email', 254);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'The email address is not valid.', 'validation');
  // Empty department / position keep the stored value (as before); empty email / office clear it.
  await ctx.client.query(`SELECT iam.update_user($1, $2, $3, $4, $5, $6, $7::text[], $8::text[])`,
    [id, fullName, email, opt('department', 120) || null, opt('position', 120) || null, opt('office_code', 20), provinces, groups]);
  return json({ success: true });
}

async function resetMfa(ctx: Ctx, b: Record<string, any>) {
  const justification = text(b, 'justification', { min: 10, max: 300 });
  const u = await target(ctx, uuid(b, 'user_id', 'account'), 'reset two-step verification');
  await ctx.client.query(`SELECT iam.reset_mfa($1, $2)`, [u.id, justification]);
  return json({ success: true });
}

async function revokeSessions(ctx: Ctx, b: Record<string, any>) {
  const id = uuid(b, 'user_id', 'account');
  const n = (await ctx.client.query(`SELECT iam.revoke_user_sessions($1, NULL) AS n`, [id])).rows[0]?.n ?? 0;
  return json({ success: true, revoked_count: n });
}

// ---- role assignment -------------------------------------------------------
interface GrantSpec { role: { id: string; code: string }; scope: string | null; expires: Date | null; reason: string }

/** Expiry: an ISO date-time (a bare date means the end of that day, UTC), in the future and within ten years. */
function parseExpiry(v: unknown): Date | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > 40 || !/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v))
    throw new HttpError(400, 'The expiry must be a date.', 'validation');
  // A date alone means the end of that day in Pakistan (PKT, UTC+5, no daylight saving), where the users are.
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T23:59:59+05:00` : v);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'The expiry must be a date.', 'validation');
  if (d.getTime() <= Date.now() + 60_000) throw new HttpError(400, 'The expiry must be in the future.', 'validation');
  if (d.getTime() > Date.now() + MAX_EXPIRY_MS) throw new HttpError(400, 'The expiry must be within ten years.', 'validation');
  return d;
}

async function grantSpec(ctx: Ctx, b: Record<string, any>): Promise<GrantSpec> {
  const code = text(b, 'role_code', { max: 31, label: 'role' });
  if (!ROLE_CODE_RE.test(code)) throw new HttpError(404, 'No such role.', 'not_found');
  const reason = text(b, 'reason', { min: 5, max: 300 });
  const role = (await ctx.client.query(`SELECT id, code, status, iam.actor_covers_role(id) AS grantable FROM iam.role WHERE code = $1`, [code])).rows[0];
  if (!role) throw new HttpError(404, 'No such role.', 'not_found');
  if (role.status !== 'active') throw new HttpError(409, `The role is ${role.status === 'inactive' ? 'suspended' : role.status} and cannot be assigned.`, 'conflict');
  if (!role.grantable) throw new HttpError(403, 'You cannot grant a role containing permissions you do not hold, or above your own database tier.', 'forbidden');
  const scopeRaw = text(b, 'scope_province', { max: 3, optional: true }).toUpperCase();
  const scope = scopeRaw || null;
  if (scope && !PROVINCE_RE.test(scope)) throw new HttpError(400, 'Unknown province.', 'validation');
  const expires = parseExpiry(b.expires_at);
  if (role.code === SYSADMIN && (scope || expires))
    throw new HttpError(400, 'A system administrator grant cannot be limited to a province or time-limited.', 'validation');
  if (scope && !(await grantableProvinces(ctx)).includes(scope))
    throw new HttpError(403, `You can only limit a grant to a province you hold; ${scope} is not one of them.`, 'forbidden');
  return { role, scope, expires, reason };
}

const INSERT_GRANT = `INSERT INTO iam.user_role (user_id, role_id, scope_province, expires_at, reason)
                      SELECT u, $2, $3, $4, $5 FROM unnest($1::uuid[]) u RETURNING id, user_id`;

async function assignRole(ctx: Ctx, b: Record<string, any>) {
  const id = uuid(b, 'user_id', 'account');
  if (id === ctx.user.id) throw new HttpError(403, 'You cannot assign a role to yourself.', 'forbidden');
  const g = await grantSpec(ctx, b);
  if (g.scope) {
    const has = (await ctx.client.query(`SELECT 1 FROM lms.app_user_province WHERE user_id = $1 AND province_code = $2`, [id, g.scope])).rows.length;
    if (!has) throw new HttpError(400, `The account has no access to ${g.scope}; give it the province first or choose another.`, 'validation');
  }
  try {
    const r = await ctx.client.query(INSERT_GRANT, [[id], g.role.id, g.scope, g.expires, g.reason]);
    return json({ success: true, assignment: r.rows[0] });
  } catch (e: any) {
    if (e?.code === '23505') throw new HttpError(409, 'The account already holds this role with the same scope.', 'conflict');
    if (e?.code === '22023') throw new HttpError(400, refusalText(e), 'validation');
    throw e;
  }
}

async function revokeRole(ctx: Ctx, b: Record<string, any>) {
  const id = uuid(b, 'assignment_id', 'assignment');
  const reason = text(b, 'reason', { min: 5, max: 300 });
  const a = (await ctx.client.query(
    `SELECT ur.user_id, r.code FROM iam.user_role ur JOIN iam.role r ON r.id = ur.role_id WHERE ur.id = $1 AND ur.revoked_at IS NULL`, [id])).rows[0];
  if (!a) throw new HttpError(404, 'Assignment not found or already revoked.', 'not_found');
  if (a.code === SYSADMIN && a.user_id === ctx.user.id)
    throw new HttpError(403, 'You cannot remove your own system administrator role.', 'forbidden');
  // The grant's reason stays; the revocation carries its own (0041).
  await ctx.client.query(`UPDATE iam.user_role SET revoked_at = now(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL`, [id, reason]);
  return json({ success: true });
}

/**
 * Change or remove the end date ("valid until") of an open grant, e.g. to extend
 * an exploration planner's temporary access. The database never edits a grant
 * (iam.tg_user_role_guard: "a role assignment cannot be edited; revoke it and
 * grant another"), so this revokes the grant and grants the same role, province
 * and project again with the new end date, in one savepoint: both happen or
 * neither. The new grant passes every check a first grant does (role active,
 * within the granter's authority and provinces, not your own account, account
 * not deactivated, separation of duties), and both steps are in the audit trail.
 * expires_at: an ISO date-time in the future, or null / '' for no end date.
 */
async function setRoleExpiry(ctx: Ctx, b: Record<string, any>) {
  const id = uuid(b, 'assignment_id', 'assignment');
  const reason = text(b, 'reason', { min: 5, max: 300 });
  if (b.expires_at === undefined) throw new HttpError(400, 'Give the new end date, or null for no end date.', 'validation');
  const expires = parseExpiry(b.expires_at);
  const c = ctx.client;
  const a = (await c.query(
    `SELECT ur.id, ur.user_id, ur.role_id, ur.scope_province::text AS scope_province, ur.scope_project, ur.expires_at, ur.reason,
            r.code, r.status, iam.actor_covers_role(r.id) AS grantable
       FROM iam.user_role ur JOIN iam.role r ON r.id = ur.role_id
      WHERE ur.id = $1 AND ur.revoked_at IS NULL`, [id])).rows[0];
  if (!a) throw new HttpError(404, 'Assignment not found or already revoked.', 'not_found');
  if (a.user_id === ctx.user.id) throw new HttpError(403, 'You cannot change your own roles.', 'forbidden');
  if (a.code === SYSADMIN) throw new HttpError(400, 'A system administrator grant cannot be time-limited.', 'validation');
  if (a.status !== 'active')
    throw new HttpError(409, 'The role is suspended or retired; its grants cannot be changed until it is active again.', 'conflict');
  if (!a.grantable) throw new HttpError(403, 'You cannot grant a role containing permissions you do not hold, or above your own database tier.', 'forbidden');
  if (a.scope_province && !(await grantableProvinces(ctx)).includes(a.scope_province))
    throw new HttpError(403, `This grant is limited to ${a.scope_province}, which you may not grant.`, 'forbidden');
  const before = a.expires_at ? new Date(a.expires_at).getTime() : null;
  if (before === (expires ? expires.getTime() : null)) return json({ success: true, unchanged: true, assignment: { id: a.id, user_id: a.user_id } });

  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : 'no end date');
  const revokeReason = `Valid until changed from ${day(a.expires_at ? new Date(a.expires_at) : null)} to ${day(expires)}: ${reason}`.slice(0, 300);
  await c.query('SAVEPOINT role_expiry');
  try {
    const r = await c.query(`UPDATE iam.user_role SET revoked_at = now(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL`, [id, revokeReason]);
    if (!r.rowCount) throw new HttpError(409, 'Someone else changed this grant at the same moment. Reload and try again.', 'conflict');
    // The grant keeps the reason it was first given for; the change carries its own (on the revocation above).
    const g = await c.query(
      `INSERT INTO iam.user_role (user_id, role_id, scope_province, scope_project, expires_at, reason)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, user_id, expires_at`,
      [a.user_id, a.role_id, a.scope_province, a.scope_project, expires, (a.reason || reason).slice(0, 300)]);
    await c.query('RELEASE SAVEPOINT role_expiry');
    return json({ success: true, assignment: g.rows[0], replaced: id });
  } catch (e: any) {
    await c.query('ROLLBACK TO SAVEPOINT role_expiry');
    await c.query('RELEASE SAVEPOINT role_expiry');
    if (e?.code === '22023') throw new HttpError(400, refusalText(e), 'validation');
    throw e;
  }
}

function userIds(v: unknown): string[] {
  if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === 'string' && UUID_RE.test(x)))
    throw new HttpError(400, 'Choose at least one account.', 'validation');
  const ids = [...new Set((v as string[]).map((x) => x.toLowerCase()))];
  if (ids.length > MAX_BULK) throw new HttpError(400, `At most ${MAX_BULK} accounts at a time.`, 'validation');
  return ids;
}

/** Per-account refusals with names, then a 409 that says nothing was changed. */
async function bulkRefused(ctx: Ctx, verb: string, total: number, errors: { user_id: string | null; error: string }[]) {
  const ids = errors.map((e) => e.user_id).filter((x): x is string => !!x);
  const names = new Map<string, string>((await ctx.client.query(
    `SELECT id::text AS id, lms.user_username(id)::text AS username FROM unnest($1::uuid[]) id`, [ids])).rows.map((r) => [r.id, r.username]));
  return json({
    error: `No change was made: ${errors.length} of ${total} account(s) could not ${verb}. Fix or remove them and try again.`,
    code: 'bulk_failed', errors: errors.map((e) => ({ ...e, username: e.user_id ? names.get(e.user_id) ?? null : null })),
    correlationId: ctx.correlationId,
  }, 409);
}

/**
 * One role for many accounts in one transaction: all or nothing. The common
 * case is one statement; when it is refused, each account is tried on its own
 * (inside savepoints) to name every refusal, and then all of it is undone.
 */
async function bulkAssign(ctx: Ctx, b: Record<string, any>) {
  const ids = userIds(b.user_ids);
  const g = await grantSpec(ctx, b);
  const c = ctx.client;
  await c.query('SAVEPOINT bulk_all');
  try {
    const r = await c.query(INSERT_GRANT, [ids, g.role.id, g.scope, g.expires, g.reason]);
    await c.query('RELEASE SAVEPOINT bulk_all');
    return json({ success: true, assigned: r.rowCount });
  } catch (first) {
    await c.query('ROLLBACK TO SAVEPOINT bulk_all');
    const errors: { user_id: string | null; error: string }[] = [];
    for (const id of ids) {
      await c.query('SAVEPOINT bulk_one');
      try {
        await c.query(INSERT_GRANT, [[id], g.role.id, g.scope, g.expires, g.reason]);
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT bulk_one');
        errors.push({ user_id: id, error: refusalText(e) });
      }
      await c.query('RELEASE SAVEPOINT bulk_one');
    }
    await c.query('ROLLBACK TO SAVEPOINT bulk_all');
    await c.query('RELEASE SAVEPOINT bulk_all');
    if (!errors.length) errors.push({ user_id: null, error: refusalText(first) });
    return bulkRefused(ctx, 'be given the role', ids.length, errors);
  }
}

async function bulkRevoke(ctx: Ctx, b: Record<string, any>) {
  const ids = userIds(b.user_ids);
  const code = text(b, 'role_code', { max: 31, label: 'role' });
  if (!ROLE_CODE_RE.test(code)) throw new HttpError(404, 'No such role.', 'not_found');
  const reason = text(b, 'reason', { min: 5, max: 300 });
  const role = (await ctx.client.query(`SELECT id, code FROM iam.role WHERE code = $1`, [code])).rows[0];
  if (!role) throw new HttpError(404, 'No such role.', 'not_found');
  if (role.code === SYSADMIN && ids.includes(ctx.user.id))
    return bulkRefused(ctx, 'have the role revoked', ids.length, [{ user_id: ctx.user.id, error: 'You cannot remove your own system administrator role.' }]);
  const c = ctx.client;
  const sql = `UPDATE iam.user_role SET revoked_at = now(), revoke_reason = $3
               WHERE role_id = $2 AND user_id = ANY($1::uuid[]) AND revoked_at IS NULL RETURNING user_id::text`;
  await c.query('SAVEPOINT bulk_all');
  try {
    const r = await c.query(sql, [ids, role.id, reason]);
    const done = new Set(r.rows.map((x) => x.user_id));
    const missing = ids.filter((id) => !done.has(id));
    if (missing.length) {
      await c.query('ROLLBACK TO SAVEPOINT bulk_all');
      await c.query('RELEASE SAVEPOINT bulk_all');
      return bulkRefused(ctx, 'have the role revoked', ids.length, missing.map((id) => ({ user_id: id, error: 'Does not hold this role.' })));
    }
    await c.query('RELEASE SAVEPOINT bulk_all');
    return json({ success: true, revoked: r.rowCount, accounts: done.size });
  } catch (first) {
    await c.query('ROLLBACK TO SAVEPOINT bulk_all');
    const errors: { user_id: string | null; error: string }[] = [];
    for (const id of ids) {
      await c.query('SAVEPOINT bulk_one');
      try {
        const r = await c.query(sql, [[id], role.id, reason]);
        if (!r.rowCount) errors.push({ user_id: id, error: 'Does not hold this role.' });
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT bulk_one');
        errors.push({ user_id: id, error: refusalText(e) });
      }
      await c.query('RELEASE SAVEPOINT bulk_one');
    }
    await c.query('ROLLBACK TO SAVEPOINT bulk_all');
    await c.query('RELEASE SAVEPOINT bulk_all');
    if (!errors.length) errors.push({ user_id: null, error: refusalText(first) });
    return bulkRefused(ctx, 'have the role revoked', ids.length, errors);
  }
}

// ---- account lifecycle (UA-07) ---------------------------------------------
async function anonymise(ctx: Ctx, b: Record<string, any>) {
  const reason = text(b, 'reason', { min: 10, max: 300, label: 'justification' });
  const u = await target(ctx, uuid(b, 'user_id', 'account'), 'anonymise');
  if (u.anonymised_at) throw new HttpError(409, 'The account is already anonymised.', 'conflict');
  // Irreversible: the caller must type the username they mean.
  if (typeof b.confirm !== 'string' || b.confirm.trim().toLowerCase() !== u.username.toLowerCase())
    throw new HttpError(400, 'Type the account\'s username to confirm.', 'validation');
  await ctx.client.query(`SELECT iam.anonymise_user($1, $2)`, [u.id, reason]);
  return json({ success: true });
}

async function breakGlass(ctx: Ctx, b: Record<string, any>) {
  if (typeof b.on !== 'boolean') throw new HttpError(400, 'Say whether emergency access is on or off.', 'validation');
  const u = await target(ctx, uuid(b, 'user_id', 'account'), 'change emergency access');
  await ctx.client.query(`SELECT iam.set_break_glass($1, $2)`, [u.id, b.on]);
  return json({ success: true });
}

async function unlinkIdentity(ctx: Ctx, b: Record<string, any>) {
  const id = uuid(b, 'identity_id', 'linked identity');
  const reason = text(b, 'reason', { min: 5, max: 200 });
  const e = (await ctx.client.query(`SELECT user_id FROM iam.external_identity WHERE id = $1 AND unlinked_at IS NULL`, [id])).rows[0];
  if (!e) throw new HttpError(404, 'No such linked identity.', 'not_found');
  await target(ctx, e.user_id, 'unlink a sign-in identity');
  await ctx.client.query(`SELECT iam.unlink_identity($1, $2)`, [id, reason]);
  return json({ success: true });
}
