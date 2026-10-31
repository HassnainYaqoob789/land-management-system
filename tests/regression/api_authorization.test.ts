import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
import { generate } from 'otplib';
import { Client, PW, sql } from '../iam/client';

// One test per authorization finding fixed in package P1b (API and migration
// 0042). Records are created through the API by the people who would really
// act; fixture ids come from the seeded database.

const signed: Record<string, Client> = {};
async function as(user: string): Promise<Client> {
  if (signed[user]) return signed[user];
  const c = new Client();
  expect((await c.login(user)).status, `${user} signs in`).toBe(200);
  const me = await c.get('/api/auth/me');
  if (me.data.mfa?.enrolmentOutstanding) {
    const s = await c.post('/api/auth/mfa/totp/start');
    await c.post('/api/auth/mfa/totp/confirm', { code: await generate({ secret: s.data.secret }) });
  }
  return (signed[user] = c);
}
const put = async (user: string, path: string, body: unknown) => (await as(user)).req('PUT', path, body);
const post = async (user: string, path: string, body: unknown) => (await as(user)).post(path, body);
const get = async (user: string, path: string) => (await as(user)).get(path);

const FULL_CNIC = /\b\d{5}-\d{7}-\d\b/;
const digit = () => Math.floor(Math.random() * 10);
const cnicOf = () => `4${[...Array(4)].map(digit).join('')}-${[...Array(7)].map(digit).join('')}-${digit()}`;
const one = (q: string) => sql(q).split('\n')[0];

let sindhProject: string, balProject: string, sindhUnit: string, balSurvey: string, balLandowner: string, balCase: string;

async function newLandowner(user = 'lofield', extra: object = {}) {
  const r = await post(user, '/api/landowners', { province_code: 'SND', full_name: `P1b Owner ${Date.now()}`, father_name: 'P1b Father',
    cnic: cnicOf(), owner_type: 'O', tax_status: 'Filer', iban: 'PK36SCBL0000001123456702', phone: '+92 300 1234567', address: 'Village P1b', ...extra });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data.landowner.id as string;
}
async function newParcel(owner: string) {
  const r = await post('lofield', '/api/surveys', { province_code: 'SND', admin_unit_id: sindhUnit, survey_no: `P1B-${Date.now()}-${digit()}`,
    recorded_area: '2', recorded_unit: 'Acre', land_class: 'Private', shares: [{ landowner_id: owner, share_pct: 100 }] });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data.survey.id as string;
}

beforeAll(async () => {
  const users = ['admin', 'mland', 'finance', 'lofield', 'nego', 'legal', 'sradmin', 'dmfield', 'viewer', 'audit'].map((u) => `'${u}'`).join(',');
  sql(`UPDATE iam.account_security SET failed_count = 0, locked_until = NULL`);
  sql(`DELETE FROM iam.mfa_totp WHERE user_id IN (SELECT id FROM lms.app_user WHERE username IN (${users}));
       DELETE FROM iam.mfa_recovery_code WHERE user_id IN (SELECT id FROM lms.app_user WHERE username IN (${users}))`);
  sindhProject = one(`SELECT id FROM lms.project WHERE code = 'DHRK-001'`);
  balProject = one(`SELECT id FROM lms.project WHERE province_code = 'BAL' ORDER BY code LIMIT 1`);
  sindhUnit = one(`SELECT admin_unit_id FROM lms.survey WHERE province_code = 'SND' ORDER BY code LIMIT 1`);
  balSurvey = one(`SELECT id FROM lms.survey WHERE province_code = 'BAL' ORDER BY code LIMIT 1`);
  balLandowner = one(`SELECT id FROM lms.landowner WHERE province_code = 'BAL' ORDER BY code LIMIT 1`);
  balCase = one(`SELECT id FROM lms.compensation_case WHERE province_code = 'BAL' ORDER BY code LIMIT 1`);
});

describe('AUTHZ-22 / AUTHZ-21: errors are answered, never 500', () => {
  it('a malformed id is 400, not 500', async () => {
    const r = await get('lofield', '/api/cases?id=not-a-uuid');
    expect(r.status).toBe(400);
    expect(r.data.correlationId).toBeTruthy();
  });
  it('a record in another province is 404, exactly like one that does not exist', async () => {
    const out = await get('lofield', `/api/cases?id=${balCase}`);
    const none = await get('lofield', `/api/cases?id=${randomUUID()}`);
    expect(out.status).toBe(404);
    expect(none.status).toBe(404);
  });
  it('a transition on another province\'s record is 404 and names nothing', async () => {
    const code = one(`SELECT code FROM lms.compensation_case WHERE id = '${balCase}'`);
    const r = await post('sradmin', `/api/cases/${balCase}/transition`, { to_stage: 'Reviewed' });
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.data)).not.toContain(code);
  });
});

describe('UI-04, RPT-05, DSP-01, AUTHZ-09: personal data needs pii:read', () => {
  // The reader without pii:read is the security auditor: since 0047 the analyst (viewer)
  // does not read these registers at all, so it would only show 403s.
  let owner: string;
  beforeAll(async () => { owner = await newLandowner(); await newParcel(owner); });

  it('a reader without pii:read gets CNIC, phone, IBAN and address masked in the register', async () => {
    const r = await get('audit', '/api/landowners?province=SND&limit=500');
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.data)).not.toMatch(FULL_CNIC);
    const row = r.data.landowners.find((l: any) => l.id === owner);
    expect(row.cnic).toContain('•');
    expect(row.iban).toMatch(/^•+6702$/);
    expect(row.phone).toContain('•');
    expect(row.address).toBe('••••••');
  });
  it('the holder of pii:read gets them in full', async () => {
    const r = await get('lofield', `/api/landowners?id=${owner}`);
    expect(r.status).toBe(200);
    expect(r.data.landowner.cnic).toMatch(FULL_CNIC);
    expect(r.data.landowner.iban).toBe('PK36SCBL0000001123456702');
  });
  it('the statement, parcels, cases, payments, grievances and audit trail mask them too', async () => {
    for (const path of [`/api/landowners?statement_for=${owner}`, '/api/surveys?province=SND', '/api/cases?province=SND',
      '/api/payments?province=SND', '/api/payments?view=releases', '/api/payments?view=receipts', '/api/mutations?province=SND',
      '/api/legal?province=SND', '/api/grievances?province=SND', '/api/leases?province=SND']) {
      const r = await get('audit', path);
      expect(r.status, path).toBe(200);
      expect(JSON.stringify(r.data), path).not.toMatch(FULL_CNIC);
    }
    const caseId = one(`SELECT id FROM lms.compensation_case WHERE code = 'CC-2026-0001'`);
    const c = await get('audit', `/api/cases?id=${caseId}`);
    expect(JSON.stringify(c.data)).not.toMatch(FULL_CNIC);
    const a = await get('audit', '/api/audit?entity=landowner&limit=200');
    expect(a.status).toBe(200);
    expect(JSON.stringify(a.data)).not.toMatch(FULL_CNIC);
  });
  it('searching by CNIC needs pii:read', async () => {
    const cnic = one(`SELECT cnic FROM lms.landowner WHERE id = '${owner}'`);
    expect((await get('lofield', `/api/landowners?q=${encodeURIComponent(cnic)}`)).data.page.total).toBeGreaterThan(0);
    expect((await get('audit', `/api/landowners?q=${encodeURIComponent(cnic)}`)).data.page.total).toBe(0);
  });
});

describe('IAMDB-10 / AUTH-06: MFA follows sensitive permissions', () => {
  it('a data-entry user (import:update, mutations:update are sensitive) must use MFA; a viewer need not', async () => {
    expect((await get('lofield', '/api/auth/me')).data.mfa.required).toBe(true);
    expect((await get('viewer', '/api/auth/me')).data.mfa.required).toBe(false);
  });
});

describe('AUTHZ-01: ownership moves only through a mutation', () => {
  it('owners are recorded once, at the first registration', async () => {
    const owner = await newLandowner();
    const parcel = await newParcel(owner);
    expect(sql(`SELECT count(*) FROM lms.survey_ownership_share WHERE survey_id = '${parcel}'`)).toBe('1');
    const other = await newLandowner();
    const r = await put('lofield', '/api/surveys', { id: parcel, shares: [{ landowner_id: other, share_pct: 100 }] });
    expect(r.status).toBe(409);
    expect(sql(`SELECT landowner_id FROM lms.survey_ownership_share WHERE survey_id = '${parcel}'`)).toBe(owner);
  });
  it('a parcel cannot take an owner from another province', async () => {
    const r = await post('lofield', '/api/surveys', { province_code: 'SND', admin_unit_id: sindhUnit, survey_no: `P1B-X-${Date.now()}`,
      recorded_area: '1', recorded_unit: 'Acre', land_class: 'Private', shares: [{ landowner_id: balLandowner, share_pct: 100 }] });
    expect(r.status).toBe(404);
  });
});

describe('surveys: recorded area and unit (contract), UX-04', () => {
  it('the area is kept as recorded and converted to acres by the database', async () => {
    const no = `P1B-K-${Date.now()}`;
    const r = await post('lofield', '/api/surveys', { province_code: 'SND', admin_unit_id: sindhUnit, survey_no: no,
      recorded_area: '8', recorded_unit: 'Kanal', land_class: 'Private' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(sql(`SELECT recorded_unit || ' ' || recorded_area::numeric::text || ' ' || total_area::numeric::text FROM lms.survey WHERE id = '${r.data.survey.id}'`))
      .toMatch(/^Kanal 8(\.0+)? 1(\.0+)?$/);
    // UX-04: the record pickers search with ?q=.
    const found = await get('lofield', `/api/surveys?q=${encodeURIComponent(no)}`);
    expect(found.data.surveys.map((s: any) => s.survey_id)).toContain(r.data.survey.id);
  });
  it('an unknown unit is refused', async () => {
    const r = await post('lofield', '/api/surveys', { province_code: 'SND', admin_unit_id: sindhUnit, survey_no: `P1B-U-${Date.now()}`,
      recorded_area: '1', recorded_unit: 'Furlong', land_class: 'Private' });
    expect(r.status).toBe(400);
  });
});

describe('AUTHZ-02: a lease starts at the first stage', () => {
  it('whatever stage the client sends, and blocks no parcel until approved', async () => {
    const owner = await newLandowner();
    const parcel = await newParcel(owner);
    const r = await post('lofield', '/api/leases', { project_id: sindhProject, start_date: '2026-11-01', term_years: 3,
      initial_area: 2, rate_per_acre: 30000, stage_code: 'Approved', lessor_ids: [owner], survey_ids: [parcel] });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.lease.stage_code).toBe('Draft');
    expect(sql(`SELECT bool_or(is_blocking)::text FROM lms.lease_survey WHERE lease_id = '${r.data.lease.id}'`)).toBe('false');
  });
  it('no area or rate is invented', async () => {
    expect((await post('lofield', '/api/leases', { project_id: sindhProject, start_date: '2026-11-01', term_years: 3 })).status).toBe(400);
  });
});

describe('AUTHZ-15: linked records stay in the record\'s province', () => {
  it('a Sindh lease cannot take a Balochistan parcel', async () => {
    const r = await post('lofield', '/api/leases', { project_id: sindhProject, start_date: '2026-11-01', term_years: 1,
      initial_area: 1, rate_per_acre: 1000, survey_ids: [balSurvey] });
    expect(r.status).toBe(404);
  });
  it('a record in a province the user cannot work in is not found', async () => {
    expect((await post('lofield', '/api/cases', { project_id: balProject, land_use_code: 'Well Location' })).status).toBe(404);
  });
});

describe('AUTHZ-11, AUTHZ-12: payment ids and holds', () => {
  it('a voucher cannot name a payee from another province', async () => {
    const r = await post('lofield', '/api/payments', { action: 'request', idempotency_key: `p1b-${Date.now()}-cross`, project_id: sindhProject,
      landowner_id: balLandowner, category: 'Crop Compensation', pay_type: 'One-time', period_from: '2031-01-01',
      payment_mode: 'Cross Cheque', land_class: 'Private', gross_amount: 1000 });
    expect(r.status).toBe(404);
  });
  it('a hold takes its province from its target, not from the request', async () => {
    const payee = await newLandowner();
    const v = await post('lofield', '/api/payments', { action: 'request', idempotency_key: `p1b-${Date.now()}-hold`, project_id: sindhProject,
      landowner_id: payee, category: 'Crop Compensation', pay_type: 'One-time', period_from: '2031-02-01',
      payment_mode: 'Cross Cheque', land_class: 'Private', gross_amount: 1000 });
    expect(v.status, JSON.stringify(v.data)).toBe(200);
    const h = await post('finance', '/api/payments', { action: 'hold', scope: 'payment', payment_id: v.data.payment_id, province_code: 'BAL', reason: 'P1b probe' });
    expect(h.status, JSON.stringify(h.data)).toBe(200);
    expect(h.data.hold.province_code).toBe('SND');
    expect((await post('finance', '/api/payments', { action: 'lift_hold', hold_id: h.data.hold.id, lift_reason: 'P1b probe done' })).status).toBe(200);
  });
  it('a lease hold holds that lease\'s vouchers, not every payment of the project', async () => {
    const lease = one(`SELECT id FROM lms.lease WHERE province_code = 'SND' AND NOT is_on_hold ORDER BY code LIMIT 1`);
    const before = sql(`SELECT count(*) FROM lms.payment_hold WHERE lifted_at IS NULL`);
    const h = await post('mland', `/api/leases/${lease}/hold`, { action: 'HOLD', reason: 'P1b: disputed title' });
    expect(h.status, JSON.stringify(h.data)).toBe(200);
    expect(sql(`SELECT count(*) FROM lms.payment_hold WHERE lifted_at IS NULL`)).toBe(before);
    expect((await post('mland', `/api/leases/${lease}/hold`, { action: 'RELEASE', reason: 'P1b: title certified' })).status).toBe(200);
  });
});

describe('AUTHZ-14: payee tax status and bank details', () => {
  it('whoever changed a payee\'s tax status does not raise their voucher', async () => {
    const payee = await newLandowner('nego');
    expect((await put('lofield', '/api/landowners', { id: payee, tax_status: 'Non-Filer', change_reason: 'FBR active taxpayer list checked' })).status).toBe(200);
    const body = { action: 'request', project_id: sindhProject, landowner_id: payee, category: 'Crop Compensation', pay_type: 'One-time',
      period_from: '2031-03-01', payment_mode: 'Cross Cheque', land_class: 'Private', gross_amount: 1000 };
    expect((await post('lofield', '/api/payments', { ...body, idempotency_key: `p1b-${Date.now()}-sod1` })).status).toBe(403);
    expect((await post('nego', '/api/payments', { ...body, idempotency_key: `p1b-${Date.now()}-sod2` })).status).toBe(200);
  });
});

describe('AUTHZ-23: receipts are recorded by finance, not by the raiser or releaser', () => {
  it('request → verify → release by three people; the raiser and releaser cannot record the receipt', async () => {
    const payee = await newLandowner();
    const v = await post('lofield', '/api/payments', { action: 'request', idempotency_key: `p1b-${Date.now()}-rcpt`, project_id: sindhProject,
      landowner_id: payee, category: 'Crop Compensation', pay_type: 'One-time', period_from: '2031-04-01',
      payment_mode: 'Cross Cheque', land_class: 'Private', gross_amount: 1000 });
    expect(v.status, JSON.stringify(v.data)).toBe(200);
    expect((await post('finance', '/api/payments', { action: 'verify', payment_id: v.data.payment_id })).status).toBe(200);
    const rel = await post('mland', '/api/payments', { action: 'release', payment_id: v.data.payment_id, cheque_date: '2026-10-30' });
    expect(rel.status, JSON.stringify(rel.data)).toBe(200);
    const receipt = (n: string) => ({ action: 'receipt', release_id: rel.data.release_id, receipt_no: `P1B-${n}-${Date.now()}`, received_date: '2026-10-30', acknowledged_by: 'Payee' });
    expect((await post('lofield', '/api/payments', receipt('a'))).status).toBe(403);   // payments:create no longer records receipts
    expect((await post('mland', '/api/payments', receipt('b'))).status).toBe(403);     // the releaser is refused by the database
    expect((await post('finance', '/api/payments', receipt('c'))).status).toBe(200);
  });
});

describe('AUTHZ-17: moving money needs a recent proof of identity', () => {
  it('a release from an old session asks for re-authentication', async () => {
    const m = await as('mland');
    sql(`UPDATE lms.login_session SET started_at = now() - interval '2 hours', reauth_at = NULL
          WHERE user_id = (SELECT id FROM lms.app_user WHERE username = 'mland') AND ended_at IS NULL`);
    const r = await m.post('/api/payments', { action: 'release', payment_id: randomUUID() });
    expect(r.status).toBe(403);
    expect(r.data.code).toBe('reauth_required');
    expect((await m.post('/api/auth/reauth', { password: PW.mland })).status).toBe(200);
    expect((await m.post('/api/payments', { action: 'release', payment_id: randomUUID() })).status).toBe(404);
  });
});

describe('AUTHZ-05: a court stay is lifted only with the payment-hold authority', () => {
  it('data entry cannot lift it; the land manager records the court\'s order', async () => {
    const owner = await newLandowner();
    const lc = await post('lofield', '/api/legal', { project_id: sindhProject, court_case_no: `P1B/${Date.now()}`, court: 'Civil Judge, Daharki',
      parties: 'P1b v. Mari Energies', case_type: 'Civil Suit', company_role: 'Defendant / Respondent', status: 'Pending',
      filing_date: '2026-10-01', stay_order: true, landowner_ids: [owner] });
    expect(lc.status, JSON.stringify(lc.data)).toBe(200);
    const id = lc.data.legal_case.id;
    expect(Number(sql(`SELECT count(*) FROM lms.payment_hold WHERE legal_case_id = '${id}' AND lifted_at IS NULL`))).toBeGreaterThan(0);
    expect((await put('lofield', '/api/legal', { id, stay_order: false, lift_reason: 'Order of 30 Oct vacating the stay' })).status).toBe(403);
    expect((await put('mland', '/api/legal', { id, stay_order: false })).status).toBe(400);   // the court's order is required
    const ok = await put('mland', '/api/legal', { id, stay_order: false, lift_reason: 'Order of 30 Oct vacating the stay' });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(sql(`SELECT count(*) FROM lms.payment_hold WHERE legal_case_id = '${id}' AND lifted_at IS NULL`)).toBe('0');
    expect(sql(`SELECT bool_and(lift_reason LIKE '%Order of 30 Oct%')::text FROM lms.payment_hold WHERE legal_case_id = '${id}'`)).toBe('true');
  });
});

describe('AUTHZ-10: approved terms', () => {
  it('a valuation changed after the first approval sends the case back for re-approval', async () => {
    const owner = await newLandowner();
    const r = await post('lofield', '/api/cases', { project_id: sindhProject, land_use_code: 'Well Location', lease_rate: 30000, lease_term_months: 12,
      owners: [{ landowner_id: owner, share_pct: 100, owner_status: 'O' }], misc_lines: [{ payment_type: 'disturbance', amount: 10000 }] });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const id = r.data.case.id;
    expect((await put('nego', '/api/cases', { id, action: 'transition', to_stage: 'Checked' })).status).toBe(200);
    const ed = await put('lofield', '/api/cases', { id, misc_lines: [{ payment_type: 'disturbance', amount: 12000 }] });
    expect(ed.status, JSON.stringify(ed.data)).toBe(200);
    expect(sql(`SELECT stage_code FROM lms.compensation_case WHERE id = '${id}'`)).toBe('Prepared');
    expect(sql(`SELECT count(*) FROM lms.workflow_transition WHERE record_id = '${id}' AND action = 'Reopened'`)).toBe('1');
    // The earlier checker approves the new round.
    expect((await put('nego', '/api/cases', { id, action: 'transition', to_stage: 'Checked' })).status).toBe(200);
  });
  it('an approved lease keeps its agreed rent', async () => {
    const lease = one(`SELECT id FROM lms.lease WHERE stage_code = 'Approved' AND NOT is_on_hold ORDER BY code LIMIT 1`);
    const rate = Number(sql(`SELECT rate_per_acre FROM lms.lease WHERE id = '${lease}'`));
    expect((await put('mland', '/api/leases', { id: lease, rate_per_acre: rate + 1 })).status).toBe(409);
    expect(Number(sql(`SELECT rate_per_acre FROM lms.lease WHERE id = '${lease}'`))).toBe(rate);
  });
});

describe('AUTHZ-04: mutation heirs and parcels after verification', () => {
  it('changing them sends the mutation back to the start', async () => {
    const owner = await newLandowner();
    await newParcel(owner);
    const heir = await newLandowner();
    const r = await post('lofield', '/api/mutations', { mutation_type: 'Sale / Transfer', transferor_id: owner,
      heirs: [{ landowner_id: heir, relation: 'Buyer', share_pct: 100 }] });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const id = r.data.mutation.id;
    expect((await put('sradmin', '/api/mutations', { id, revenue_mutation_no: 'P1B-REV', mutation_date: '2026-10-01', certificate_no: 'P1B-C' })).status).toBe(200);
    expect((await put('sradmin', '/api/mutations', { id, action: 'transition', to_stage: 'Revenue Verified' })).status).toBe(200);
    const other = await newLandowner();
    const ed = await put('lofield', '/api/mutations', { id, heirs: [{ landowner_id: other, relation: 'Buyer', share_pct: 100 }] });
    expect(ed.status, JSON.stringify(ed.data)).toBe(200);
    expect(sql(`SELECT stage_code FROM lms.mutation WHERE id = '${id}'`)).toBe('Initiated');
    expect(sql(`SELECT count(*) FROM lms.workflow_transition WHERE record_id = '${id}' AND action = 'Reopened'`)).toBe('1');
  });
});

describe('AUTHZ-03: land-request tiers are positions', () => {
  it('only the tier\'s position decides it, and only the initiator resubmits', async () => {
    const r = await post('lofield', '/api/requests', { project_id: sindhProject, purpose: 'P1b well pad', area_acres: 2,
      required_date: '2026-12-31', justification: 'P1b authorization test' });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    const id = r.data.request.id;
    expect((await post('nego', `/api/requests/${id}/transition`, { action: 'APPROVE', comment: 'no position' })).status).toBe(403);
    sql(`INSERT INTO lms.app_user_group (user_id, group_code) SELECT id, 'Director Operations' FROM lms.app_user WHERE username = 'dmfield' ON CONFLICT DO NOTHING`);
    try {
      expect((await post('dmfield', `/api/requests/${id}/transition`, { action: 'RETURN', comment: 'add the survey plan' })).status).toBe(200);
      expect((await post('nego', `/api/requests/${id}/transition`, { action: 'APPROVE', comment: 'not mine' })).status).toBe(403);
      const re = await post('lofield', `/api/requests/${id}/transition`, { action: 'APPROVE', comment: 'survey plan attached' });
      expect(re.status, JSON.stringify(re.data)).toBe(200);
      expect(re.data.request.stage_code).toBe('Submitted');
    } finally {
      sql(`DELETE FROM lms.app_user_group WHERE group_code = 'Director Operations' AND user_id = (SELECT id FROM lms.app_user WHERE username = 'dmfield')`);
    }
  });
});

describe('AUTHZ-13: import', () => {
  it('rows belong to the batch\'s province, a province is required, and the uploader does not promote', async () => {
    const row = { full_name: 'P1b Import', father_name: 'F', cnic: cnicOf(), owner_type: 'O', tax_status: 'Filer' };
    expect((await post('lofield', '/api/import', { target_entity: 'landowner', source_file: 'p1b.csv', rows: [row] })).status).toBe(400);
    expect((await post('lofield', '/api/import', { target_entity: 'landowner', province_code: 'SND', source_file: 'p1b.csv',
      rows: [{ ...row, province_code: 'BAL' }] })).status).toBe(400);
    const staged = await post('lofield', '/api/import', { target_entity: 'landowner', province_code: 'SND', source_file: 'p1b.csv', rows: [row] });
    expect(staged.status, JSON.stringify(staged.data)).toBe(200);
    const promote = await post('lofield', '/api/import', { action: 'promote', batch_id: staged.data.batch.id });
    expect(promote.status).toBe(403);
  });
});

describe('AUTHZ-18: KMZ archives are checked before they are expanded', () => {
  it('an entry that expands past the limit is refused with 400', async () => {
    const zip = new AdmZip();
    zip.addFile('doc.kml', Buffer.alloc(60 * 1024 * 1024, 0x20));   // 60 MB of spaces, a few KB compressed
    const lo = await as('lofield');
    const fd = new FormData();
    fd.set('file', new Blob([new Uint8Array(zip.toBuffer())]), 'bomb.kmz'); fd.set('projectId', sindhProject);
    const r = await fetch(`${(lo as any).origin}/api/gis/kml`, { method: 'POST', body: fd,
      headers: { cookie: lo.cookieHeader(), origin: (lo as any).origin, 'x-csrf-token': lo.csrf } });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/expanded/);
  });
});

describe('AUTHZ-19, AUTHZ-20, UI-02: documents and comments', () => {
  it('the uploader does not archive their own document', async () => {
    const lo = await as('lofield');
    const fd = new FormData();
    fd.set('file', new Blob([new Uint8Array(Buffer.from(`%PDF-1.4\np1b ${Date.now()}\n%%EOF\n`))]), 'p1b.pdf');
    fd.set('entity', 'project'); fd.set('record_id', sindhProject);
    fd.set('category_code', one(`SELECT code FROM lms.document_category ORDER BY display_order LIMIT 1`));
    const up = await fetch(`${(lo as any).origin}/api/documents`, { method: 'POST', body: fd,
      headers: { cookie: lo.cookieHeader(), origin: (lo as any).origin, 'x-csrf-token': lo.csrf } });
    expect(up.status).toBe(201);
    const doc = (await up.json()).document.id;
    expect((await put('lofield', '/api/documents', { id: doc, action: 'delete', delete_reason: 'wrong file uploaded' })).status).toBe(403);
    // Archiving needs documents:update and the record's own update (projects:update): since 0047
    // that is the field supervisor (case-approver), not the negotiation officer.
    expect((await put('sradmin', '/api/documents', { id: doc, action: 'delete', delete_reason: 'wrong file uploaded' })).status).toBe(200);
  });
  it('an access is logged only for a document the user can see', async () => {
    const bal = one(`SELECT id FROM lms.document WHERE province_code = 'BAL' AND deleted_at IS NULL LIMIT 1`);
    const r = await put('lofield', '/api/documents', { id: bal || randomUUID(), action: 'log_access' });
    expect(r.status).toBe(404);
  });
  it('a read-only role cannot write into an approval discussion; the record\'s editor can', async () => {
    const caseId = one(`SELECT id FROM lms.compensation_case WHERE province_code = 'SND' ORDER BY code LIMIT 1`);
    const v = await post('viewer', '/api/inbox', { action: 'comment', workflow_code: 'cases', record_id: caseId, body: 'viewer note' });
    expect([403, 404]).toContain(v.status);
    const lo = await post('lofield', '/api/inbox', { action: 'comment', workflow_code: 'cases', record_id: caseId, body: 'P1b field note' });
    expect(lo.status, JSON.stringify(lo.data)).toBe(200);
  });
});
