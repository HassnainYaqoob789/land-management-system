import { NextResponse } from 'next/server';
import type { PoolClient, QueryResult } from 'pg';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { withActor, withoutActor } from '../db';
import { allowedOrigins } from './config';
import { csrfValid, resolveSession, clientIp, userAgent, type SessionInfo } from './session';

export interface Perm { resource: string; action: string; scope_level: string; scope_province: string | null; scope_project: string | null; role_code: string }
export interface Ctx {
  req: Request; params: any; client: PoolClient; session: SessionInfo; correlationId: string;
  user: { id: string; username: string; fullName: string; email: string | null; dbRole: string };
  roles: string[]; provinces: string[]; perms: Perm[];
  /** Legacy helpers, bound to this request's actor-scoped transaction. */
  db: LegacyDb;
  legacyUser: { id: string; username: string; full_name: string; fullName: string; role_code: string; email: string | null };
  /** Holds the permission at ANY scope. Use for route-level gates. */
  has(resource: string, action: string): boolean;
  /** Holds it for this particular record's scope. */
  can(resource: string, action: string, rec?: { province?: string | null; project?: string | null; assignedTo?: string | null }): boolean;
}
export interface Opts {
  permission?: [string, string];
  /** Any signed-in user; no specific permission (e.g. read your own session). */
  authenticatedOnly?: boolean;
  /** Reachable while MFA enrolment is still outstanding. */
  allowPendingMfa?: boolean;
  /** Reachable while a forced password change is outstanding. */
  allowMustChange?: boolean;
  /** Needs a recent re-authentication. */
  reauth?: boolean;
}

export interface LegacyDb {
  query: (text: string, params?: any[]) => Promise<QueryResult<any>>;
  withTransaction: <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>;
  getClient: () => Promise<PoolClient>;
}

/** The pre-IAM routes call query(), withTransaction() and getClient() as if
 * each opened its own connection. Here they all run inside the request's one
 * actor-scoped transaction, and savepoints keep their old isolation: a failed
 * statement rolls back only itself, and a route's own BEGIN / COMMIT / ROLLBACK
 * become savepoint operations instead of committing the outer transaction early. */
const inLegacyLock = new AsyncLocalStorage<boolean>();

function legacyDb(client: PoolClient): LegacyDb {
  let n = 0;
  // One connection, so savepoints must not interleave: routes that run
  // query() calls concurrently (Promise.all) would otherwise release an outer
  // savepoint and destroy the inner one with it. Calls queue behind each
  // other; a call made from inside a held block runs straight through.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    if (inLegacyLock.getStore()) return fn();
    const run = chain.then(() => inLegacyLock.run(true, fn));
    chain = run.catch(() => {});
    return run;
  };
  const sp = <T>(fn: () => Promise<T>): Promise<T> => serial(async () => {
    const name = `lms_sp_${++n}`;
    await client.query(`SAVEPOINT ${name}`);
    try { const r = await fn(); await client.query(`RELEASE SAVEPOINT ${name}`); return r; }
    catch (e) { await client.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {}); throw e; }
  });
  return {
    query: (text, params) => sp(() => client.query(text, params)),
    withTransaction: (fn) => sp(() => fn(client)),
    getClient: async () => {
      const open: string[] = [];
      const proxy = Object.create(client) as PoolClient;
      (proxy as any).query = async (text: any, params?: any) => {
        const t = typeof text === 'string' ? text.trim().replace(/;$/, '').toUpperCase() : '';
        if (t === 'BEGIN' || t === 'START TRANSACTION') { const nm = `lms_sp_${++n}`; open.push(nm); return client.query(`SAVEPOINT ${nm}`); }
        if (t === 'COMMIT' || t === 'END') { const nm = open.pop(); return nm ? client.query(`RELEASE SAVEPOINT ${nm}`) : { rows: [] }; }
        if (t === 'ROLLBACK') { const nm = open.pop(); return nm ? client.query(`ROLLBACK TO SAVEPOINT ${nm}`) : { rows: [] }; }
        return client.query(text, params);
      };
      (proxy as any).release = () => {};   // the connection belongs to protect()
      return proxy;
    },
  };
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
export const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });

export function sameOrigin(req: Request): boolean {
  // Browsers send Origin on every cross-origin and on same-origin POSTs. Absent
  // Origin on a mutating request is refused: a CSRF form post always carries it.
  const o = req.headers.get('origin');
  if (!o) return false;
  return allowedOrigins().has(o.replace(/\/$/, ''));
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const UUIDS_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NOT_FOUND = 'The record was not found.';

/** Translate a database or application error into a response that is useful
 * to the user without disclosing schema, SQL or stack. A denial is 403, a bad
 * value or id 400, a missing or out-of-scope record 404 (the two are told
 * apart nowhere), a state conflict 409, overload 503; only a real fault is 500. */
export function toResponse(e: any, correlationId: string): NextResponse {
  if (e instanceof HttpError) return json({ error: e.message, code: e.code, correlationId }, e.status);
  const state: string | undefined = e?.code;
  const msg: string = typeof e?.message === 'string' ? e.message : '';
  if (e?.name === 'KmlError') return json({ error: msg, code: 'invalid_file', correlationId }, 400);
  if (e instanceof SyntaxError) return json({ error: 'The request body is not valid JSON.', code: 'bad_request', correlationId }, 400);
  switch (state) {
    case '42501': {
      // Definer routines name the record when it is outside the caller's
      // provinces; answer exactly as for a record that does not exist.
      if (/outside your province access/i.test(msg)) return json({ error: NOT_FOUND, code: 'not_found', correlationId }, 404);
      const leaky = /^permission denied for|row-level security/i.test(msg);
      return json({ error: leaky ? 'You do not have permission to do that.' : msg, code: 'forbidden', correlationId }, 403);
    }
    case '28000': return json({ error: 'You are not permitted to do that.', code: 'forbidden', correlationId }, 403);
    case 'P0002': return json({ error: msg ? msg.replace(UUIDS_IN_TEXT, '(id)') : NOT_FOUND, code: 'not_found', correlationId }, 404);
    case '23502': return json({ error: `A required value is missing: ${String(e.column ?? 'field').replace(/_/g, ' ')}.`, code: 'validation', rule: e.column, correlationId }, 400);
    case '23514': case '22023': case '22007': case '22008': case '22003': case '22001':
      // A routine's own RAISE (no constraint) is written for people; a constraint name is not.
      return json({ error: e.constraint || !msg ? 'The data breaks a validation rule.' : msg, code: 'validation', rule: e.constraint, correlationId }, 400);
    case '22P02': return json({ error: 'A value is not in the expected format.', code: 'validation', correlationId }, 400);
    // P0001 is RAISE EXCEPTION from our own routines: those messages are written for people.
    case 'P0001': return json({ error: msg, code: 'rule', hint: e.hint || undefined, correlationId }, 400);
    case '55000': return json({ error: msg, code: 'state', hint: e.hint || undefined, correlationId }, 409);
    case '23505': return json({ error: e.constraint || !msg ? 'That record already exists.' : msg, code: 'conflict', correlationId }, 409);
    case '23P01': return json({ error: 'That overlaps an existing record for the same period.', code: 'conflict', rule: e.constraint, correlationId }, 409);
    case '40001': case '40P01': return json({ error: 'Someone else changed this at the same moment. Please try again.', code: 'conflict', correlationId }, 409);
    case '23503': return json({ error: 'A referenced record does not exist or is still in use.', code: 'reference', correlationId }, 409);
  }
  // Overload, not a fault: no free database connection in time, or a statement
  // cancelled by statement_timeout. Tell the client to retry rather than "error".
  if (/timeout exceeded when trying to connect/i.test(msg) || state === '57014' || state === '53300') {
    console.warn(`[${correlationId}] busy: ${state ?? ''} ${msg}`);
    return NextResponse.json({ error: 'The system is busy. Please try again in a moment.', code: 'busy', correlationId },
      { status: 503, headers: { 'Retry-After': '5', 'Cache-Control': 'no-store' } });
  }
  console.error(`[${correlationId}] unhandled`, e?.stack || e);
  return json({ error: 'Something went wrong. Quote this reference to support.', code: 'internal', correlationId }, 500);
}

export async function logDenied(session: SessionInfo | null, req: Request, why: string, correlationId: string, extra: object = {}) {
  try {
    await withoutActor((c) => c.query(
      `SELECT iam.log_event('authz_denied','denied',$1,$2,NULL,NULL,NULL,$3,$4,$5,$6,$7)`,
      [session?.userId ?? null, session?.username ?? null, clientIp(req), userAgent(req), session?.sessionId ?? null,
       correlationId, JSON.stringify({ why, method: req.method, path: new URL(req.url).pathname, ...extra })]));
  } catch (e) { console.error('could not record denial', e); }
}

/** MFA is required for an enrolled user, a break-glass session, and whoever the
 * database policy names: iam.mfa_required_for() covers mfa_required_all, the
 * listed roles and any active permission marked is_sensitive (IAMDB-10), so a
 * custom role carrying a sensitive permission cannot skip the second factor.
 * `roles` is kept for existing callers; the policy no longer reads it. */
export async function mfaRequired(c: PoolClient, _roles: string[], session: SessionInfo): Promise<boolean> {
  if (session.mfaEnrolled) return true;
  if (session.authMethod === 'break_glass') return true;
  const r = await c.query('SELECT iam.mfa_required_for($1) AS required', [session.userId]);
  return r.rows[0]?.required !== false;   // NULL (no answer) fails closed
}

/** Refuse unless the session re-authenticated within iam.reauth_minutes (a fresh sign-in counts). */
export async function requireReauth(ctx: { client: PoolClient; session: SessionInfo }): Promise<void> {
  const win = Number((await ctx.client.query(`SELECT iam.setting_num('iam.reauth_minutes',10) AS n`)).rows[0].n);
  const last = ctx.session.reauthAt ?? ctx.session.startedAt;
  if (!(win > 0) || Date.now() - new Date(last).getTime() > win * 60_000)
    throw new HttpError(403, 'Please confirm your identity again to continue.', 'reauth_required');
}

// ---------------------------------------------------------------------------
// Record-level scope (AUTHZ-07). A route gate (`permission`) proves the caller
// holds the permission somewhere; a write or approval on one record must also
// hold it for that record's province, project and assignment. Records are
// read under row-level security, so an invisible record and an out-of-scope
// one get the same 404.
// ---------------------------------------------------------------------------

/** Tables a record id may name, with the columns that carry its project and assignee. Fixed names only. */
const SCOPED: Record<string, { project?: string; assigned?: string; label: string }> = {
  project: { project: 'id', label: 'Project' },
  survey: { label: 'Survey' },
  landowner: { label: 'Landowner' },
  compensation_case: { project: 'project_id', label: 'Compensation case' },
  lease: { project: 'project_id', label: 'Lease' },
  payment_request: { project: 'project_id', label: 'Payment voucher' },
  payment_hold: { project: 'project_id', label: 'Payment hold' },
  mutation: { label: 'Mutation' },
  acquisition: { project: 'project_id', assigned: 'negotiator_id', label: 'Acquisition' },
  row_corridor: { project: 'project_id', label: 'ROW corridor' },
  dbpfc_estimate: { project: 'project_id', label: 'DBPFC estimate' },
  encroachment: { project: 'project_id', label: 'Encroachment' },
  grievance: { project: 'project_id', assigned: 'assigned_to', label: 'Grievance' },
  legal_case: { project: 'project_id', assigned: 'officer_id', label: 'Legal case' },
  land_request: { project: 'project_id', label: 'Land request' },
  budget: { project: 'project_id', label: 'Budget' },
  import_batch: { label: 'Import batch' },
  document: { label: 'Document' },
};
export type ScopedTable = keyof typeof SCOPED;

export interface ScopedRecord { id: string; province: string | null; project: string | null; row: Record<string, any> }

/** Read one record under the caller's row-level security; 400 for a malformed id, 404 when not visible. */
export async function scopeOf(ctx: Pick<Ctx, 'client'>, table: ScopedTable, id: unknown, o: { forUpdate?: boolean } = {}): Promise<ScopedRecord> {
  const t = SCOPED[table];
  if (!t) throw new Error(`scopeOf: unknown table ${String(table)}`);
  if (!isUuid(id)) throw new HttpError(400, `${t.label} id is not valid.`, 'validation');
  const r = await ctx.client.query(`SELECT * FROM lms.${table} WHERE id = $1${o.forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  const row = r.rows[0];
  if (!row) throw new HttpError(404, `${t.label} not found.`, 'not_found');
  return { id, row, province: row.province_code ?? null, project: t.project ? row[t.project] ?? null : null };
}

/**
 * Load a record and require one of `need` for it, at its province, project
 * and assignee. Out of scope answers exactly like "not found".
 */
export async function requireRecord(ctx: Pick<Ctx, 'client' | 'can'>, table: ScopedTable, id: unknown,
                                    need: [string, string] | [string, string][], o: { forUpdate?: boolean } = {}): Promise<ScopedRecord> {
  const rec = await scopeOf(ctx, table, id, o);
  const t = SCOPED[table];
  const alts = (Array.isArray(need[0]) ? need : [need]) as [string, string][];
  const scope = { province: rec.province, project: rec.project, assignedTo: t.assigned ? rec.row[t.assigned] ?? null : null };
  if (!alts.some(([r, a]) => ctx.can(r, a, scope))) throw new HttpError(404, `${t.label} not found.`, 'not_found');
  return rec;
}

/**
 * Ids a client wants to link to a record (parcels, owners, projects): each
 * must be visible to the caller and in `province`. Returns them de-duplicated.
 */
export async function requireLinked(ctx: Pick<Ctx, 'client'>, table: 'survey' | 'landowner' | 'project' | 'compensation_case' | 'lease' | 'row_corridor' | 'admin_unit',
                                    ids: unknown, province: string | null, label: string): Promise<string[]> {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids)) throw new HttpError(400, `${label} ids must be a list.`, 'validation');
  const list = [...new Set(ids.filter((x) => x !== null && x !== undefined && x !== '').map(String))];
  if (list.some((x) => !isUuid(x))) throw new HttpError(400, `A ${label} id is not valid.`, 'validation');
  if (!list.length) return [];
  const r = await ctx.client.query(`SELECT count(*)::int AS n FROM lms.${table} WHERE id = ANY($1::uuid[]) AND province_code = $2`, [list, province]);
  if (r.rows[0].n !== list.length) throw new HttpError(404, `A linked ${label} was not found in this record's province.`, 'not_found');
  return list;
}

/** Wraps a route handler with authentication, origin/CSRF, MFA, permission and
 * an actor-scoped transaction. The handler never sees an unauthenticated or
 * unauthorised request, and every database statement it runs is subject to
 * row-level security as that user. */
export function protect(opts: Opts, handler: (ctx: Ctx) => Promise<NextResponse | Response>) {
  return async (req: Request, routeCtx: { params: Promise<any> }) => {
    const correlationId = randomUUID();
    try {
      const session = await resolveSession(req);
      if (!session) return json({ error: 'Authentication required.', code: 'unauthenticated', correlationId }, 401);

      if (!SAFE.has(req.method)) {
        if (!sameOrigin(req)) { await logDenied(session, req, 'bad_origin', correlationId); return json({ error: 'Cross-origin request refused.', code: 'csrf', correlationId }, 403); }
        if (!csrfValid(session.sessionId, req.headers.get('x-csrf-token'))) { await logDenied(session, req, 'bad_csrf', correlationId); return json({ error: 'Missing or invalid CSRF token.', code: 'csrf', correlationId }, 403); }
      }
      if (session.mustChangePassword && !opts.allowMustChange)
        return json({ error: 'You must change your password before continuing.', code: 'password_change_required', correlationId }, 403);

      const params = routeCtx?.params ? await routeCtx.params : {};
      return await withActor(session.userId, async (client) => {
        const pr = await client.query('SELECT * FROM iam.effective_permissions($1)', [session.userId]);
        const perms: Perm[] = pr.rows;
        const roles = [...new Set(perms.map((p) => p.role_code))];
        // A user with no permission rows still may hold a role with none; ask the roles table.
        const rr = await client.query(`SELECT r.code FROM iam.user_role ur JOIN iam.role r ON r.id = ur.role_id
                                       WHERE ur.user_id = $1 AND ur.revoked_at IS NULL AND (ur.expires_at IS NULL OR ur.expires_at > now())`, [session.userId]);
        for (const x of rr.rows) if (!roles.includes(x.code)) roles.push(x.code);
        const provinces = (await client.query('SELECT province_code FROM lms.app_user_province WHERE user_id = $1', [session.userId])).rows.map((x) => x.province_code);

        if (!session.mfaSatisfiedAt && !opts.allowPendingMfa && (await mfaRequired(client, roles, session)))
          return json({ error: 'Multi-factor authentication is required.', code: 'mfa_required', correlationId }, 403);

        const has = (r: string, a: string) => perms.some((p) => p.resource === r && p.action === a);
        const can: Ctx['can'] = (r, a, rec = {}) => perms.some((p) => {
          if (p.resource !== r || p.action !== a) return false;
          // A grant limited to one province covers a record only when the record is known to be in it.
          if (p.scope_province && rec.province !== undefined && p.scope_province !== rec.province) return false;
          if (p.scope_project && rec.project !== p.scope_project) return false;
          switch (p.scope_level) {
            case 'global': case 'head_office': return true;
            case 'province': return !rec.province || provinces.includes(rec.province);
            case 'project': return !!rec.project && (!p.scope_project || rec.project === p.scope_project);
            case 'assigned': return !!rec.assignedTo && rec.assignedTo === session.userId;
            default: return false;
          }
        });

        if (opts.permission && !has(...opts.permission)) {
          await logDenied(session, req, 'missing_permission', correlationId, { permission: opts.permission.join(':') });
          return json({ error: 'You do not have permission to do that.', code: 'forbidden', correlationId }, 403);
        }
        if (opts.reauth) {
          try { await requireReauth({ client, session }); }
          catch (e) { if (e instanceof HttpError) return json({ error: e.message, code: e.code, correlationId }, e.status); throw e; }
        }

        const legacyUser = { id: session.userId, username: session.username, full_name: session.fullName, fullName: session.fullName,
                             role_code: session.dbRole, email: session.email };
        const res = await handler({ req, params, client, session, correlationId, has, can, perms, roles, provinces,
          db: legacyDb(client), legacyUser,
          user: { id: session.userId, username: session.username, fullName: session.fullName, email: session.email, dbRole: session.dbRole } });
        res.headers.set('Cache-Control', 'no-store');
        return res as NextResponse;
      });
    } catch (e) {
      return toResponse(e, correlationId);
    }
  };
}

export async function readJson(req: Request, max = 100_000): Promise<Record<string, any>> {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > max) throw new HttpError(413, 'Request too large.');
  try { const b = await req.json(); if (b && typeof b === 'object' && !Array.isArray(b)) return b; } catch { /* fallthrough */ }
  throw new HttpError(400, 'A JSON object body is required.');
}
export function str(body: Record<string, any>, key: string, o: { max?: number; min?: number; optional?: boolean } = {}): string {
  const v = body[key];
  if (v === undefined || v === null || v === '') { if (o.optional) return ''; throw new HttpError(400, `${key} is required.`); }
  if (typeof v !== 'string') throw new HttpError(400, `${key} must be text.`);
  if (v.length > (o.max ?? 500)) throw new HttpError(400, `${key} is too long.`);
  if (o.min && v.length < o.min) throw new HttpError(400, `${key} is too short.`);
  return v;
}
