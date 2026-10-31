import { describe, it, expect, beforeAll } from 'vitest';
import { generate } from 'otplib';
import {
  canChange, compareRoles, deniedChanges, describeRoleEvent, diffPermissions, fingerprint, grantableScopes, groupByResource,
  heldScopes, roleCodeProblem, sameFingerprint, scopeRank, statusTargets, type HistoryRow,
} from '../../src/components/roles/model';

// Role and permission administration (P2): the rules the Roles and Users
// screens share with their API, then the API itself through real sign-in.
//
// "role model" needs nothing running:   npx vitest run tests/iam/roles.test.ts -t "role model"
// "roles API" needs the test server (IAM_TEST_BASE) on lms_iam_test with 0041 and 0044 applied, and the
// fixture passwords (IAM_TEST_PASSWORDS); it fails, rather than skips, when they are missing.

describe('role model', () => {
  it('ranks scopes like iam.permission_rank', () => {
    expect(['global', 'head_office', 'province', 'project', 'assigned', 'nonsense'].map(scopeRank)).toEqual([5, 4, 3, 2, 1, 0]);
  });

  it('keeps the widest scope held for each permission', () => {
    const held = heldScopes([
      { resource: 'cases', action: 'read', scope_level: 'province' },
      { resource: 'cases', action: 'read', scope_level: 'global' },
      { resource: 'cases', action: 'update', scope_level: 'project' },
    ]);
    expect(held).toEqual({ 'cases:read': 'global', 'cases:update': 'project' });
  });

  it('offers only scopes at or below the one held, and nothing that is not held', () => {
    const held = { 'reports:export': 'province' };
    expect(grantableScopes(held, 'reports:export')).toEqual(['province', 'project', 'assigned']);
    expect(grantableScopes(held, 'cases:approve')).toEqual([]);
  });

  it('applies the delegation rule to adding, removing and re-scoping', () => {
    const held = { 'reports:export': 'province' };
    expect(canChange(held, 'reports:export', null, 'province')).toBe(true);
    expect(canChange(held, 'reports:export', null, 'global')).toBe(false);          // above the editor's own scope
    expect(canChange(held, 'reports:export', 'global', 'province')).toBe(false);    // narrowing a wider grant
    expect(canChange(held, 'reports:export', 'global', null)).toBe(false);          // removing a wider grant
    expect(canChange(held, 'reports:export', 'project', null)).toBe(true);
    expect(canChange(held, 'cases:approve', null, 'assigned')).toBe(false);         // not held at all
  });

  it('diffs permission sets and names every change the editor could not make', () => {
    const cur = [{ resource: 'a', action: 'read', scope_level: 'global' }, { resource: 'b', action: 'read', scope_level: 'province' }];
    const next = [{ resource: 'b', action: 'read', scope_level: 'project' }, { resource: 'c', action: 'read', scope_level: 'province' }];
    const d = diffPermissions(cur, next);
    expect(d.added.map((p) => p.resource)).toEqual(['c']);
    expect(d.removed.map((p) => p.resource)).toEqual(['a']);
    expect(d.changed).toEqual([{ resource: 'b', action: 'read', from: 'province', to: 'project' }]);
    expect(deniedChanges({ 'b:read': 'province', 'c:read': 'global' }, d)).toEqual(['a:read (remove Global)']);
    expect(deniedChanges({ 'a:read': 'global', 'b:read': 'province', 'c:read': 'province' }, d)).toEqual([]);
  });

  it('fingerprints a permission set independently of order', () => {
    const a = [{ resource: 'x', action: 'read', scope_level: 'global' }, { resource: 'y', action: 'update', scope_level: 'province' }];
    expect(sameFingerprint(fingerprint(a), fingerprint([...a].reverse()))).toBe(true);
    expect(sameFingerprint(fingerprint(a), fingerprint([a[0]]))).toBe(false);
  });

  it('compares two roles side by side', () => {
    const { rows, counts } = compareRoles(
      [{ resource: 'cases', action: 'read', scope_level: 'province' }, { resource: 'cases', action: 'approve', scope_level: 'province' }],
      [{ resource: 'cases', action: 'read', scope_level: 'global' }, { resource: 'users', action: 'read', scope_level: 'global' }]);
    expect(counts).toEqual({ same: 0, only_a: 1, only_b: 1, scope: 1 });
    expect(rows.find((r) => r.key === 'cases:approve')?.kind).toBe('only_a');
    expect(rows.find((r) => r.key === 'users:read')?.kind).toBe('only_b');
    expect(rows.find((r) => r.key === 'cases:read')).toMatchObject({ a: 'province', b: 'global', kind: 'scope' });
  });

  it('groups by resource in a stable order', () => {
    const g = groupByResource([{ resource: 'z', action: 'b' }, { resource: 'a', action: 'y' }, { resource: 'z', action: 'a' }]);
    expect(g.map(([r, l]) => [r, l.map((x) => x.action)])).toEqual([['a', ['y']], ['z', ['a', 'b']]]);
  });

  it('checks role codes, including the path segments a code may not take', () => {
    expect(roleCodeProblem('field-auditor')).toBeNull();
    expect(roleCodeProblem('Field Auditor')).toMatch(/lower-case/);
    expect(roleCodeProblem('ab')).toMatch(/3 to 31/);
    expect(roleCodeProblem('reviews')).toMatch(/reserved/);
  });

  it('allows only the status changes the lifecycle allows', () => {
    expect(statusTargets('active', false)).toEqual(['inactive', 'retired']);
    expect(statusTargets('inactive', false)).toEqual(['active', 'retired']);
    expect(statusTargets('retired', false)).toEqual([]);
    expect(statusTargets('active', true)).toEqual([]);   // system roles stay active
  });

  it('describes audit rows as readable history', () => {
    const base: HistoryRow = { event_id: 1, occurred_at: '2026-10-30T10:00:00Z', actor_username: 'admin', actor_name: 'Admin', entity: 'role',
      action: 'INSERT', changed_fields: null, old_data: null, new_data: { db_role_code: 'Viewer' }, permission: null, subject_username: null, subject_name: null };
    expect(describeRoleEvent(base)).toBe('Created the role (database tier Viewer).');
    expect(describeRoleEvent({ ...base, action: 'UPDATE', changed_fields: ['status', 'status_reason'],
      old_data: { status: 'active' }, new_data: { status: 'inactive', status_reason: 'audit finding' } })).toBe('Status Active → Suspended: audit finding.');
    expect(describeRoleEvent({ ...base, entity: 'role_permission', permission: 'reports:export', new_data: { scope_level: 'global' } }))
      .toBe('Added reports:export (Global).');
    expect(describeRoleEvent({ ...base, entity: 'role_permission', action: 'UPDATE', permission: 'reports:export',
      old_data: { scope_level: 'global' }, new_data: { scope_level: 'province' } })).toBe('reports:export: scope Global → Province.');
    expect(describeRoleEvent({ ...base, entity: 'user_role', subject_name: 'Land Officer', subject_username: 'lofield',
      new_data: { scope_province: 'SND', expires_at: '2027-01-31T23:59:59+05:00', reason: 'cover' } }))
      .toBe('Assigned to Land Officer (lofield) in SND, until 2027-01-31 — cover.');
    expect(describeRoleEvent({ ...base, entity: 'user_role', action: 'UPDATE', subject_username: 'lofield',
      old_data: { revoked_at: null }, new_data: { revoked_at: '2026-10-30T11:00:00Z', revoke_reason: 'left the project' } }))
      .toBe('Revoked from lofield — left the project.');
  });
});

describe('roles API', () => {
  type ClientMod = typeof import('./client');
  let M: ClientMod;
  let admin: InstanceType<ClientMod['Client']>, audit: InstanceType<ClientMod['Client']>, viewer: InstanceType<ClientMod['Client']>,
      lofield: InstanceType<ClientMod['Client']>;
  const run = Date.now().toString(36).slice(-6);
  const ROLE = `rt-${run}`, BULK = `rt-bulk-${run}`;
  const ids: Record<string, string> = {};
  const accounts = ['admin', 'audit', 'viewer', 'lofield', 'loquetta', 'lopnj', 'mland'];

  async function signIn(user: string) {
    const c = new M.Client();
    const r = await c.login(user);
    expect(r.status, `${user} signs in`).toBe(200);
    const me = await c.get('/api/auth/me');
    if (me.data.mfa?.enrolmentOutstanding) {
      const s = await c.post('/api/auth/mfa/totp/start');
      await c.post('/api/auth/mfa/totp/confirm', { code: await generate({ secret: s.data.secret }) });
    }
    return c;
  }
  const perms = async (c: InstanceType<ClientMod['Client']>) => (await c.get('/api/auth/me')).data.permissions as string[];

  beforeAll(async () => {
    if (!process.env.IAM_TEST_PASSWORDS) throw new Error('roles API tests need IAM_TEST_PASSWORDS and a server on IAM_TEST_BASE');
    M = await import('./client');
    const list = accounts.map((u) => `'${u}'`).join(',');
    M.sql(`UPDATE iam.account_security SET failed_count = 0, locked_until = NULL`);
    M.sql(`DELETE FROM iam.mfa_totp WHERE user_id IN (SELECT id FROM lms.app_user WHERE username IN (${list}));
           DELETE FROM iam.mfa_recovery_code WHERE user_id IN (SELECT id FROM lms.app_user WHERE username IN (${list}))`);
    for (const line of M.sql(`SELECT username || '|' || id FROM lms.app_user WHERE username IN (${list})`).split('\n')) {
      const [u, id] = line.split('|'); ids[u] = id;
    }
    admin = await signIn('admin');
    audit = await signIn('audit');
    viewer = await signIn('viewer');
    lofield = await signIn('lofield');
  });

  it('lists roles with status, tier, member count and system flag', async () => {
    const r = await admin.get('/api/roles');
    expect(r.status).toBe(200);
    const sa = r.data.roles.find((x: any) => x.code === 'system-administrator');
    expect(sa).toMatchObject({ is_system: true, status: 'active', db_role_code: 'Admin' });
    expect(sa.member_count).toBeGreaterThanOrEqual(1);
    expect(r.data.catalogue.length).toBeGreaterThan(20);
    expect(r.data.actor.can).toMatchObject({ create: true, managePermissions: true });
    expect((await lofield.get('/api/roles')).status).toBe(403);
  });

  it('creates a custom role and edits its name and description', async () => {
    const c = await admin.post('/api/roles', { code: ROLE, name: 'Report exporter (test)', description: 'P2 test role', db_role_code: 'Viewer' });
    expect(c.status, JSON.stringify(c.data)).toBe(201);
    expect(c.data.role).toMatchObject({ code: ROLE, status: 'active', is_system: false, member_count: 0 });
    const e = await admin.req('PATCH', `/api/roles/${ROLE}`, { name: 'Report exporter', description: 'Exports reports', version: c.data.role.version });
    expect(e.status, JSON.stringify(e.data)).toBe(200);
    expect(e.data.role).toMatchObject({ name: 'Report exporter', description: 'Exports reports' });
    const stale = await admin.req('PATCH', `/api/roles/${ROLE}`, { name: 'Lost update', version: c.data.role.version });
    expect(stale.status).toBe(409);
    expect((await admin.req('PATCH', '/api/roles/viewer', { name: 'Renamed', version: 1 })).status).toBe(409);   // system role
    expect((await admin.post('/api/roles', { code: BULK, name: 'Bulk test role', db_role_code: 'Viewer' })).status).toBe(201);
  });

  it('refuses malformed, reserved and duplicate codes and the Admin tier', async () => {
    expect((await admin.post('/api/roles', { code: 'Bad Code', name: 'x x x', db_role_code: 'Viewer' })).status).toBe(400);
    expect((await admin.post('/api/roles', { code: 'reviews', name: 'Reviews', db_role_code: 'Viewer' })).status).toBe(400);
    expect((await admin.post('/api/roles', { code: ROLE, name: 'Again', db_role_code: 'Viewer' })).status).toBe(409);
    expect((await admin.post('/api/roles', { code: `rt-adm-${run}`, name: 'Admin tier', db_role_code: 'Admin' })).status).toBe(403);
  });

  it('grants permissions the editor holds and refuses any beyond its own authority', async () => {
    const ok = await admin.req('PUT', `/api/roles/${ROLE}/permissions`, { permissions: [{ resource: 'reports', action: 'export', scope_level: 'global' }], base: [] });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(ok.data.added).toBe(1);
    // A system administrator does not hold cases:approve (a business sign-off).
    const denied = await admin.req('PUT', `/api/roles/${ROLE}/permissions`, {
      permissions: [{ resource: 'reports', action: 'export', scope_level: 'global' }, { resource: 'cases', action: 'approve', scope_level: 'province' }],
      base: ['reports:export@global'] });
    expect(denied.status).toBe(403);
    expect(denied.data.denied.join(' ')).toMatch(/cases:approve/);
    const d = await admin.get(`/api/roles/${ROLE}`);
    expect(d.data.permissions.map((p: any) => `${p.resource}:${p.action}@${p.scope_level}`)).toEqual(['reports:export@global']);
    // A concurrent edit is detected rather than overwritten.
    expect((await admin.req('PUT', `/api/roles/${ROLE}/permissions`, { permissions: [], base: [] })).status).toBe(409);
    // System roles are fixed; unknown permissions are refused.
    expect((await admin.req('PUT', '/api/roles/viewer/permissions', { permissions: [] })).status).toBe(409);
    expect((await admin.req('PUT', `/api/roles/${ROLE}/permissions`, { permissions: [{ resource: 'nope', action: 'read', scope_level: 'global' }] })).status).toBe(400);
  });

  it('suspends and reactivates a role with effect on the member\'s next request, and retires it only without members', async () => {
    const g = await admin.post('/api/users', { action: 'assign_role', user_id: ids.viewer, role_code: ROLE, reason: 'P2 lifecycle test' });
    expect(g.status, JSON.stringify(g.data)).toBe(200);
    expect(await perms(viewer)).toContain('reports:export');
    expect((await admin.post(`/api/roles/${ROLE}/status`, { status: 'inactive', reason: 'x' })).status).toBe(400);   // reason too short
    const s = await admin.post(`/api/roles/${ROLE}/status`, { status: 'inactive', reason: 'suspended by the P2 test' });
    expect(s.status, JSON.stringify(s.data)).toBe(200);
    expect(s.data.role.status).toBe('inactive');
    expect(await perms(viewer)).not.toContain('reports:export');
    expect((await admin.post('/api/users', { action: 'assign_role', user_id: ids.lofield, role_code: ROLE, reason: 'should fail' })).status).toBe(409);
    expect((await admin.post(`/api/roles/${ROLE}/status`, { status: 'active', reason: 'back in service' })).status).toBe(200);
    expect(await perms(viewer)).toContain('reports:export');
    expect((await admin.post(`/api/roles/${ROLE}/status`, { status: 'retired', reason: 'retire with a member' })).status).toBe(409);
    expect((await admin.post('/api/roles/viewer/status', { status: 'inactive', reason: 'system roles stay active' })).status).toBe(409);
  });

  it('refuses a time-limited or province-limited system administrator grant', async () => {
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const r = await admin.post('/api/users', { action: 'assign_role', user_id: ids.lofield, role_code: 'system-administrator', expires_at: future, reason: 'temporary admin' });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/time-limited/);
    expect((await admin.post('/api/users', { action: 'assign_role', user_id: ids.lofield, role_code: 'system-administrator', scope_province: 'SND', reason: 'provincial admin' })).status).toBe(400);
  });

  it('limits an ordinary grant to a province the account has and to a future expiry', async () => {
    const until = new Date(Date.now() + 60 * 86_400_000).toISOString();
    expect((await admin.post('/api/users', { action: 'assign_role', user_id: ids.lofield, role_code: ROLE, scope_province: 'KPK', reason: 'not their province' })).status).toBe(400);
    expect((await admin.post('/api/users', { action: 'assign_role', user_id: ids.lofield, role_code: ROLE, expires_at: '2001-01-01', reason: 'in the past' })).status).toBe(400);
    expect((await admin.post('/api/users', { action: 'assign_role', user_id: ids.lofield, role_code: ROLE, expires_at: 'soon', reason: 'not a date' })).status).toBe(400);
    const ok = await admin.post('/api/users', { action: 'assign_role', user_id: ids.lofield, role_code: ROLE, scope_province: 'SND', expires_at: until, reason: 'P2 scoped grant' });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(M.sql(`SELECT scope_province || '|' || (expires_at IS NOT NULL) FROM iam.user_role WHERE id = '${ok.data.assignment.id}'`)).toBe('SND|true');
    const eff = await admin.get(`/api/users?effective=${ids.lofield}`);
    expect(eff.status).toBe(200);
    const exp = eff.data.permissions.find((p: any) => p.key === 'reports:export');
    expect(exp.grants).toContainEqual(expect.objectContaining({ role: ROLE, scope_province: 'SND' }));
    expect(eff.data.permissions.find((p: any) => p.key === 'cases:create').grants[0].role).toBe('data-entry');
  });

  it('records who changed what in the role\'s history', async () => {
    const h = await admin.get(`/api/roles/${ROLE}/history?limit=200`);
    expect(h.status).toBe(200);
    const text = h.data.events.map((e: any) => e.summary).join('\n');
    expect(text).toMatch(/Created the role/);
    expect(text).toMatch(/Added reports:export \(Global\)/);
    expect(text).toMatch(/Status Active → Suspended: suspended by the P2 test/);
    expect(text).toMatch(/Assigned to .*\(viewer\)/);
    expect(text).toMatch(/in SND, until/);
    expect((await audit.get(`/api/roles/${ROLE}/history`)).status).toBe(200);   // roles:read
    expect((await lofield.get(`/api/roles/${ROLE}/history`)).status).toBe(403);
    // Grants and revocations also reach the security events (UA-04).
    expect(Number(M.sql(`SELECT count(*) FROM audit.auth_event WHERE event_type = 'role_granted' AND metadata ->> 'role' = '${ROLE}'`))).toBeGreaterThanOrEqual(2);
  });

  it('compares two roles from the listing', async () => {
    const roles = (await audit.get('/api/roles')).data.roles;
    const v = roles.find((r: any) => r.code === 'viewer'), s = roles.find((r: any) => r.code === 'security-auditor');
    const cmp = compareRoles(v.permissions, s.permissions);
    expect(cmp.rows.find((r) => r.key === 'users:read')?.kind).toBe('only_b');
    expect(cmp.rows.find((r) => r.key === 'cases:read')?.kind).toBe('scope');   // province vs global
  });

  it('bulk assignment is all or nothing: one refusal rolls every account back', async () => {
    const r = await admin.post('/api/users', { action: 'bulk_assign', role_code: BULK, user_ids: [ids.loquetta, ids.lopnj, ids.admin], reason: 'P2 bulk test' });
    expect(r.status).toBe(409);
    expect(r.data.code).toBe('bulk_failed');
    expect(r.data.errors).toContainEqual(expect.objectContaining({ user_id: ids.admin, error: expect.stringMatching(/yourself/) }));
    expect(M.sql(`SELECT count(*) FROM iam.user_role ur JOIN iam.role r ON r.id = ur.role_id WHERE r.code = '${BULK}'`)).toBe('0');
    const ok = await admin.post('/api/users', { action: 'bulk_assign', role_code: BULK, user_ids: [ids.loquetta, ids.lopnj], reason: 'P2 bulk test' });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(ok.data.assigned).toBe(2);
    const again = await admin.post('/api/users', { action: 'bulk_assign', role_code: BULK, user_ids: [ids.loquetta, ids.mland], reason: 'P2 bulk test' });
    expect(again.status).toBe(409);   // loquetta already holds it
    expect(M.sql(`SELECT count(*) FROM iam.user_role ur JOIN iam.role r ON r.id = ur.role_id WHERE r.code = '${BULK}' AND ur.user_id = '${ids.mland}'`)).toBe('0');
    const rv = await admin.post('/api/users', { action: 'bulk_revoke', role_code: BULK, user_ids: [ids.loquetta, ids.lopnj], reason: 'P2 bulk revoke' });
    expect(rv.status, JSON.stringify(rv.data)).toBe(200);
    expect(rv.data.accounts).toBe(2);
    expect((await admin.post('/api/users', { action: 'bulk_revoke', role_code: BULK, user_ids: [ids.loquetta], reason: 'P2 bulk revoke' })).status).toBe(409);
    expect((await admin.post('/api/users', { action: 'bulk_revoke', role_code: 'system-administrator', user_ids: [ids.admin], reason: 'remove myself' })).status).toBe(409);
  });

  it('refuses changes to your own access', async () => {
    const self = ids.admin;
    expect((await admin.post('/api/users', { action: 'update_user', user_id: self, provinces: ['SND'] })).status).toBe(403);
    expect((await admin.post('/api/users', { action: 'update_user', user_id: self, groups: ['Manager Land (HO)'] })).status).toBe(403);
    expect((await admin.post('/api/users', { action: 'assign_role', user_id: self, role_code: BULK, reason: 'self grant' })).status).toBe(403);
    expect((await admin.post('/api/users', { action: 'set_status', user_id: self, status: 'Suspended', reason: 'self suspend' })).status).toBe(403);
    expect((await admin.post('/api/users', { action: 'issue_token', user_id: self, purpose: 'password_reset' })).status).toBe(403);
    const sa = M.sql(`SELECT ur.id FROM iam.user_role ur JOIN iam.role r ON r.id = ur.role_id WHERE ur.user_id = '${self}' AND r.code = 'system-administrator' AND ur.revoked_at IS NULL LIMIT 1`);
    expect((await admin.post('/api/users', { action: 'revoke_role', assignment_id: sa, reason: 'remove my own admin' })).status).toBe(403);
    // A profile-only edit of your own account is allowed (no provinces or positions sent).
    const name = M.sql(`SELECT full_name FROM lms.app_user WHERE id = '${self}'`);
    expect((await admin.post('/api/users', { action: 'update_user', user_id: self, full_name: name })).status).toBe(200);
  });

  it('gives the security auditor every account and session, read-only', async () => {
    const r = await audit.get('/api/users');
    expect(r.status).toBe(200);
    expect(r.data.users.length).toBeGreaterThan(5);                          // not just its own row (UI-12)
    expect(r.data.actor.canReadSessions).toBe(true);
    expect(r.data.active_sessions.some((s: any) => s.user_id === ids.admin)).toBe(true);
    expect((await audit.get(`/api/users?effective=${ids.lofield}`)).status).toBe(200);
    for (const [path, body] of [
      ['/api/users', { action: 'assign_role', user_id: ids.lofield, role_code: BULK, reason: 'auditor grant' }],
      ['/api/users', { action: 'issue_token', user_id: ids.lofield, purpose: 'password_reset' }],   // UI-15: needs users:update
      ['/api/users', { action: 'anonymise_user', user_id: ids.lofield, reason: 'auditor erasure', confirm: 'lofield' }],
      ['/api/roles', { code: `rt-aud-${run}`, name: 'Auditor role', db_role_code: 'Viewer' }],
      [`/api/roles/${ROLE}/status`, { status: 'inactive', reason: 'auditor suspend' }],
      ['/api/roles/reviews', { note: 'Auditor review' }],
    ] as [string, unknown][]) {
      const x = await audit.post(path, body);
      expect(x.status, `${path} ${JSON.stringify(body)}`).toBe(403);
      expect(x.data.code).toBe('forbidden');
    }
    expect((await audit.req('PUT', `/api/roles/${ROLE}/permissions`, { permissions: [] })).status).toBe(403);
    const lo = await lofield.get('/api/users');
    expect(lo.status).toBe(403);
  });

  it('runs an access review: snapshot, a revoke that applies at once, and close', async () => {
    const start = await admin.post('/api/roles/reviews', { note: `P2 review ${run}`, role_code: ROLE });
    expect(start.status, JSON.stringify(start.data)).toBe(201);
    const detail = await audit.get(`/api/roles/reviews/${start.data.id}`);   // users:read reads it
    expect(detail.status).toBe(200);
    expect(detail.data.can.decide).toBe(false);
    const items: any[] = detail.data.items;
    expect(items.map((i) => i.username).sort()).toEqual(['lofield', 'viewer']);
    const v = items.find((i) => i.username === 'viewer'), l = items.find((i) => i.username === 'lofield');
    expect((await audit.post(`/api/roles/reviews/${start.data.id}`, { action: 'decide', item_id: v.id, decision: 'keep' })).status).toBe(403);
    expect((await admin.post(`/api/roles/reviews/${start.data.id}`, { action: 'close' })).status).toBe(409);   // undecided items
    expect((await admin.post(`/api/roles/reviews/${start.data.id}`, { action: 'decide', item_id: v.id, decision: 'revoke' })).status).toBe(400);
    expect((await admin.post(`/api/roles/reviews/${start.data.id}`, { action: 'decide', item_id: v.id, decision: 'revoke', reason: 'no longer exports' })).status).toBe(200);
    expect(await perms(viewer)).not.toContain('reports:export');
    expect((await admin.post(`/api/roles/reviews/${start.data.id}`, { action: 'decide', item_id: l.id, decision: 'keep', reason: 'still needed' })).status).toBe(200);
    expect((await admin.post(`/api/roles/reviews/${start.data.id}`, { action: 'decide', item_id: l.id, decision: 'keep' })).status).toBe(409);
    expect((await admin.post(`/api/roles/reviews/${start.data.id}`, { action: 'close', note: 'done' })).status).toBe(200);
    const list = await audit.get('/api/roles/reviews');
    expect(list.data.reviews.find((x: any) => x.id === start.data.id)).toMatchObject({ items: 2, open: 0, kept: 1, revoked: 1 });
  });

  it('retires a role once it has no members; a retired role is final', async () => {
    const open = M.sql(`SELECT string_agg(ur.id::text, ',') FROM iam.user_role ur JOIN iam.role r ON r.id = ur.role_id WHERE r.code = '${ROLE}' AND ur.revoked_at IS NULL`);
    for (const id of open.split(',').filter(Boolean))
      expect((await admin.post('/api/users', { action: 'revoke_role', assignment_id: id, reason: 'P2 retire test' })).status).toBe(200);
    const r = await admin.post(`/api/roles/${ROLE}/status`, { status: 'retired', reason: 'no longer needed after the P2 test' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.role.status).toBe('retired');
    expect((await admin.req('PATCH', `/api/roles/${ROLE}`, { name: 'Edit after retire', version: r.data.role.version })).status).toBe(409);
    expect((await admin.post(`/api/roles/${ROLE}/status`, { status: 'active', reason: 'bring it back' })).status).toBe(409);
    expect((await admin.post('/api/users', { action: 'assign_role', user_id: ids.lofield, role_code: ROLE, reason: 'assign retired' })).status).toBe(409);
  });

  it('reaches the account lifecycle routines behind their permissions', async () => {
    const created = await admin.post('/api/users', { action: 'create_user', username: `rt-${run}`, full_name: 'P2 throwaway account',
      provinces: ['SND'], role_codes: ['viewer'], groups: [] });
    expect(created.status, JSON.stringify(created.data)).toBe(200);
    const id = created.data.user_id;
    expect((await admin.post('/api/users', { action: 'anonymise_user', user_id: id, reason: 'erasure request P2', confirm: 'someone-else' })).status).toBe(400);
    expect((await admin.post('/api/users', { action: 'anonymise_user', user_id: id, reason: 'erasure request P2', confirm: `rt-${run}` })).status).toBe(200);
    expect(M.sql(`SELECT username::text LIKE 'anon-%' AND status = 'Deactivated' FROM lms.app_user WHERE id = '${id}'`)).toBe('t');
    // Emergency access needs MFA and a password: the routine says so, which proves it is reachable.
    const glass = await admin.post('/api/users', { action: 'set_break_glass', user_id: id, on: true });
    expect([400, 409]).toContain(glass.status);
    expect((await admin.post('/api/users', { action: 'unlink_identity', identity_id: '00000000-0000-4000-8000-000000000000', reason: 'no such link' })).status).toBe(404);
  });

  it('answers unknown actions with 400 and strangers with 401', async () => {
    expect((await admin.post('/api/users', { action: 'make_me_admin' })).status).toBe(400);
    expect((await admin.post('/api/users', { action: 'constructor' })).status).toBe(400);
    expect((await new M.Client().post('/api/users', { action: 'assign_role' })).status).toBe(401);
    expect((await admin.get('/api/roles/no-such-role')).status).toBe(404);
    expect((await admin.get('/api/roles/reviews/not-a-uuid')).status).toBe(404);
  });

  // Last: it ages the administrator's session.
  it('asks for a recent re-authentication before a privileged change', async () => {
    M.sql(`UPDATE lms.login_session SET started_at = now() - interval '30 minutes', reauth_at = NULL
           WHERE user_id = '${ids.admin}' AND ended_at IS NULL AND expires_at > now()`);   // past iam.reauth_minutes (10 by default)
    expect((await admin.get('/api/roles')).status).toBe(200);       // reading needs no re-authentication
    for (const [path, body] of [
      ['/api/roles', { code: `rt-re-${run}`, name: 'Reauth test', db_role_code: 'Viewer' }],
      ['/api/users', { action: 'assign_role', user_id: ids.lofield, role_code: BULK, reason: 'reauth test' }],
      ['/api/users', { action: 'bulk_assign', role_code: BULK, user_ids: [ids.lofield], reason: 'reauth test' }],
      [`/api/roles/${BULK}/status`, { status: 'inactive', reason: 'reauth test' }],
      ['/api/roles/reviews', { note: 'reauth test review' }],
    ] as [string, unknown][]) {
      const stale = await admin.post(path, body);
      expect(stale.status, path).toBe(403);
      expect(stale.data.code, path).toBe('reauth_required');
    }
    expect((await admin.post('/api/auth/reauth', { password: M.PW.admin })).status).toBe(200);
    expect((await admin.post('/api/roles', { code: `rt-re-${run}`, name: 'Reauth test', db_role_code: 'Viewer' })).status).toBe(201);
  });
});
