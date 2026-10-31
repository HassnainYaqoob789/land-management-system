// Server helpers for the role and user administration routes. (A private
// folder: Next.js does not route anything under _lib.)
import type { PoolClient } from 'pg';
import { protect, json, toResponse, HttpError, type Ctx } from '@/lib/iam/http';
import { isScope, permKey, type RolePerm } from '@/components/roles/model';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PROVINCE_RE = /^[A-Z]{3}$/;
const MAX_BODY = 100_000;

type Gate = { permission: [string, string]; reauth?: boolean };
type RouteCtx = { params: Promise<any> };

/** Read a JSON object body without consuming the request (protect's handler reads it again). */
async function peekBody(req: Request): Promise<Record<string, any> | null> {
  if (Number(req.headers.get('content-length') || 0) > MAX_BODY) return null;
  const stream = req.clone().body;
  if (!stream) return null;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  try {
    const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
  } catch { return null; }
}

/**
 * A mutation whose permission depends on its body (an `action`, a target
 * status …). The gate is chosen from the body, then the request runs under
 * protect() with that permission and a recent re-authentication, so
 * authentication, CSRF, MFA, the permission check (logged when refused) and
 * re-authentication come in protect's order. An unknown body is a 400 for a
 * signed-in user and a 401 for anyone else.
 */
export function gatedMutation(pick: (body: Record<string, any>) => Gate | null, run: (ctx: Ctx) => Promise<Response>) {
  const handlers = new Map<string, ReturnType<typeof protect>>();
  const invalid = protect({ authenticatedOnly: true }, async (ctx) =>
    json({ error: 'The request does not say what to change (a valid action or status is required).', code: 'bad_request', correlationId: ctx.correlationId }, 400));
  return async (req: Request, routeCtx: RouteCtx) => {
    const body = await peekBody(req);
    const gate = body ? pick(body) : null;
    if (!gate) return invalid(req, routeCtx);
    const key = `${gate.permission.join(':')}|${gate.reauth === false ? 'no-reauth' : 'reauth'}`;
    let h = handlers.get(key);
    if (!h) { h = protect({ permission: gate.permission, reauth: gate.reauth !== false }, run); handlers.set(key, h); }
    return h(req, routeCtx);
  };
}

/** The routes' error answer: state conflicts are 409, "no such …" is 404, the rest as toResponse. */
export function fail(e: any, correlationId: string): Response {
  if (!(e instanceof HttpError)) {
    if (e?.code === '55000') return json({ error: e.message, code: 'conflict', correlationId }, 409);
    if (e?.code === 'P0002') return json({ error: e.message, code: 'not_found', correlationId }, 404);
  }
  return toResponse(e, correlationId);
}

/** A database refusal as one line a person can act on, for per-user results of a bulk change. */
export function refusalText(e: any): string {
  const msg: string = typeof e?.message === 'string' ? e.message : '';
  switch (e?.code) {
    case '42501': return /^permission denied for|row-level security/i.test(msg) ? 'You do not have permission to do that.' : msg;
    case '23505': return 'Already holds this role with the same scope.';
    case '23503': return 'Unknown account, role or province.';
    // Our own guards raise these with messages written for people; nothing
    // else in a bulk grant or revocation raises them.
    case '22023': case 'P0001': case 'P0002': case '55000': return msg;
    default: return 'Could not be changed.';
  }
}

/** Trimmed text with a length check, or a 400 naming the field. */
export function text(body: Record<string, any>, key: string, o: { min?: number; max: number; label?: string; optional?: boolean }): string {
  const label = o.label ?? key.replace(/_/g, ' ');
  const v = body[key];
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    if (o.optional) return '';
    throw new HttpError(400, `${label[0].toUpperCase()}${label.slice(1)} is required.`, 'validation');
  }
  if (typeof v !== 'string') throw new HttpError(400, `${label[0].toUpperCase()}${label.slice(1)} must be text.`, 'validation');
  const t = v.trim();
  if (t.length > o.max) throw new HttpError(400, `${label[0].toUpperCase()}${label.slice(1)} is longer than ${o.max} characters.`, 'validation');
  if (o.min && t.length < o.min) throw new HttpError(400, `${label[0].toUpperCase()}${label.slice(1)} needs at least ${o.min} characters.`, 'validation');
  return t;
}

export function uuid(body: Record<string, any>, key: string, label = key.replace(/_/g, ' ')): string {
  const v = body[key];
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new HttpError(400, `A valid ${label} is required.`, 'validation');
  return v.toLowerCase();
}

export interface RoleRow {
  id: string; code: string; name: string; description: string; status: string; status_reason: string | null;
  status_changed_at: string | null; status_changed_by_name: string | null; is_system: boolean; db_role_code: string;
  tier_name: string | null; tier_rank: number | null; version: number; created_at: string; updated_at: string;
  created_by_name: string | null; member_count: number; grantable: boolean;
}

/** Roles as the administration screens show them. `grantable`: the actor could assign it (iam.actor_covers_role). */
export async function roleRows(c: PoolClient, code?: string): Promise<RoleRow[]> {
  const r = await c.query(
    `SELECT r.id, r.code, r.name, r.description, r.status, r.status_reason, r.status_changed_at,
            lms.user_full_name(r.status_changed_by) AS status_changed_by_name, r.is_system, r.db_role_code,
            ar.name AS tier_name, ar.rank AS tier_rank, r.version, r.created_at, r.updated_at,
            lms.user_full_name(r.created_by) AS created_by_name,
            (SELECT count(*)::int FROM iam.user_role ur
              WHERE ur.role_id = r.id AND ur.revoked_at IS NULL AND (ur.expires_at IS NULL OR ur.expires_at > now())) AS member_count,
            iam.actor_covers_role(r.id) AS grantable
     FROM iam.role r LEFT JOIN lms.app_role ar ON ar.code = r.db_role_code
     WHERE $1::text IS NULL OR r.code = $1
     ORDER BY r.is_system DESC, r.name`, [code ?? null]);
  return r.rows;
}

/** A requested permission set, checked for shape, duplicates and against the catalogue. */
export async function parsePermissions(c: PoolClient, raw: unknown): Promise<RolePerm[]> {
  if (!Array.isArray(raw)) throw new HttpError(400, 'permissions must be a list.', 'validation');
  if (raw.length > 300) throw new HttpError(400, 'Too many permissions in one request.', 'validation');
  const out: RolePerm[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    if (!x || typeof x.resource !== 'string' || typeof x.action !== 'string' || !isScope(x.scope_level))
      throw new HttpError(400, 'Each permission needs a resource, an action and a scope (global, head_office, province, project or assigned).', 'validation');
    const k = permKey(x);
    if (seen.has(k)) throw new HttpError(400, `${k} is listed twice.`, 'validation');
    seen.add(k);
    out.push({ resource: x.resource, action: x.action, scope_level: x.scope_level });
  }
  if (out.length) {
    const unknown = await c.query(
      `SELECT x.k FROM unnest($1::text[]) x(k)
       WHERE NOT EXISTS (SELECT 1 FROM iam.permission p WHERE p.resource || ':' || p.action = x.k)`, [out.map(permKey)]);
    if (unknown.rows.length) throw new HttpError(400, `Unknown permission: ${unknown.rows.map((r) => r.k).join(', ')}.`, 'validation');
  }
  return out;
}

/** The actor's database tier, computed as row-level security computes it. */
export async function actorTier(c: PoolClient): Promise<{ code: string | null; rank: number }> {
  const r = await c.query(`SELECT lms.actor_role() AS code, (SELECT rank FROM lms.app_role WHERE code = lms.actor_role()) AS rank`);
  return { code: r.rows[0]?.code ?? null, rank: Number(r.rows[0]?.rank ?? 0) };
}
