// Role administration rules shared by the Roles and Users screens and their
// API routes: scope ranks, the delegation rule the database enforces, grouping,
// comparison, permission-set diffs and readable history lines. No React and no
// I/O, so the rules are unit-tested directly (tests/iam/roles.test.ts).

export const SCOPES = ['global', 'head_office', 'province', 'project', 'assigned'] as const;
export type Scope = (typeof SCOPES)[number];
export const SCOPE_LABEL: Record<Scope, string> = {
  global: 'Global', head_office: 'Head Office', province: 'Province', project: 'Project', assigned: 'Assigned records',
};
export const isScope = (s: unknown): s is Scope => typeof s === 'string' && (SCOPES as readonly string[]).includes(s);
export const scopeLabel = (s: string | null | undefined) => (isScope(s) ? SCOPE_LABEL[s] : s ?? '—');

/** The ranks of iam.permission_rank(): a wider scope covers every narrower one. */
export function scopeRank(s: string | null | undefined): number {
  switch (s) {
    case 'global': return 5;
    case 'head_office': return 4;
    case 'province': return 3;
    case 'project': return 2;
    case 'assigned': return 1;
    default: return 0;
  }
}

export interface RolePerm { resource: string; action: string; scope_level: string }
export const permKey = (p: { resource: string; action: string }) => `${p.resource}:${p.action}`;

/** The widest scope at which someone holds each permission, from their effective permissions. */
export function heldScopes(perms: { resource: string; action: string; scope_level: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of perms) {
    const k = permKey(p);
    if (scopeRank(p.scope_level) > scopeRank(out[k])) out[k] = p.scope_level;
  }
  return out;
}

/** Scopes at which a permission may be granted: the one held and every narrower one. Empty: not grantable. */
export function grantableScopes(held: Record<string, string>, key: string): Scope[] {
  const have = scopeRank(held[key]);
  return SCOPES.filter((s) => have > 0 && scopeRank(s) <= have);
}

/**
 * The delegation rule (iam.tg_role_permission_guard and 0044's cover trigger):
 * adding, removing or re-scoping a permission in a role needs the actor to hold
 * it at the scope it ends at and the scope it started from. null = absent.
 */
export function canChange(held: Record<string, string>, key: string, from: string | null, to: string | null): boolean {
  const have = scopeRank(held[key]);
  if (have === 0) return false;
  return (from === null || have >= scopeRank(from)) && (to === null || have >= scopeRank(to));
}

export function groupByResource<T extends { resource: string; action: string }>(items: T[]): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const list = m.get(it.resource);
    if (list) list.push(it); else m.set(it.resource, [it]);
  }
  return [...m.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([r, list]) => [r, [...list].sort((x, y) => x.action.localeCompare(y.action))] as [string, T[]]);
}

/** A stable description of a permission set, used to detect a concurrent edit. */
export function fingerprint(perms: RolePerm[]): string[] {
  return perms.map((p) => `${permKey(p)}@${p.scope_level}`).sort();
}
export const sameFingerprint = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export interface PermChange { resource: string; action: string; from: string; to: string }
export interface PermDiff { added: RolePerm[]; removed: RolePerm[]; changed: PermChange[] }

export function diffPermissions(current: RolePerm[], next: RolePerm[]): PermDiff {
  const cur = new Map(current.map((p) => [permKey(p), p]));
  const nxt = new Map(next.map((p) => [permKey(p), p]));
  const added: RolePerm[] = [], removed: RolePerm[] = [], changed: PermChange[] = [];
  for (const [k, p] of nxt) {
    const c = cur.get(k);
    if (!c) added.push(p);
    else if (c.scope_level !== p.scope_level) changed.push({ resource: p.resource, action: p.action, from: c.scope_level, to: p.scope_level });
  }
  for (const [k, p] of cur) if (!nxt.has(k)) removed.push(p);
  return { added, removed, changed };
}

/** Every change in a diff the actor could not make, as resource:action labels. */
export function deniedChanges(held: Record<string, string>, d: PermDiff): string[] {
  const out: string[] = [];
  for (const p of d.added) if (!canChange(held, permKey(p), null, p.scope_level)) out.push(`${permKey(p)} (${scopeLabel(p.scope_level)})`);
  for (const p of d.removed) if (!canChange(held, permKey(p), p.scope_level, null)) out.push(`${permKey(p)} (remove ${scopeLabel(p.scope_level)})`);
  for (const c of d.changed) if (!canChange(held, permKey(c), c.from, c.to)) out.push(`${permKey(c)} (${scopeLabel(c.from)} → ${scopeLabel(c.to)})`);
  return out;
}

export type CompareKind = 'same' | 'only_a' | 'only_b' | 'scope';
export interface CompareRow { key: string; resource: string; action: string; a: string | null; b: string | null; kind: CompareKind }

/** Two roles side by side: every permission either holds, and how they differ. */
export function compareRoles(a: RolePerm[], b: RolePerm[]): { rows: CompareRow[]; counts: Record<CompareKind, number> } {
  const ma = new Map(a.map((p) => [permKey(p), p.scope_level]));
  const mb = new Map(b.map((p) => [permKey(p), p.scope_level]));
  const keys = [...new Set([...ma.keys(), ...mb.keys()])].sort();
  const counts: Record<CompareKind, number> = { same: 0, only_a: 0, only_b: 0, scope: 0 };
  const rows = keys.map((key) => {
    const [resource, action] = key.split(':');
    const sa = ma.get(key) ?? null, sb = mb.get(key) ?? null;
    const kind: CompareKind = sa === null ? 'only_b' : sb === null ? 'only_a' : sa === sb ? 'same' : 'scope';
    counts[kind]++;
    return { key, resource, action, a: sa, b: sb, kind };
  });
  return { rows, counts };
}

// ---- role codes and status ---------------------------------------------------
export const ROLE_CODE_RE = /^[a-z][a-z0-9-]{2,30}$/;
/** Path segments under /api/roles and /roles that a role code may not take. */
export const RESERVED_ROLE_CODES = ['reviews', 'compare', 'new', 'history', 'permissions', 'status'];

export function roleCodeProblem(code: unknown): string | null {
  if (typeof code !== 'string' || !ROLE_CODE_RE.test(code))
    return 'The code must be 3 to 31 characters: lower-case letters, digits and hyphens, starting with a letter.';
  if (RESERVED_ROLE_CODES.includes(code)) return `“${code}” is reserved; choose another code.`;
  return null;
}

export type RoleStatus = 'active' | 'inactive' | 'retired';
export const STATUS_LABEL: Record<RoleStatus, string> = { active: 'Active', inactive: 'Suspended', retired: 'Retired' };
/** Where a role may go from its current status (retired is terminal; system roles stay active). */
export function statusTargets(status: string, isSystem: boolean): RoleStatus[] {
  if (isSystem) return [];
  if (status === 'active') return ['inactive', 'retired'];
  if (status === 'inactive') return ['active', 'retired'];
  return [];
}

// ---- history -----------------------------------------------------------------
export interface HistoryRow {
  event_id: string | number; occurred_at: string; actor_username: string | null; actor_name: string | null;
  entity: string; action: string; changed_fields: string[] | null;
  old_data: Record<string, any> | null; new_data: Record<string, any> | null;
  permission: string | null; subject_username: string | null; subject_name: string | null;
}

const day = (v: unknown) => (typeof v === 'string' && v.length >= 10 ? v.slice(0, 10) : String(v ?? ''));

/** One readable line for an audit row of iam.role, iam.role_permission or iam.user_role. */
export function describeRoleEvent(e: HistoryRow): string {
  const o = e.old_data ?? {}, n = e.new_data ?? {};
  if (e.entity === 'role') {
    if (e.action === 'INSERT') return `Created the role (database tier ${n.db_role_code ?? '—'}).`;
    if (e.action === 'DELETE') return 'Deleted the role.';
    const parts: string[] = [];
    const f = new Set(e.changed_fields ?? []);
    if (f.has('status')) {
      const label = (s: string) => STATUS_LABEL[s as RoleStatus] ?? s;
      parts.push(`Status ${label(o.status)} → ${label(n.status)}${n.status_reason ? `: ${n.status_reason}` : ''}`);
    }
    if (f.has('name')) parts.push(`Renamed “${o.name}” → “${n.name}”`);
    if (f.has('description')) parts.push('Description changed');
    if (f.has('db_role_code')) parts.push(`Database tier ${o.db_role_code} → ${n.db_role_code}`);
    const other = [...f].filter((x) => !['status', 'status_reason', 'status_changed_at', 'status_changed_by', 'name', 'description', 'db_role_code'].includes(x));
    if (other.length) parts.push(`Changed ${other.join(', ')}`);
    return (parts.join('; ') || 'Updated the role') + '.';
  }
  if (e.entity === 'role_permission') {
    const perm = e.permission ?? 'a permission';
    if (e.action === 'INSERT') return `Added ${perm} (${scopeLabel(n.scope_level)}).`;
    if (e.action === 'DELETE') return `Removed ${perm} (${scopeLabel(o.scope_level)}).`;
    return `${perm}: scope ${scopeLabel(o.scope_level)} → ${scopeLabel(n.scope_level)}.`;
  }
  if (e.entity === 'user_role') {
    const who = e.subject_name ? `${e.subject_name}${e.subject_username ? ` (${e.subject_username})` : ''}` : e.subject_username ?? 'a user';
    if (e.action === 'INSERT') {
      return `Assigned to ${who}${n.scope_province ? ` in ${n.scope_province}` : ''}${n.expires_at ? `, until ${day(n.expires_at)}` : ''}`
        + `${n.reason ? ` — ${n.reason}` : ''}.`;
    }
    if (e.action === 'UPDATE' && n.revoked_at && !o.revoked_at) {
      return `Revoked from ${who}${n.revoke_reason ? ` — ${n.revoke_reason}` : ''}.`;
    }
    return `Assignment of ${who} changed.`;
  }
  return `${e.entity} ${e.action.toLowerCase()}.`;
}
