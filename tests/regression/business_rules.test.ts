import { describe, it, expect, beforeAll } from 'vitest';
import { generate } from 'otplib';
import { Client, sql } from '../iam/client';

// The business rules asserted by tests/integration/api_security.test.js and
// tests/security/vapt_scanner.test.js, re-run through real sign-in. Those files
// sign in with a username alone and read data anonymously, which the IAM build
// refuses, so their rule checks never reach the rule. Here each step runs as
// the least-privileged role that holds the permission, and steps that the
// separation-of-duties rules split (create, verify, release) use different people.

async function signIn(user: string): Promise<Client> {
  const c = new Client();
  expect((await c.login(user)).status).toBe(200);
  const me = await c.get('/api/auth/me');
  if (me.data.mfa?.enrolmentOutstanding) {
    const s = await c.post('/api/auth/mfa/totp/start');
    await c.post('/api/auth/mfa/totp/confirm', { code: await generate({ secret: s.data.secret }) });
  }
  return c;
}

const SQLI = [
  "' OR '1'='1", "'; DROP TABLE lms.project; --", "' UNION SELECT null, null, null, null--",
  "1' AND 1=cast((SELECT table_name FROM information_schema.tables LIMIT 1) as int)--", "admin'--", '" OR ""="',
];
const LEAKS = /syntax error at or near|unterminated quoted string|PG::|psycopg2|at Object\.|node_modules/i;

let lofield: Client, finance: Client, mland: Client, viewer: Client, auditor: Client;

beforeAll(async () => {
  sql(`UPDATE iam.account_security SET failed_count = 0, locked_until = NULL`);
  // Every fixture account may need MFA (0041: sensitive permissions), and other test files
  // enrol some (e.g. lofield); start each file from no authenticator at all.
  sql(`DELETE FROM iam.mfa_totp WHERE user_id IN (SELECT id FROM lms.app_user WHERE NOT is_service_account);
       DELETE FROM iam.mfa_recovery_code WHERE user_id IN (SELECT id FROM lms.app_user WHERE NOT is_service_account)`);
  [lofield, finance, mland, viewer, auditor] = await Promise.all(['lofield', 'finance', 'mland', 'viewer', 'audit'].map(signIn));
});

describe('case rules', () => {
  it('refuses a compensation case for a deceased landowner without succession', async () => {
    const owners = await lofield.get('/api/landowners');
    const deceased = owners.data.landowners.find((l: any) => l.is_deceased);
    expect(deceased, 'fixture has a deceased landowner').toBeTruthy();
    const projects = await lofield.get('/api/projects');
    const r = await lofield.post('/api/cases', {
      project_id: projects.data.projects[0].project_id, land_use_code: 'Well Location',
      case_remarks: 'Case on a deceased owner without legal mutation',
      owners: [{ landowner_id: deceased.id, share_pct: 100 }],
    });
    expect(r.status).toBe(400);
    expect(r.data.error.toLowerCase()).toContain('deceased');
  });

  it('refuses a field approval by a data-entry officer', async () => {
    const cases = await lofield.get('/api/cases');
    const target = cases.data.cases.find((c: any) => c.stage_code === 'Prepared') ?? cases.data.cases[0];
    expect(target?.case_id, 'fixture has a case').toBeTruthy();
    const r = await lofield.post(`/api/cases/${target.case_id}/transition`, { to_stage: 'Field Approved', note: 'Self-approval attempt' });
    expect([400, 403]).toContain(r.status);
    expect(r.data.error).toBeTruthy();
  });
});

describe('payment rules', () => {
  it('refuses release to a landowner under a court stay order', async () => {
    // Lists are paged now, so find the fixture's held landowner and their open voucher directly.
    const heldId = sql(`SELECT landowner_id FROM api.v_landowner_summary WHERE is_on_hold ORDER BY landowner_code LIMIT 1`);
    expect(heldId, 'fixture has a landowner on hold').toBeTruthy();
    const held = (await finance.get(`/api/landowners?statement_for=${heldId}`)).data.landowner;
    expect(held?.is_on_hold, 'the API reports the hold').toBe(true);
    let id: string | undefined = sql(`SELECT id FROM lms.payment_request WHERE landowner_id = '${heldId}' AND stage_code NOT IN ('Released','Cancelled') LIMIT 1`) || undefined;
    if (!id) {
      const projects = await lofield.get('/api/projects');
      const req = await lofield.post('/api/payments', {
        action: 'request', project_id: projects.data.projects[0].project_id, landowner_id: held.id,
        gross_amount: 300000, category: 'Tree Compensation', pay_type: 'One-time', period_from: '2026-10-01',
        payment_mode: 'Cross Cheque', land_class: 'Private', idempotency_key: `regression-hold-${Date.now()}`,
      });
      expect(req.status, JSON.stringify(req.data)).toBe(200);
      id = req.data.payment_id;
    }
    // The hold is enforced from verification onwards, so whichever step meets it
    // first must refuse with the stay order named, and the money must not move.
    const v = await finance.post('/api/payments', { action: 'verify', payment_id: id });
    const r = await mland.post('/api/payments', { action: 'release', payment_id: id, cheque_date: '2026-10-28' });
    expect(r.status).toBe(400);
    const refusal = v.status === 200 ? r : v;
    expect(refusal.status).toBe(400);
    expect(refusal.data.error).toMatch(/hold/i);
    expect(refusal.data.error).toMatch(/stay order/i);
    expect(sql(`SELECT stage_code FROM lms.payment_request WHERE id = '${id}'`)).not.toBe('Released');
  });
});

describe('lease rules', () => {
  it('refuses renewal of a lease on hold', async () => {
    const leases = await mland.get('/api/leases');
    expect(leases.data.leases.length).toBeGreaterThan(0);
    const id = leases.data.leases[0].lease_id;
    const hold = await mland.post(`/api/leases/${id}/hold`, { action: 'HOLD', reason: 'Disputed title: Revenue Court Case 2026-HC' });
    expect(hold.status, JSON.stringify(hold.data)).toBe(200);
    try {
      const r = await mland.post(`/api/leases/${id}/renew`, { additional_years: 1 });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      expect(String(r.data.error).toLowerCase()).toContain('hold');
    } finally {
      await mland.post(`/api/leases/${id}/hold`, { action: 'RELEASE', reason: 'Court stay vacated and title certified' });
    }
  });
});

describe('workflow decisions', () => {
  it('require an audit comment', async () => {
    const r = await mland.post('/api/requests/00000000-0000-0000-0000-000000000001/transition', { action: 'APPROVE', comment: '' });
    expect(r.status).toBe(400);
    expect(r.data.error.toLowerCase()).toContain('comment');
  });

  it('never echo script payloads back', async () => {
    for (const p of ["<script>alert('xss')</script>", '<img src=x onerror=alert(1)>', '<svg onload=alert(document.cookie)>', 'javascript:alert(1)']) {
      const r = await mland.post('/api/requests/00000000-0000-0000-0000-000000000001/transition', { action: 'APPROVE', comment: p });
      expect(r.status).toBeLessThan(500);
      expect(JSON.stringify(r.data)).not.toMatch(/<script>alert|onerror=alert|onload=alert/i);
    }
  });
});

describe('injection resilience, signed in', () => {
  const endpoints = ['/api/cases?province=', '/api/cases?stage=', '/api/leases?province=', '/api/surveys?province=',
    '/api/landowners?province=', '/api/landowners?search=', '/api/requests?province=', '/api/requests?stage=',
    '/api/projects?province=', '/api/payments?province='];
  for (const e of endpoints) {
    it(e, async () => {
      for (const p of SQLI) {
        // A read-only account that may read every register listed (since 0047 the analyst
        // `viewer` does not read landowners or land requests; the security auditor does).
        const r = await auditor.get(e + encodeURIComponent(p));
        expect([200, 400], `${e}${p} -> ${r.status}`).toContain(r.status);
        expect(JSON.stringify(r.data)).not.toMatch(LEAKS);
      }
    });
  }

  it('sign-in inputs', async () => {
    const c = new Client();
    for (const p of SQLI) {
      const r = await c.post('/api/auth/login', { username: p, password: 'not-a-password' });
      expect([400, 401]).toContain(r.status);
      expect(r.data.user).toBeUndefined();
      expect(c.cookies.size).toBe(0);
    }
  });
});

describe('analytics and GIS, as a role that holds reports:read and gis:read', () => {
  it('unit catalogue and conversion', async () => {
    const u = await viewer.get('/api/units');
    expect(u.status).toBe(200);
    expect(u.data.units.length).toBeGreaterThanOrEqual(10);
  });

  it('KPI packages', async () => {
    for (const role of ['c_level', 'director', 'finance']) {
      const r = await mland.get(`/api/analytics/kpis?role=${role}&unit=Acre`);
      expect(r.status, role).toBe(200);
      expect(r.data.success).toBe(true);
    }
    const acre = await mland.get('/api/analytics/kpis?role=c_level&unit=Acre');
    const kanal = await mland.get('/api/analytics/kpis?role=c_level&unit=Kanal');
    const a = Number(acre.data.kpis.executive.total_area), k = Number(kanal.data.kpis.executive.total_area);
    expect(a).toBeGreaterThan(0);
    expect(Math.abs(k - a * 8)).toBeLessThan(1);
  });

  for (let i = 1; i <= 15; i++) {
    it(`report r${i}`, async () => {
      const r = await mland.get(`/api/analytics/reports?report=r${i}&unit=Acre`);
      expect(r.status, JSON.stringify(r.data).slice(0, 200)).toBe(200);
      expect(r.data.report_id).toBe(`r${i}`);
      expect(Array.isArray(r.data.cols) && Array.isArray(r.data.rows)).toBe(true);
    });
  }

  it('report r1 as CSV, for a role with reports:export, and the export is recorded', async () => {
    const before = Number(sql(`SELECT count(*) FROM audit.auth_event WHERE event_type = 'report_export'`));
    const r = await mland.get('/api/analytics/reports?report=r1&format=csv');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    expect(Number(sql(`SELECT count(*) FROM audit.auth_event WHERE event_type = 'report_export'`))).toBe(before + 1);
  });

  it('a read-only role can view a report but not export it', async () => {
    expect((await viewer.get('/api/analytics/reports?report=r1&unit=Acre')).status).toBe(200);
    expect((await viewer.get('/api/analytics/reports?report=r1&format=csv')).status).toBe(403);
  });

  it('KML features and merge history', async () => {
    for (const p of ['/api/gis/kml', '/api/gis/kml/merge']) {
      const r = await mland.get(p);
      expect(r.status, p).toBe(200);
      expect(r.data.success).toBe(true);
    }
  });
});
