import { HttpError, str, type Ctx } from '../http';
import { appOrigin } from '../config';
import { isFailing, KIND_LABEL, passkeyAvailable, prerequisitesMet, type Kind, type ProviderRow } from './providers';
import { endpointsFor, SECRET } from './registry';

// Helpers shared by the settings and identity-administration routes.

/** An optional free-text reason recorded with a change. */
export function noteOf(b: Record<string, any>, key = 'note'): string | null {
  const v = b[key];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new HttpError(400, `${key} must be text.`, 'validation');
  if (v.length > 500) throw new HttpError(400, `${key} is too long (500 characters at most).`, 'validation');
  return v;
}

/** Our own routines raise invalid_parameter_value / raise_exception with
 * messages written for people ("lockout threshold must be 3 to 20"); pass
 * those through, and let protect() translate everything else. */
export function routineMessage(e: any): never {
  if (e?.code === '22023' || e?.code === 'P0001') throw new HttpError(400, String(e.message), 'validation');
  throw e;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A route id that is not a UUID is "not found", never a database error. */
export function idOf(v: unknown): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw new HttpError(404, 'Not found.', 'not_found');
  return v.toLowerCase();
}

/** The display name shown on the sign-in button. */
export function displayNameOf(b: Record<string, any>): string {
  const v = str(b, 'displayName', { max: 80 }).trim();
  if (!v || /[\u0000-\u001f\u007f]/.test(v)) throw new HttpError(400, 'displayName must be 1 to 80 printable characters.', 'validation');
  return v;
}

/** The write-only secret: accepted, encrypted, never echoed. */
export function secretOf(b: Record<string, any>): string | null {
  const v = b.secret;
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > 2000) throw new HttpError(400, 'secret must be text of at most 2000 characters.', 'validation');
  return v;
}

export type ProviderStatus = 'available' | 'disabled' | 'untested' | 'test_failed';

/** A provider as the administration screen shows it. Configuration holds no
 * secret by construction (iam.metadata_is_safe on the table refuses one); the
 * secret itself is reported only as present or not. */
export function providerView(row: ProviderRow & { last_test_by_name?: string | null }) {
  const status: ProviderStatus = row.last_test_ok === true ? (row.enabled ? 'available' : 'disabled')
    : row.last_test_ok === false ? 'test_failed' : 'untested';
  const runtimeIssue = row.enabled && row.last_test_ok
    ? (!prerequisitesMet(row.kind) ? 'The server is missing configuration this method needs (APP_ORIGIN or IAM_MASTER_KEYS).'
      : isFailing(row.name) ? 'It failed at run time in the last few minutes; the sign-in page shows it as unavailable meanwhile.' : null)
    : null;
  return {
    id: row.id, name: row.name, displayName: row.display_name, kind: row.kind, kindLabel: KIND_LABEL[row.kind],
    enabled: row.enabled, status, runtimeIssue,
    lastTestedAt: row.last_tested_at, lastTestOk: row.last_test_ok, lastTestDetail: row.last_test_detail,
    lastTestBy: row.last_test_by_name ?? null, version: row.version, updatedAt: row.updated_at,
    hasSecret: !!row.secret_id, secretLabel: SECRET[row.kind]?.label ?? null,
    config: row.config ?? {},
    endpoints: endpointsFor(row.kind, row.name, row.config ?? {}),
  };
}

const PROVIDER_COLUMNS = `p.id, p.kind, p.name, p.display_name, p.enabled, p.config, p.secret_id, p.last_tested_at, p.last_test_ok,
  p.last_test_detail, p.last_test_by, p.version, p.created_at, p.updated_at, lms.user_full_name(p.last_test_by) AS last_test_by_name`;

export async function providerViews(ctx: Ctx, id?: string) {
  const r = await ctx.client.query(`SELECT ${PROVIDER_COLUMNS} FROM iam.auth_provider p ${id ? 'WHERE p.id = $1' : ''} ORDER BY p.kind, p.display_name`,
    id ? [id] : []);
  return r.rows.map(providerView);
}

/** Everything the identity-administration screen shows, filtered by what the
 * viewer may read (row-level security applies to every query as well). */
export async function identityAdminData(ctx: Ctx) {
  const q = async (sql: string, p: unknown[] = []) => (await ctx.client.query(sql, p)).rows;
  const canDecide = ctx.has('users', 'create');
  const canSeeAccounts = ctx.has('users', 'read');
  let origin: string | null = null;
  try { origin = appOrigin(); } catch { origin = null; }

  const local = (await q(`SELECT iam.setting_txt('iam.local_login_enabled', 'true') AS v`))[0].v === 'true';
  const mappings = await q(`SELECT m.id, m.provider_id, p.name AS provider_name, p.display_name AS provider_display_name, m.external_group,
      r.code AS role_code, r.name AS role_name, m.approval_group, m.province_code, pr.name AS province_name
    FROM iam.group_mapping m JOIN iam.auth_provider p ON p.id = m.provider_id
    LEFT JOIN iam.role r ON r.id = m.role_id LEFT JOIN lms.province pr ON pr.code = m.province_code
    ORDER BY p.display_name, m.external_group`);
  // A role a directory group may be mapped to: nothing sensitive, nothing that
  // administers users, roles or identity (the same rule the database enforces).
  const roles = await q(`SELECT r.code, r.name, r.status,
      NOT EXISTS (SELECT 1 FROM iam.role_permission rp JOIN iam.permission p ON p.id = rp.permission_id
                  WHERE rp.role_id = r.id AND (p.is_sensitive OR p.resource IN ('users','roles','identity_settings'))) AS mappable
    FROM iam.role r WHERE r.status <> 'retired' ORDER BY r.name`);
  const requests = canDecide ? await q(`SELECT q.id, q.provider_id, p.name AS provider_name, p.display_name AS provider_display_name, p.kind,
      q.subject, q.email, q.display_name, q.groups, q.status, q.requested_at, q.decided_at, q.decision_note,
      lms.user_full_name(q.decided_by) AS decided_by_name, lms.user_username(q.resulting_user) AS resulting_username
    FROM iam.provisioning_request q JOIN iam.auth_provider p ON p.id = q.provider_id
    ORDER BY (q.status = 'pending') DESC, q.requested_at DESC LIMIT 200`) : [];
  const breakGlass = canSeeAccounts ? await q(`SELECT u.username::text AS username, u.full_name, u.status
    FROM iam.account_security a JOIN lms.app_user u ON u.id = a.user_id WHERE a.is_break_glass ORDER BY u.username`) : [];
  const policy = await q(`SELECT key, value, value_type, description, updated_at FROM lms.system_setting
    WHERE key LIKE 'iam.%' OR key LIKE 'security.%' OR key IN ('workflow.admin_override', 'workflow.sod_mode') ORDER BY key`);

  return {
    canConfigure: ctx.has('identity_settings', 'configure'), canDecide, canSeeAccounts, origin,
    builtIn: { local, passkey: passkeyAvailable() },
    providers: await providerViews(ctx),
    mappings: mappings.map((m) => ({ id: m.id, providerId: m.provider_id, providerName: m.provider_name, providerDisplayName: m.provider_display_name,
      externalGroup: m.external_group, roleCode: m.role_code, roleName: m.role_name, approvalGroup: m.approval_group,
      province: m.province_code, provinceName: m.province_name })),
    roles: roles.map((r) => ({ code: r.code, name: r.name, status: r.status, mappable: r.mappable && r.status === 'active' })),
    approvalGroups: await q('SELECT code, name FROM lms.approval_group ORDER BY display_order'),
    provinces: await q('SELECT code, name FROM lms.province ORDER BY display_order'),
    requests: requests.map((r) => ({ id: r.id, providerId: r.provider_id, providerName: r.provider_name, providerDisplayName: r.provider_display_name,
      kind: r.kind as Kind, subject: r.subject, email: r.email, displayName: r.display_name, groups: r.groups ?? [], status: r.status,
      requestedAt: r.requested_at, decidedAt: r.decided_at, decidedBy: r.decided_by_name, note: r.decision_note, username: r.resulting_username })),
    breakGlass,
    policy,
  };
}
