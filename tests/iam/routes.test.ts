import { describe, it, expect, beforeAll } from 'vitest';
import { generate } from 'otplib';
import { Client, sql } from './client';

// Every data route, as several roles. A route must answer 200 when the role
// holds its read permission and 403 when it does not — never 500. This is the
// regression net for the conversion to protect() and for migration 0029's
// narrower grants.
// Each route and every permission it needs ('' = any signed-in account).
const ROUTES: [string, string | string[]][] = [
  ['/api/projects', 'projects:read'], ['/api/landowners', 'landowners:read'], ['/api/surveys', 'surveys:read'],
  ['/api/cases', 'cases:read'], ['/api/leases', 'leases:read'], ['/api/payments', 'payments:read'],
  ['/api/dbpfc', 'dbpfc:read'], ['/api/rows', 'rows:read'], ['/api/gis', 'gis:read'], ['/api/gis/kml', 'gis:read'],
  ['/api/gis/kml/merge', 'gis:read'], ['/api/requests', 'requests:read'], ['/api/audit', 'audit_logs:read'],
  ['/api/analytics/kpis', 'reports:read'],
  // The default report (Executive summary by province) also needs the registers it reads.
  ['/api/analytics/reports', ['reports:read', 'surveys:read', 'cases:read', 'payments:read']],
  ['/api/acquisitions', 'acquisitions:read'], ['/api/mutations', 'mutations:read'], ['/api/legal', 'legal:read'],
  ['/api/budgets', 'budgets:read'], ['/api/grievances', 'grievances:read'], ['/api/encroachments', 'encroachments:read'],
  ['/api/documents', 'documents:read'], ['/api/import', 'import:read'],
  // Everyone gets their own notifications; the approval queue inside needs inbox:read.
  ['/api/inbox', ''],
  ['/api/users', 'users:read'], ['/api/settings', 'settings:read'],
  ['/api/units', ''], ['/api/provinces', ''],
];

async function signIn(user: string): Promise<{ c: Client; perms: string[] }> {
  const c = new Client();
  const r = await c.login(user);
  expect(r.status).toBe(200);
  let me = await c.get('/api/auth/me');
  if (me.data.mfa?.enrolmentOutstanding) {
    const s = await c.post('/api/auth/mfa/totp/start');
    await c.post('/api/auth/mfa/totp/confirm', { code: await generate({ secret: s.data.secret }) });
    me = await c.get('/api/auth/me');
  }
  return { c, perms: me.data.permissions };
}

beforeAll(() => {
  sql(`UPDATE iam.account_security SET failed_count = 0, locked_until = NULL`);
  // Every fixture account may need MFA (0041: sensitive permissions), and other test files
  // enrol some (e.g. lofield); start each file from no authenticator at all.
  sql(`DELETE FROM iam.mfa_totp WHERE user_id IN (SELECT id FROM lms.app_user WHERE NOT is_service_account);
       DELETE FROM iam.mfa_recovery_code WHERE user_id IN (SELECT id FROM lms.app_user WHERE NOT is_service_account)`);
});

for (const user of ['admin', 'mland', 'finance', 'lofield', 'loquetta', 'viewer', 'audit']) {
  describe(`every data route as ${user}`, () => {
    let c: Client; let perms: string[] = [];
    beforeAll(async () => { ({ c, perms } = await signIn(user)); });
    for (const [path, perm] of ROUTES) {
      it(`${path}`, async () => {
        const r = await c.get(path);
        const need = (Array.isArray(perm) ? perm : [perm]).filter(Boolean);
        const expected = need.every((p) => perms.includes(p)) ? 200 : 403;
        if (r.status !== expected) console.error(user, path, r.status, JSON.stringify(r.data).slice(0, 300));
        expect(r.status).toBe(expected);
      });
    }
  });
}
