import { describe, it, expect, beforeAll } from 'vitest';
import { generate } from 'otplib';
import { Client, sql } from '../iam/client';

// End-to-end module workflows through the HTTP API, with the payloads the
// screens send and the people who would really act: the record is created by
// one person and each later step is taken by a different holder of the
// approval position lms.workflow_step_group names, so strict separation of
// duties is satisfied rather than bypassed. Stage names come from
// /api/reference, never from this file.

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

let ref: any, sindhProject: any, sindhSurvey: any;

beforeAll(async () => {
  sql(`UPDATE iam.account_security SET failed_count = 0, locked_until = NULL`);
  // Every fixture account may need MFA (0041: sensitive permissions), and other test files
  // enrol some (e.g. lofield); start each file from no authenticator at all.
  sql(`DELETE FROM iam.mfa_totp WHERE user_id IN (SELECT id FROM lms.app_user WHERE NOT is_service_account);
       DELETE FROM iam.mfa_recovery_code WHERE user_id IN (SELECT id FROM lms.app_user WHERE NOT is_service_account)`);
  const c = await as('lofield');
  ref = (await c.get('/api/reference')).data;
  sindhProject = (await c.get('/api/projects')).data.projects.find((p: any) => p.province_code === 'SND');
  sindhSurvey = (await c.get('/api/surveys')).data.surveys.find((s: any) => s.province_code === 'SND');
  expect(sindhProject && sindhSurvey).toBeTruthy();
});

/** Walk a record through every non-terminal stage after the first, one actor per step. */
async function walk(workflow: string, resource: string, id: string, actors: Record<string, string>, extra: (stage: string) => object = () => ({})) {
  const stages: string[] = ref.workflows[workflow].stages.filter((s: any) => !s.terminal).map((s: any) => s.code);
  for (const to of stages.slice(1)) {
    const who = actors[to];
    expect(who, `an actor for ${workflow} → ${to}`).toBeTruthy();
    const r = await (await as(who)).req('PUT', resource, { id, action: 'transition', to_stage: to, note: `moved to ${to} by ${who}`, ...extra(to) });
    expect(r.status, `${workflow} → ${to} by ${who}: ${JSON.stringify(r.data)}`).toBe(200);
  }
  return stages[stages.length - 1];
}

describe('reference data', () => {
  it('serves workflows, lookups and CHECK values from PostgreSQL', async () => {
    expect(ref.workflows.grievances.stages.map((s: any) => s.code)).toContain('Assigned');
    expect(ref.lookups.land_use.map((x: any) => x.code)).toContain('Well Location');
    expect(ref.enums['survey.land_class']).toEqual(['Private', 'Government']);
    expect(ref.enums['row_corridor.row_type']).toContain('Pipeline ROW');
    expect(ref.provinces.map((p: any) => p.code).sort()).toEqual(['BAL', 'KPK', 'PNJ', 'SND']);
  });
});

describe('module workflows', () => {
  it('grievance: register, assign, work, resolve, close', async () => {
    const lo = await as('lofield');
    const r = await lo.post('/api/grievances', {
      province_code: 'SND', grievance_type: ref.enums['grievance.grievance_type'][0], complainant: 'Regression complainant',
      project_id: sindhProject.project_id, category_code: ref.lookups.grievance_category[0].code,
      severity: 'Medium', description: 'Crop damage along the access road',
    });
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
    const id = r.data.grievance?.id ?? r.data.id;
    expect(id).toBeTruthy();
    const last = await walk('grievances', '/api/grievances', id,
      { Assigned: 'dmfield', 'In Progress': 'sradmin', Resolved: 'legal', Closed: 'mland' },
      (to) => (to === 'Resolved' ? { resolution: 'Compensated for the damaged crop' } : {}));
    expect(sql(`SELECT stage_code FROM lms.grievance WHERE id = '${id}'`)).toBe(last);
  });

  it('a grievance without a province or project is refused, not filed under Sindh', async () => {
    const r = await (await as('lofield')).post('/api/grievances', {
      grievance_type: ref.enums['grievance.grievance_type'][0], complainant: 'x', description: 'no province given',
      category_code: ref.lookups.grievance_category[0].code, severity: 'Low',
    });
    expect(r.status).toBe(400);
  });

  it('encroachment: report, assess, approve action, legal follow-up, resolve', async () => {
    const r = await (await as('lofield')).post('/api/encroachments', {
      project_id: sindhProject.project_id, survey_id: sindhSurvey.survey_id, category_code: ref.lookups.encroachment_category[0].code,
      risk: 'High', detected_on: '2026-10-20', description: 'Boundary wall built inside the survey',
    });
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
    const id = r.data.encroachment?.id ?? r.data.id;
    await walk('encroachments', '/api/encroachments', id,
      { Assessed: 'sradmin', 'Action Approved': 'dmfield', 'Legal Follow-up': 'legal', Resolved: 'mland' });
  });

  it('ROW corridor: draft, review, approve', async () => {
    const r = await (await as('lofield')).post('/api/rows', {
      project_id: sindhProject.project_id, name: 'Regression flowline', row_type: ref.enums['row_corridor.row_type'][0],
      length_m: 1200, width_m: 15, tenure_years: 10, annual_rent: 250000, agreement_date: '2026-10-01',
    });
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
    const id = r.data.row?.id ?? r.data.id;
    await walk('rows', '/api/rows', id, { 'Under Review': 'sradmin', Approved: 'mland' });
    expect(sql(`SELECT stage_code FROM lms.row_corridor WHERE id = '${id}'`)).toBe('Approved');
  });

  it('DBPFC estimate: estimate, refer, record the committee rate, fix', async () => {
    const r = await (await as('lofield')).post('/api/dbpfc', {
      project_id: sindhProject.project_id, area_acres: 12.5, estimated_rate: 30000,
    });
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
    const id = r.data.dbpfc?.id ?? r.data.id;
    const rate = await (await as('mland')).req('PUT', '/api/dbpfc', { id, fixed_rate: 34000, committee_ref: 'DBPFC/REG/1' });
    expect(rate.status, JSON.stringify(rate.data)).toBe(200);
    await walk('dbpfc', '/api/dbpfc', id, { 'Referred to DBPFC': 'sradmin', 'Rate Fixed': 'mland' });
    expect(sql(`SELECT fixed_rate::int FROM lms.dbpfc_estimate WHERE id = '${id}'`)).toBe('34000');
  });

  it('the preparer cannot approve their own record', async () => {
    const lo = await as('lofield');
    const r = await lo.post('/api/rows', { project_id: sindhProject.project_id, name: 'SoD probe', row_type: ref.enums['row_corridor.row_type'][0], length_m: 10, width_m: 5, agreement_date: '2026-10-01', tenure_years: 5 });
    const id = r.data.row?.id ?? r.data.id;
    const t = await lo.req('PUT', '/api/rows', { id, action: 'transition', to_stage: 'Under Review' });
    expect(t.status).toBe(403);
    expect(t.data.error).toMatch(/segregation of duties/i);
  });
});

describe('more module workflows', () => {
  it('acquisition: title checks gate the acquisition stage, then it walks to handover', async () => {
    const lo = await as('lofield');
    const r = await lo.post('/api/acquisitions', {
      project_id: sindhProject.project_id, mode: ref.enums['acquisition.mode'][0], area_required: 4.5, survey_ids: [sindhSurvey.survey_id],
    });
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
    const id = r.data.acquisition?.id ?? r.data.id;
    const items = (await lo.get('/api/acquisitions')).data.title_items;
    for (const [to, who] of [['Negotiation', 'nego'], ['Approval', 'dmfield']]) {
      const t = await (await as(who)).req('PUT', '/api/acquisitions', { id, action: 'transition', to_stage: to });
      expect(t.status, `acquisitions → ${to} by ${who}: ${JSON.stringify(t.data)}`).toBe(200);
    }
    // Before the mandatory checks, the Acquisition / Lease stage is refused with the missing items named.
    const blocked = await (await as('mland')).req('PUT', '/api/acquisitions', { id, action: 'transition', to_stage: 'Acquisition / Lease' });
    expect(blocked.status).toBe(400);
    expect(blocked.data.error).toMatch(/Title validation incomplete/);
    for (const it of items.filter((i: any) => i.is_mandatory)) {
      const t = await (await as('sradmin')).req('PUT', '/api/acquisitions', { id, action: 'toggle_check', item_code: it.code, checked: true });
      expect(t.status, JSON.stringify(t.data)).toBe(200);
    }
    const ok = await (await as('mland')).req('PUT', '/api/acquisitions', { id, action: 'transition', to_stage: 'Acquisition / Lease' });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    const done = await (await as('sradmin')).req('PUT', '/api/acquisitions', { id, action: 'transition', to_stage: 'Handover' });
    expect(done.status, JSON.stringify(done.data)).toBe(200);
  });

  it('mutation (inheritance): revenue record, legal clearance, approval moves the shares to the heirs', async () => {
    // A transferor and parcel of our own: earlier runs (and the seed's deliberately
    // unbalanced parcel) leave the fixture owners' parcels unusable for this.
    const lo = await as('lofield');
    const rnd = () => Math.floor(Math.random() * 10);
    const cnicOf = () => `4${[...Array(4)].map(rnd).join('')}-${[...Array(7)].map(rnd).join('')}-${rnd()}`;
    const t = await lo.post('/api/landowners', { province_code: 'SND', full_name: 'Regression Transferor', father_name: 'Regression Father', cnic: cnicOf(), owner_type: 'O', tax_status: 'Filer' });
    expect(t.status, JSON.stringify(t.data)).toBeLessThan(300);
    const owner = t.data.landowner?.id ?? t.data.id;
    const unit = sql(`SELECT admin_unit_id FROM lms.survey WHERE id = '${sindhSurvey.survey_id}'`);
    const parcel = await lo.post('/api/surveys', { province_code: 'SND', admin_unit_id: unit, survey_no: `REG-${Date.now()}`, total_area: 2,
      land_class: 'Private', shares: [{ landowner_id: owner, share_pct: 100 }] });
    expect(parcel.status, JSON.stringify(parcel.data)).toBeLessThan(300);
    const parcelId = parcel.data.survey?.id;
    // Fresh heirs for every run: earlier runs legitimately moved fixture shares.
    const heirs: string[] = [];
    for (const name of ['Regression Heir A', 'Regression Heir B']) {
      const d = () => Math.floor(Math.random() * 10);
      const cnic = `4${[...Array(4)].map(d).join('')}-${[...Array(7)].map(d).join('')}-${d()}`;
      const r = await lo.post('/api/landowners', { province_code: 'SND', full_name: name, father_name: 'Regression Father', cnic, owner_type: 'O', tax_status: 'Filer' });
      expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
      heirs.push(r.data.landowner?.id ?? r.data.id);
    }
    const r = await (await as('lofield')).post('/api/mutations', {
      mutation_type: 'Inheritance (Virasat)', transferor_id: owner, death_date: '2026-01-15',
      heirs: [{ landowner_id: heirs[0], relation: 'son', share_pct: 50 }, { landowner_id: heirs[1], relation: 'daughter', share_pct: 50 }],
    });
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
    const id = r.data.mutation?.id ?? r.data.id;
    const sr = await as('sradmin');
    // Verification needs the revenue mutation number (CHECK mutation_revenue_no_ck).
    const early = await sr.req('PUT', '/api/mutations', { id, action: 'transition', to_stage: 'Revenue Verified' });
    expect(early.status).toBe(400);
    expect((await sr.req('PUT', '/api/mutations', { id, revenue_mutation_no: 'MUT-REG-1', mutation_date: '2026-02-01', certificate_no: 'SC-REG-1' })).status).toBe(200);
    await walk('mutations', '/api/mutations', id, { 'Revenue Verified': 'sradmin', 'Legal Cleared': 'legal', 'Approved & Applied': 'mland' });
    expect(sql(`SELECT count(*) FROM lms.survey_ownership_share WHERE landowner_id = '${owner}' AND share_pct > 0`)).toBe('0');
    // The parcel now belongs to the heirs, 50/50, and still totals 100%.
    expect(sql(`SELECT string_agg(share_pct::numeric::text, ',' ORDER BY share_pct) FROM lms.survey_ownership_share WHERE survey_id = '${parcelId}'`)).toBe('50.0000,50.0000');
  });

  it('legal case: register, record a hearing that sets the next date', async () => {
    const lo = await as('lofield');
    const r = await lo.post('/api/legal', {
      province_code: 'SND', court_case_no: `CS-REG/${Date.now()}`, court: 'Senior Civil Judge, Ghotki', parties: 'A v. Mari Energies',
      company_role: ref.enums['legal_case.company_role'][0], status: ref.enums['legal_case.status'][0], project_id: sindhProject.project_id,
      case_type: 'Civil suit', filing_date: '2026-09-15',
    });
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
    const id = r.data.legal_case?.id ?? r.data.id;
    const h = await lo.req('PUT', '/api/legal', { id, action: 'add_hearing', hearing_date: '2026-11-02', proceedings: 'Adjourned', next_date: '2026-12-01' });
    expect(h.status, JSON.stringify(h.data)).toBe(200);
    expect(sql(`SELECT next_hearing::text FROM lms.legal_case WHERE id = '${id}'`)).toBe('2026-12-01');
  });

  it('budget: integer fiscal year, create and revise', async () => {
    const m = await as('mland');
    // A fiscal year this project has no budget for yet (one budget per project and year).
    const fy = Number(sql(`SELECT min(y) FROM generate_series(2000, 2100) y WHERE NOT EXISTS
      (SELECT 1 FROM lms.budget WHERE project_id = '${sindhProject.project_id}' AND fiscal_year = y)`));
    const r = await m.post('/api/budgets', { project_id: sindhProject.project_id, fiscal_year: fy, approved_amount: 5_000_000, approval_ref: 'BRD-REG' });
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
    const b = (await m.get(`/api/budgets?fiscal_year=${fy}`)).data.budgets.find((x: any) => x.project_id === sindhProject.project_id);
    expect(b).toBeTruthy();
    expect((await m.req('PUT', '/api/budgets', { id: b.budget_id, approved_amount: 6_000_000 })).status).toBe(200);
  });
});

describe('compensation cases', () => {
  it('valued from its lines by the database, checked, approved by five positions, then locked', async () => {
    const lo = await as('lofield');
    const owners = (await lo.get('/api/landowners?province=SND')).data.landowners.filter((l: any) => !l.is_deceased && !l.is_on_hold && l.status === 'Active');
    expect(owners.length, 'two active Sindh landowners').toBeGreaterThanOrEqual(2);
    const base = {
      project_id: sindhProject.project_id, land_use_code: 'Well Location', lease_rate: 30000, lease_term_months: 12,
      owners: [{ landowner_id: owners[0].id, share_pct: 60, owner_status: 'O' }, { landowner_id: owners[1].id, share_pct: 40, owner_status: 'O' }],
      lease_lines: [{ survey_id: sindhSurvey.survey_id, lease_area: 1.5 }],
      crop_lines: [{ survey_id: sindhSurvey.survey_id, crop_type: 'wheat', rate_per_acre: 20000, damage_area: 0.5 }],
      tree_lines: [{ species_code: ref.lookups.tree_species?.[0]?.code ?? 'Neem', size: 'Large', rate: 4000, qty: 3 }],
      misc_lines: [{ payment_type: 'disturbance', amount: 15000 }],
    };

    // Shares off 100% are refused by the deferred share-total trigger.
    const bad = await lo.post('/api/cases', { ...base, owners: [{ ...base.owners[0], share_pct: 90 }] });
    expect(bad.status, JSON.stringify(bad.data)).toBe(400);

    // Client-sent totals are ignored; the lines decide.
    const r = await lo.post('/api/cases', { ...base, crop_amount: 999999999, total_amount: 1 });
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
    const id = r.data.case?.id;
    expect(id).toBeTruthy();
    const d = (await lo.get(`/api/cases?id=${id}`)).data;
    expect(Number(d.case.total_crop_amount)).toBe(10000);
    expect(Number(d.case.total_tree_amount)).toBe(12000);
    expect(Number(d.case.total_misc_amount)).toBe(15000);
    expect(Number(d.case.total_lease_amount)).toBeGreaterThan(0);
    expect(Number(d.case.total_amount)).toBeCloseTo(Number(d.case.total_lease_amount) + 37000, 2);
    expect(d.owners.length).toBe(2);
    expect(sql(`SELECT count(*) FROM lms.workflow_assignment WHERE workflow_code = 'cases' AND record_id = '${id}' AND closed_at IS NULL`)).toBe('1');

    // Editing the draft replaces the lines and recomputes.
    const ed = await lo.req('PUT', '/api/cases', { id, misc_lines: [{ payment_type: 'disturbance', amount: 5000 }] });
    expect(ed.status, JSON.stringify(ed.data)).toBe(200);
    expect(Number(ed.data.case.total_misc_amount)).toBe(5000);

    // Document checklist: tick and untick through the API.
    const item = d.document_checks[0].code;
    const t1 = await lo.req('PUT', '/api/cases', { id, action: 'toggle_doc', item_code: item, checked: true });
    expect(t1.status, JSON.stringify(t1.data)).toBe(200);
    expect(t1.data.case.document_checks.find((x: any) => x.code === item).checked_at).toBeTruthy();

    // The preparer cannot approve their own case.
    const self = await lo.req('PUT', '/api/cases', { id, action: 'transition', to_stage: 'Checked' });
    expect(self.status).toBeGreaterThanOrEqual(400);

    // Field approval is refused until every always-required document has been seen (checked above
    // for one item only); tick the rest, as the officer would.
    for (const doc of d.document_checks.filter((x: any) => x.required_when === 'always' && x.code !== item)) {
      expect((await lo.req('PUT', '/api/cases', { id, action: 'toggle_doc', item_code: doc.code, checked: true })).status).toBe(200);
    }
    const last = await walk('cases', '/api/cases', id,
      { Checked: 'nego', Reviewed: 'legal', Verified: 'sradmin', 'Field Approved': 'dmfield', 'HO Approved': 'mland' });
    expect(sql(`SELECT stage_code FROM lms.compensation_case WHERE id = '${id}'`)).toBe(last);

    // Once approved the valuation is fixed.
    const locked = await (await as('mland')).req('PUT', '/api/cases', { id, misc_lines: [{ payment_type: 'disturbance', amount: 1 }] });
    expect(locked.status, JSON.stringify(locked.data)).toBeGreaterThanOrEqual(400);
    expect(sql(`SELECT total_misc_amount::numeric::text FROM lms.compensation_case WHERE id = '${id}'`)).toMatch(/^5000(\.0+)?$/);
  });
});

describe('approval matrix', () => {
  it('an administrator changes who approves a stage, it is recorded, and others cannot', async () => {
    const before = sql(`SELECT string_agg(group_code, ',' ORDER BY group_code) FROM lms.workflow_step_group WHERE workflow_code = 'grievances' AND to_stage = 'Assigned'`);
    expect(before, 'grievances → Assigned has approving positions').toBeTruthy();
    const extra = sql(`SELECT code FROM lms.approval_group WHERE code NOT IN (SELECT group_code FROM lms.workflow_step_group WHERE workflow_code = 'grievances' AND to_stage = 'Assigned') ORDER BY code LIMIT 1`);
    const body = (groups: string[]) => ({ action: 'set_step_groups', workflow_code: 'grievances', to_stage: 'Assigned', groups, note: 'regression: widen then restore' });
    // Not a matrix administrator: refused.
    expect((await (await as('lofield')).req('PUT', '/api/settings', body([...before.split(','), extra]))).status).toBe(403);
    const admin = await as('admin');
    const histBefore = Number(sql(`SELECT count(*) FROM lms.workflow_matrix_history`));
    const r = await admin.req('PUT', '/api/settings', body([...before.split(','), extra]));
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(sql(`SELECT count(*) FROM lms.workflow_step_group WHERE workflow_code = 'grievances' AND to_stage = 'Assigned' AND group_code = '${extra}'`)).toBe('1');
    expect(Number(sql(`SELECT count(*) FROM lms.workflow_matrix_history`))).toBeGreaterThan(histBefore);
    // A stage may not be left with nobody to approve it.
    expect((await admin.req('PUT', '/api/settings', body([]))).status).toBe(400);
    // Restore.
    expect((await admin.req('PUT', '/api/settings', body(before.split(',')))).status).toBe(200);
    expect(sql(`SELECT string_agg(group_code, ',' ORDER BY group_code) FROM lms.workflow_step_group WHERE workflow_code = 'grievances' AND to_stage = 'Assigned'`)).toBe(before);
  });
});

describe('documents', () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(`regression ${Date.now()}\n%%EOF\n`)]);
  async function upload(c: Client, body: Buffer, name: string, entity: string, recordId: string) {
    const fd = new FormData();
    fd.set('file', new Blob([new Uint8Array(body)]), name); fd.set('entity', entity); fd.set('record_id', recordId); fd.set('category_code', ref.lookups.document_category[0].code);
    const r = await fetch(`${(c as any).origin}/api/documents`, { method: 'POST', body: fd, headers: { cookie: c.cookieHeader(), origin: (c as any).origin, 'x-csrf-token': c.csrf } });
    return { status: r.status, data: await r.json() };
  }

  it('stores the real bytes, serves them back verified, and logs the download', async () => {
    const lo = await as('lofield');
    const r = await upload(lo, pdf, 'deed.pdf', 'project', sindhProject.project_id);
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    const { createHash } = await import('node:crypto');
    expect(r.data.document.sha256_hex).toBe(createHash('sha256').update(pdf).digest('hex'));
    const d = await fetch(`${(lo as any).origin}/api/documents?download=${r.data.document.id}`, { headers: { cookie: lo.cookieHeader() } });
    expect(d.status).toBe(200);
    expect(d.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await d.arrayBuffer()).equals(pdf)).toBe(true);
    expect(Number(sql(`SELECT count(*) FROM lms.document_access_log WHERE document_id = '${r.data.document.id}' AND action = 'download'`))).toBeGreaterThan(0);
  });

  it('refuses a file whose bytes are not an accepted type, whatever its name', async () => {
    const r = await upload(await as('lofield'), Buffer.from('#!/bin/sh\necho hi\n'), 'looks-like.pdf', 'project', sindhProject.project_id);
    expect(r.status).toBe(415);
  });

  it('refuses a record outside the uploader\'s provinces', async () => {
    const bal = sql(`SELECT id FROM lms.project WHERE province_code = 'BAL' LIMIT 1`);
    const r = await upload(await as('lofield'), pdf, 'x.pdf', 'project', bal);
    expect(r.status).toBe(404);
  });

  it('detects a stored file altered on disk', async () => {
    const lo = await as('lofield');
    const body = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(`tamper ${Date.now()}`)]);
    const r = await upload(lo, body, 'tamper.pdf', 'project', sindhProject.project_id);
    const { writeFileSync } = await import('node:fs');
    const path = await import('node:path');
    const hex = r.data.document.sha256_hex;
    writeFileSync(path.resolve(process.env.DOCUMENT_STORE_DIR || '.data/documents', hex.slice(0, 2), hex), Buffer.from('%PDF-1.4 altered'));
    const d = await fetch(`${(lo as any).origin}/api/documents?download=${r.data.document.id}`, { headers: { cookie: lo.cookieHeader() } });
    expect(d.status).toBe(409);
  });
});

describe('payments', () => {
  const payee = () => sql(`SELECT id FROM lms.landowner WHERE province_code = 'SND' AND status = 'Active'
                           AND NOT EXISTS (SELECT 1 FROM lms.payment_hold h WHERE h.landowner_id = landowner.id AND h.lifted_at IS NULL) ORDER BY code LIMIT 1`);
  // The database refuses a second voucher for the same payee, category and period
  // (duplicate-payment protection), so each test pays for its own period.
  const period = () => `20${10 + Math.floor(Math.random() * 15)}-${String(1 + Math.floor(Math.random() * 12)).padStart(2, '0')}-${String(1 + Math.floor(Math.random() * 28)).padStart(2, '0')}`;
  const voucher = (key: string, extra: object = {}) => ({
    action: 'request', idempotency_key: key, project_id: sindhProject.project_id, landowner_id: payee(),
    category: ref.lookups.payment_category[0].code, pay_type: ref.enums['payment_request.pay_type'][0],
    payment_mode: ref.enums['payment_request.payment_mode'][0], land_class: 'Private', period_from: period(), gross_amount: 125000, ...extra,
  });

  it('request → verify → release → receipt, by three different people', async () => {
    const key = `reg-pay-${Date.now()}-abcdef`;
    const body = voucher(key);
    const r = await (await as('lofield')).post('/api/payments', body);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const id = r.data.payment_id;
    const again = await (await as('lofield')).post('/api/payments', body);
    expect(again.data.payment_id, 'the same key is the same voucher').toBe(id);
    expect((await (await as('finance')).post('/api/payments', { action: 'verify', payment_id: id })).status).toBe(200);
    const rel = await (await as('mland')).post('/api/payments', { action: 'release', payment_id: id, cheque_date: '2026-10-28' });
    expect(rel.status, JSON.stringify(rel.data)).toBe(200);
    const releaseId = sql(`SELECT id FROM lms.payment_release WHERE payment_id = '${id}'`);
    // A receipt is finance's record, never the raiser's or the releaser's (AUTHZ-23).
    const rc = await (await as('finance')).post('/api/payments', { action: 'receipt', release_id: releaseId, receipt_no: `RC-${Date.now()}`, received_date: '2026-10-29', acknowledged_by: 'Payee' });
    expect(rc.status, JSON.stringify(rc.data)).toBe(200);
    // Finance can now see the release and who made it (migration 0032).
    const seen = (await (await as('finance')).get('/api/payments?view=releases')).data.releases.find((x: any) => x.payment_id === id);
    expect(seen?.released_by).toBe('mland');
  });

  it('refuses a voucher without the figures that decide it, and without an idempotency key', async () => {
    const lo = await as('lofield');
    expect((await lo.post('/api/payments', { ...voucher(`reg-${Date.now()}-x1234567`), land_class: undefined })).status).toBe(400);
    expect((await lo.post('/api/payments', { ...voucher('x'), idempotency_key: undefined })).status).toBe(400);
  });

  it('holds: data entry cannot lift one; a court-stay hold is lifted only on the legal case; a hold blocks release', async () => {
    const f = await as('finance');
    const key = `reg-hold-${Date.now()}-abcdef`;
    const req = await (await as('lofield')).post('/api/payments', voucher(key));
    expect(req.status, JSON.stringify(req.data)).toBe(200);
    const id = req.data.payment_id;
    const h = await f.post('/api/payments', { action: 'hold', scope: 'payment', payment_id: id, reason: 'Ownership dispute raised' });
    expect(h.status, JSON.stringify(h.data)).toBe(200);
    const holdId = h.data.hold?.id ?? sql(`SELECT id FROM lms.payment_hold WHERE payment_id = '${id}' AND lifted_at IS NULL`);
    expect((await (await as('lofield')).post('/api/payments', { action: 'lift_hold', hold_id: holdId, lift_reason: 'no' })).status).toBe(403);
    await f.post('/api/payments', { action: 'verify', payment_id: id });
    const blocked = await (await as('mland')).post('/api/payments', { action: 'release', payment_id: id, cheque_date: '2026-10-28' });
    expect(blocked.status).toBe(400);
    expect((await f.post('/api/payments', { action: 'lift_hold', hold_id: holdId, lift_reason: 'Dispute withdrawn in writing' })).status).toBe(200);
    const stayHold = sql(`SELECT id FROM lms.payment_hold WHERE legal_case_id IS NOT NULL AND lifted_at IS NULL LIMIT 1`);
    if (stayHold) expect((await f.post('/api/payments', { action: 'lift_hold', hold_id: stayHold, lift_reason: 'try' })).status).toBe(409);
  });

  it('withholding tax comes from policy and filer status, never from the request', async () => {
    const lo = await as('lofield');
    const base = Number(sql(`SELECT value #>> '{}' FROM lms.system_setting WHERE key = 'finance.wht_pct'`));
    const mult = Number(sql(`SELECT value #>> '{}' FROM lms.system_setting WHERE key = 'finance.wht_nonfiler_multiplier'`));
    const of = (status: string) => sql(`SELECT id FROM lms.landowner WHERE province_code = 'SND' AND status = 'Active' AND tax_status = '${status}'
      AND NOT EXISTS (SELECT 1 FROM lms.payment_hold h WHERE h.landowner_id = landowner.id AND h.lifted_at IS NULL) ORDER BY code LIMIT 1`);
    const filer = of('Filer');
    // A non-filer of our own, so the test does not depend on fixture holds.
    const cnic = `4${String(Date.now()).slice(-4)}-${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}-${Math.floor(Math.random() * 10)}`;
    const made = await lo.post('/api/landowners', { province_code: 'SND', full_name: 'Regression Non-Filer', father_name: 'Test',
      cnic, owner_type: 'O', tax_status: 'Non-Filer' });
    expect(made.status, JSON.stringify(made.data)).toBeLessThan(300);
    const nonFiler = made.data.landowner?.id ?? sql(`SELECT id FROM lms.landowner WHERE cnic = '${cnic}'`);
    expect(filer && nonFiler, 'a Sindh filer and non-filer without holds').toBeTruthy();
    const rate = async (landowner_id: string) => {
      const r = await lo.post('/api/payments', voucher(`reg-wht-${Date.now()}-${landowner_id.slice(0, 8)}`, { landowner_id }));
      expect(r.status, JSON.stringify(r.data)).toBe(200);
      return Number(sql(`SELECT wht_pct FROM lms.payment_request WHERE id = '${r.data.payment_id}'`));
    };
    expect(await rate(filer)).toBe(base);
    expect(await rate(nonFiler)).toBe(base * mult);
    // A requester cannot choose a lower rate.
    const cheat = await lo.post('/api/payments', voucher(`reg-wht0-${Date.now()}-abcdef`, { landowner_id: filer, wht_pct: 0 }));
    expect(cheat.status, JSON.stringify(cheat.data)).toBe(400);
    expect(cheat.data.error).toMatch(/set by policy/);
  });

  it('reconciliation runs and records its run', async () => {
    const r = await (await as('finance')).post('/api/payments', { action: 'reconcile', scope_type: 'all', as_of_date: '2026-10-28' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.run_id).toBeTruthy();
  });
});
