import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { generate } from 'otplib';
import { Client, sql } from '../iam/client';

// The route-level permission matrix (package P1b). One row per API route and
// method: what it needs. For every seeded user the test asks /api/auth/me what
// the user holds, then calls each route: a user without the permission must
// get 403 `forbidden`; a user with it must get anything but 403, and nothing
// may ever be a 500. Write calls carry bodies that pass the gate and then fail
// validation (or name a record that does not exist), so the matrix changes no
// data. `need` lists alternatives (any one is enough); null = any signed-in user.
type Row = { method: 'GET' | 'POST' | 'PUT'; path: string; body?: unknown; need: string[] | null };
const ID = randomUUID();   // a record id that does not exist

const MATRIX: Row[] = [
  // Registers: reads.
  ...([
    ['/api/projects', 'projects:read'], ['/api/landowners', 'landowners:read'], ['/api/surveys', 'surveys:read'],
    ['/api/cases', 'cases:read'], ['/api/leases', 'leases:read'], ['/api/payments', 'payments:read'],
    ['/api/payments?view=releases', 'payments:read'], ['/api/payments?view=holds', 'payments:read'],
    ['/api/dbpfc', 'dbpfc:read'], ['/api/rows', 'rows:read'], ['/api/gis', 'gis:read'], ['/api/gis/kml', 'gis:read'],
    ['/api/gis/kml/merge', 'gis:read'], ['/api/requests', 'requests:read'], ['/api/audit', 'audit_logs:read'],
    ['/api/acquisitions', 'acquisitions:read'], ['/api/mutations', 'mutations:read'], ['/api/legal', 'legal:read'],
    ['/api/budgets', 'budgets:read'], ['/api/grievances', 'grievances:read'], ['/api/encroachments', 'encroachments:read'],
    ['/api/documents', 'documents:read'], ['/api/import', 'import:read'],
    // A record that does not exist: 404 for whoever may read the register, 403 for anyone else.
    [`/api/landowners?id=${ID}`, 'landowners:read'], [`/api/landowners?statement_for=${ID}`, 'landowners:read'],
    [`/api/surveys?id=${ID}`, 'surveys:read'], [`/api/cases?id=${ID}`, 'cases:read'], [`/api/leases?id=${ID}`, 'leases:read'],
    [`/api/mutations?id=${ID}`, 'mutations:read'], [`/api/legal?id=${ID}`, 'legal:read'], [`/api/projects?id=${ID}`, 'projects:read'],
    [`/api/requests?id=${ID}`, 'requests:read'], [`/api/import?id=${ID}`, 'import:read'], [`/api/documents?download=${ID}`, 'documents:read'],
    // Other packages' read-only routes.
    ['/api/users', 'users:read'], ['/api/settings', 'settings:read'], ['/api/analytics/kpis', 'reports:read'],
  ] as [string, string][]).map(([path, need]): Row => ({ method: 'GET', path, need: [need] })),
  // Any signed-in user: sections inside are filtered by permission.
  { method: 'GET', path: '/api/inbox', need: null }, { method: 'GET', path: '/api/calendar', need: null },
  { method: 'GET', path: '/api/provinces', need: null }, { method: 'GET', path: '/api/provinces?units=true', need: null },
  { method: 'GET', path: '/api/reference', need: null },

  // Creates (empty bodies: refused by validation after the gate).
  ...([
    ['/api/projects', 'projects:create'], ['/api/landowners', 'landowners:create'], ['/api/surveys', 'surveys:create'],
    ['/api/cases', 'cases:create'], ['/api/leases', 'leases:create'], ['/api/mutations', 'mutations:create'],
    ['/api/legal', 'legal:create'], ['/api/rows', 'rows:create'], ['/api/dbpfc', 'dbpfc:create'],
    ['/api/acquisitions', 'acquisitions:create'], ['/api/encroachments', 'encroachments:create'],
    ['/api/grievances', 'grievances:create'], ['/api/budgets', 'budgets:create'], ['/api/requests', 'requests:create'],
    ['/api/import', 'import:create'], ['/api/documents', 'documents:create'], ['/api/gis/kml', 'gis:create'],
    ['/api/gis/kml/merge', 'gis:create'],
  ] as [string, string][]).map(([path, need]): Row => ({ method: 'POST', path, body: {}, need: [need] })),

  // Updates (no id: refused by validation after the gate).
  ...([
    ['/api/projects', 'projects:update'], ['/api/landowners', 'landowners:update'], ['/api/surveys', 'surveys:update'],
    ['/api/cases', 'cases:update'], ['/api/leases', 'leases:update'], ['/api/mutations', 'mutations:update'],
    ['/api/legal', 'legal:update'], ['/api/rows', 'rows:update'], ['/api/dbpfc', 'dbpfc:update'],
    ['/api/acquisitions', 'acquisitions:update'], ['/api/encroachments', 'encroachments:update'],
    ['/api/grievances', 'grievances:update'], ['/api/budgets', 'budgets:update'], ['/api/documents', 'documents:read'],
  ] as [string, string][]).map(([path, need]): Row => ({ method: 'PUT', path, body: {}, need: [need] })),
  { method: 'PUT', path: '/api/documents', body: { id: ID, action: 'delete' }, need: ['documents:update'] },

  // Payments: one gate per action.
  { method: 'POST', path: '/api/payments', body: { action: 'request' }, need: ['payments:create'] },
  { method: 'POST', path: '/api/payments', body: { action: 'allocate' }, need: ['payments:create', 'payments:verify'] },
  { method: 'POST', path: '/api/payments', body: { action: 'verify' }, need: ['payments:verify'] },
  { method: 'POST', path: '/api/payments', body: { action: 'release' }, need: ['payments:release'] },
  { method: 'POST', path: '/api/payments', body: { action: 'receipt' }, need: ['payments:verify', 'payments:release'] },
  { method: 'POST', path: '/api/payments', body: { action: 'hold' }, need: ['payments:verify', 'payments:release'] },
  { method: 'POST', path: '/api/payments', body: { action: 'lift_hold' }, need: ['payments:verify', 'payments:release'] },
  { method: 'POST', path: '/api/payments', body: { action: 'reconcile', project_id: 'not-a-uuid' }, need: ['payments:verify', 'payments:release'] },

  // Workflow and record actions on a record that does not exist.
  { method: 'POST', path: `/api/cases/${ID}/transition`, body: { to_stage: 'Checked' }, need: ['cases:approve'] },
  { method: 'PUT', path: '/api/cases', body: { id: ID, action: 'transition', to_stage: 'Checked' }, need: ['cases:approve'] },
  { method: 'POST', path: `/api/leases/${ID}/hold`, body: { action: 'HOLD', reason: 'matrix probe' }, need: ['leases:update'] },
  { method: 'POST', path: `/api/leases/${ID}/renew`, body: {}, need: ['leases:update'] },
  { method: 'POST', path: `/api/requests/${ID}/transition`, body: { action: 'APPROVE', comment: '' }, need: ['requests:approve', 'requests:create'] },
  { method: 'POST', path: '/api/import', body: { action: 'validate' }, need: ['import:update'] },
  { method: 'POST', path: '/api/import', body: { action: 'promote' }, need: ['import:update'] },
  { method: 'POST', path: '/api/inbox', body: { action: 'not-an-action' }, need: null },
];

const USERS = ['admin', 'mland', 'finance', 'lofield', 'loquetta', 'nego', 'legal', 'sradmin', 'dmfield', 'viewer', 'audit'];

async function signIn(user: string): Promise<{ c: Client; perms: string[] }> {
  const c = new Client();
  const r = await c.login(user);
  expect(r.status, `${user} signs in`).toBe(200);
  let me = await c.get('/api/auth/me');
  if (me.data.mfa?.enrolmentOutstanding) {
    const s = await c.post('/api/auth/mfa/totp/start');
    await c.post('/api/auth/mfa/totp/confirm', { code: await generate({ secret: s.data.secret }) });
    me = await c.get('/api/auth/me');
  }
  return { c, perms: me.data.permissions };
}

beforeAll(() => {
  // Each user signs in fresh and enrols MFA if the policy asks for it (0041: every
  // holder of a sensitive permission), so the matrix sees permissions, not MFA prompts.
  const list = USERS.map((u) => `'${u}'`).join(',');
  sql(`UPDATE iam.account_security SET failed_count = 0, locked_until = NULL`);
  sql(`DELETE FROM iam.mfa_totp WHERE user_id IN (SELECT id FROM lms.app_user WHERE username IN (${list}));
       DELETE FROM iam.mfa_recovery_code WHERE user_id IN (SELECT id FROM lms.app_user WHERE username IN (${list}))`);
});

it('the matrix covers each route once per method and body', () => {
  const keys = MATRIX.map((r) => `${r.method} ${r.path} ${JSON.stringify(r.body ?? null)}`);
  expect(new Set(keys).size).toBe(keys.length);
});

for (const user of USERS) {
  describe(`route permissions as ${user}`, () => {
    let c: Client; let perms: string[] = [];
    beforeAll(async () => { ({ c, perms } = await signIn(user)); });
    for (const row of MATRIX) {
      it(`${row.method} ${row.path} ${row.body ? JSON.stringify(row.body) : ''}`, async () => {
        const r = await c.req(row.method, row.path, row.body);
        const allowed = row.need === null || row.need.some((p) => perms.includes(p));
        const detail = `${user} ${row.method} ${row.path} → ${r.status} ${JSON.stringify(r.data).slice(0, 240)}`;
        expect(r.status, detail).not.toBe(500);
        expect(r.status, detail).toBeLessThan(500);
        if (allowed) expect(r.status, detail).not.toBe(403);
        else {
          expect(r.status, detail).toBe(403);
          expect(r.data?.code, detail).toBe('forbidden');
        }
      });
    }
  });
}
