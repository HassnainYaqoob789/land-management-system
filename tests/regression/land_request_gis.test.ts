import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { generate } from 'otplib';
import { Client, DB, PW, sql } from '../iam/client';

// Exploration land requests drawn on the map (migration 0057, plan
// docs/plans/EXPLORATION_LAND_REQUEST_GIS_PLAN.md): the whole flow through
// the API, by the people who would act, with the refusals in between.
// Self-contained: loads db/seed/seed_exploration_accounts.sql when its
// accounts are missing and gives them throw-away passwords for this run.

const NEW = ['explorer', 'explorerqta', 'dirops', 'regmgr', 'regmgrqta', 'landaffairs', 'landaffqta'];
const OLD = ['lofield'];   // fixture accounts: their passwords come from IAM_TEST_PASSWORDS and are not changed
const pw: Record<string, string> = {};

function setPassword(user: string, password: string) {
  const host = process.env.PGHOST ? `${process.env.PGHOST}${process.env.PGPORT ? `:${process.env.PGPORT}` : ''}` : '';
  const dsn = host ? `postgresql://lms_migrator@${host}/${DB}` : `postgresql://lms_migrator@/${DB}?host=/tmp`;
  execFileSync('npx', ['tsx', 'scripts/iam/bootstrap.ts', '--username', user, '--password-from-env', 'P', '--no-force-change'],
    { env: { ...process.env, P: password, DATABASE_URL_ADMIN: dsn }, stdio: 'ignore', shell: process.platform === 'win32' });
}

const signed: Record<string, Client> = {};
async function as(user: string): Promise<Client> {
  if (signed[user]) return signed[user];
  sql(`DELETE FROM iam.mfa_totp WHERE user_id = (SELECT id FROM lms.app_user WHERE username = '${user}');
       UPDATE iam.account_security SET failed_count = 0, locked_until = NULL WHERE user_id = (SELECT id FROM lms.app_user WHERE username = '${user}')`);
  const c = new Client();
  const r = await c.login(user, pw[user]);
  expect(r.status, `${user} signs in: ${JSON.stringify(r.data)}`).toBe(200);
  const me = await c.get('/api/auth/me');
  if (me.data.mfa?.enrolmentOutstanding) {
    const s = await c.post('/api/auth/mfa/totp/start');
    await c.post('/api/auth/mfa/totp/confirm', { code: await generate({ secret: s.data.secret }) });
  }
  return (signed[user] = c);
}
const get = async (u: string, p: string) => (await as(u)).get(p);
const post = async (u: string, p: string, b: unknown) => (await as(u)).post(p, b);
const patch = async (u: string, p: string, b: unknown) => (await as(u)).req('PATCH', p, b);
const step = (u: string, id: string, action: string, comment = `${action} by ${u}`, extra = {}) =>
  post(u, `/api/requests/${id}/transition`, { action, comment, ...extra });

/** A square of `half` degrees around a point, as [lng, lat] corners. */
const square = (lng: number, lat: number, half: number) =>
  [[lng - half, lat - half], [lng + half, lat - half], [lng + half, lat + half], [lng - half, lat + half]];

let sindhProject = '';
let parcel = { id: '', code: '', lng: 0, lat: 0, status: '' };

beforeAll(() => {
  if (sql(`SELECT count(*) FROM lms.app_user WHERE username IN (${NEW.map((u) => `'${u}'`).join(',')})`) !== String(NEW.length)) {
    execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'lms_migrator', '-d', DB, '-f', 'db/seed/seed_exploration_accounts.sql'],
      { stdio: 'ignore', env: { ...process.env, PGCLIENTENCODING: 'UTF8' } });
  }
  for (const u of NEW) { pw[u] = randomBytes(12).toString('hex') + '-Lr7a'; setPassword(u, pw[u]); }
  for (const u of OLD) pw[u] = PW[u];
  sindhProject = sql(`SELECT id FROM lms.project WHERE province_code = 'SND' ORDER BY code LIMIT 1`);
  // A recorded Sindh parcel with a location, set to Proposed for the hand-over check (restored afterwards).
  const [id, code, lng, lat, status] = sql(`SELECT id, code, lng, lat, status_code FROM lms.survey
    WHERE province_code = 'SND' AND lat IS NOT NULL ORDER BY code LIMIT 1`).split('|');
  parcel = { id, code, lng: Number(lng), lat: Number(lat), status };
  sql(`UPDATE lms.survey SET status_code = 'Proposed' WHERE id = '${id}'`);
}, 240_000);

afterAll(() => {
  if (parcel.id) sql(`UPDATE lms.survey SET status_code = '${parcel.status}' WHERE id = '${parcel.id}'`);
});

describe('Exploration Planner: least privilege', () => {
  it('reads the map and requests, but no landowners, payments or approvals', async () => {
    const me = await get('explorer', '/api/auth/me');
    expect(me.data.roles).toContain('exploration-planner');
    expect(me.data.permissions).toEqual(expect.arrayContaining(['requests:create', 'gis:read']));
    expect(me.data.permissions).not.toContain('pii:read');
    expect((await get('explorer', '/api/gis')).status).toBe(200);
    expect((await get('explorer', '/api/requests')).status).toBe(200);
    expect((await get('explorer', '/api/landowners')).status).toBe(403);
    expect((await get('explorer', '/api/payments')).status).toBe(403);
    expect((await get('explorer', '/api/cases')).status).toBe(403);
  });
  it('the reviewers hold their positions', async () => {
    expect((await get('dirops', '/api/auth/me')).data.user.groups).toEqual(['Director Operations']);
    expect((await get('regmgr', '/api/auth/me')).data.user.groups).toEqual(['Regional Manager']);
    expect((await get('landaffairs', '/api/auth/me')).data.user.groups).toEqual(['DM / TL Land Affairs']);
  });
});

describe('Polygon validation', () => {
  it('refuses a crossing boundary, a point outside Pakistan and too few corners', async () => {
    const base = { project_id: sindhProject, purpose: 'Well Site', draft: true };
    const bowtie = [[69.30, 28.00], [69.31, 28.01], [69.31, 28.00], [69.30, 28.01]];
    const r1 = await post('explorer', '/api/requests', { ...base, corners: bowtie });
    expect(r1.status).toBe(400);
    expect(r1.data.error).toMatch(/crosses itself/);
    expect((await post('explorer', '/api/requests', { ...base, corners: square(10, 50, 0.01) })).status).toBe(400);
    expect((await post('explorer', '/api/requests', { ...base, corners: [[69.3, 28], [69.31, 28]] })).status).toBe(400);
  });
});

describe('The full flow: draw → three tiers (with a return) → Land Officer hand-over', () => {
  let id = '';
  let code = '';
  it('the planner saves a draft polygon; only they see it', async () => {
    const r = await post('explorer', '/api/requests', {
      project_id: sindhProject, purpose: 'Well Site', priority: 'Urgent', draft: true, area_source: 'draw',
      corners: square(parcel.lng, parcel.lat, 0.001),
    });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    id = r.data.request.id; code = r.data.request.code;
    expect(r.data.request.stage_code).toBe('Draft');
    expect(r.data.request.area_version).toBe(1);
    // ~0.002° square at ~28°N: about 4.9 ha = 12 acres; the server measured it.
    expect(Number(r.data.request.area_acres)).toBeGreaterThan(10);
    expect(Number(r.data.request.area_acres)).toBeLessThan(14);
    const lo = await get('lofield', '/api/requests');
    expect(lo.data.requests.some((x: any) => x.id === id)).toBe(false);
    expect((await get('dirops', '/api/requests')).data.requests.some((x: any) => x.id === id)).toBe(false);
    expect((await step('dirops', id, 'APPROVE')).status).toBe(404);   // someone else's draft is not found
  });
  it('the planner redraws (version 2) and sends it; it can no longer change', async () => {
    const e = await patch('explorer', `/api/requests/${id}`, { corners: square(parcel.lng, parcel.lat, 0.0015), area_note: 'larger pad',
      justification: 'Exploratory well pad and camp', required_date: '2027-02-01' });
    expect(e.status, JSON.stringify(e.data)).toBe(200);
    expect(e.data.request.area_version).toBe(2);
    expect((await patch('lofield', `/api/requests/${id}`, { purpose: 'x' })).status).toBe(404);   // someone else's draft
    const s = await step('explorer', id, 'SUBMIT', '');
    expect(s.status, JSON.stringify(s.data)).toBe(200);
    expect(s.data.request.stage_code).toBe('Submitted');
    expect((await patch('explorer', `/api/requests/${id}`, { purpose: 'Camp' })).status).toBe(409);
  });
  it('only the tier\'s position decides; another province cannot even see it', async () => {
    expect((await step('regmgr', id, 'APPROVE')).status).toBe(403);
    expect((await step('landaffairs', id, 'APPROVE')).status).toBe(403);
    expect((await step('explorer', id, 'APPROVE')).status).toBe(403);
    expect((await step('regmgrqta', id, 'APPROVE')).status).toBe(404);
    expect((await get('explorerqta', '/api/requests?geo=1')).data.features.some((f: any) => f.properties.id === id)).toBe(false);
    const d = await step('dirops', id, 'APPROVE', 'Operational need confirmed');
    expect(d.status, JSON.stringify(d.data)).toBe(200);
    expect(d.data.request.stage_code).toBe('Under Review - Regional');
  });
  it('a return goes back to the planner, who redraws (version 3) and sends again', async () => {
    const r = await step('regmgr', id, 'RETURN', 'Move the pad 100 m away from the canal');
    expect(r.data.request.stage_code).toBe('Returned');
    expect((await step('lofield', id, 'SUBMIT')).status).toBe(403);
    const e = await patch('explorer', `/api/requests/${id}`, { corners: square(parcel.lng + 0.0002, parcel.lat, 0.0015), area_note: 'moved 100 m east' });
    expect(e.data.request.area_version).toBe(3);
    expect((await step('explorer', id, 'SUBMIT', 'Moved as asked')).data.request.stage_code).toBe('Submitted');
    expect((await step('dirops', id, 'APPROVE', 'Still needed')).data.request.stage_code).toBe('Under Review - Regional');
    expect((await step('regmgr', id, 'APPROVE', 'Region supports it')).data.request.stage_code).toBe('Under Review - Land Affairs');
    const la = await step('landaffairs', id, 'APPROVE', 'Private land, owners known');
    expect(la.status, JSON.stringify(la.data)).toBe(200);
    expect(la.data.request.stage_code).toBe('Approved');
  });
  it('the reviewers see every version, the parcels inside and the warnings', async () => {
    const d = await get('dirops', `/api/requests?id=${id}`);
    expect(d.status).toBe(200);
    expect(d.data.areas.map((a: any) => a.version)).toEqual([3, 2, 1]);
    expect(d.data.areas[1].note).toBe('larger pad');
    expect(d.data.parcels.map((p: any) => p.code)).toContain(parcel.code);
    expect(Array.isArray(d.data.warnings)).toBe(true);
    const geo = await get('dirops', '/api/requests?geo=1');
    const f = geo.data.features.find((x: any) => x.properties.id === id);
    expect(f.geometry.type).toBe('Polygon');
    expect(f.properties.version).toBe(3);
  });
  it('only a Land Officer (Field) takes it up, and the parcel is marked Under Acquisition', async () => {
    expect((await step('explorer', id, 'HANDOVER', 'x', { handover_kind: 'Acquisition' })).status).toBe(403);
    expect((await step('dirops', id, 'HANDOVER', 'x', { handover_kind: 'Acquisition' })).status).toBe(403);
    expect((await step('lofield', id, 'HANDOVER', 'x', { handover_kind: 'Picnic' })).status).toBe(400);
    const h = await step('lofield', id, 'HANDOVER', 'Negotiation starts next week', { handover_kind: 'Acquisition', mark_parcels: true });
    expect(h.status, JSON.stringify(h.data)).toBe(200);
    expect(h.data.request.stage_code).toBe('Handed over');
    expect(h.data.request.handed_over_kind).toBe('Acquisition');
    expect(h.data.parcels_marked).toContain(parcel.code);
    expect(sql(`SELECT status_code FROM lms.survey WHERE id = '${parcel.id}'`)).toBe('Under Acquisition');
    expect((await step('lofield', id, 'HANDOVER', 'again', { handover_kind: 'Lease' })).status).toBe(409);
    expect(code).toMatch(/^REQ-/);
  });
});

describe('Both may raise a request', () => {
  it('the Land Officer raises one drawn on the map, sent straight to Director Operations', async () => {
    const r = await post('lofield', '/api/requests', {
      project_id: sindhProject, purpose: 'Access Road', justification: 'Road to the well pad', required_date: '2027-01-15',
      corners: square(parcel.lng + 0.01, parcel.lat + 0.01, 0.0005), area_source: 'coordinates',
    });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.request.stage_code).toBe('Submitted');
    expect(r.data.request.area_version).toBe(1);
    const w = await step('lofield', r.data.request.id, 'WITHDRAW', 'no longer needed');
    expect(w.status).toBe(409);   // under review: only a draft or returned request is withdrawn
  });
});

describe('Audit fixes 2026-10-31', () => {
  it('another user\'s draft is not in the calendar and is answered as not found', async () => {
    const r = await post('explorer', '/api/requests', { project_id: sindhProject, purpose: 'Camp', draft: true, corners: square(69.5, 28.2, 0.0005) });
    expect(r.status).toBe(201);
    const cal = await get('lofield', '/api/calendar');
    expect(JSON.stringify(cal.data)).not.toContain(r.data.request.code);
    expect((await step('dirops', r.data.request.id, 'APPROVE')).status).toBe(404);
  });
  it('a resubmitted request is decided again by every tier', async () => {
    const r = await post('explorer', '/api/requests', { project_id: sindhProject, purpose: 'Camp', justification: 'tier reset check',
      required_date: '2027-03-01', corners: square(69.52, 28.22, 0.0005) });
    const id = r.data.request.id;
    expect((await step('dirops', id, 'APPROVE', 'ok')).status).toBe(200);
    expect((await step('regmgr', id, 'RETURN', 'change it')).status).toBe(200);
    const s = await step('explorer', id, 'SUBMIT', 'changed');
    expect(s.status, JSON.stringify(s.data)).toBe(200);
    expect(s.data.request.director_ops_id).toBeNull();
    expect(s.data.request.regional_mgr_id).toBeNull();
  });
  it('a lease hand-over does not mark parcels Under Acquisition', async () => {
    const r = await post('lofield', '/api/requests', { project_id: sindhProject, purpose: 'Camp', justification: 'lease kind',
      required_date: '2027-03-01', corners: square(parcel.lng, parcel.lat, 0.0008) });
    const id = r.data.request.id;
    sql(`UPDATE lms.survey SET status_code = 'Proposed' WHERE id = '${parcel.id}'`);
    for (const [u, a] of [['dirops', 'APPROVE'], ['regmgr', 'APPROVE'], ['landaffairs', 'APPROVE']] as const)
      expect((await step(u, id, a, 'ok')).status).toBe(200);
    const h = await step('lofield', id, 'HANDOVER', 'lease it', { handover_kind: 'Lease', mark_parcels: true });
    expect(h.status, JSON.stringify(h.data)).toBe(200);
    expect(h.data.parcels_marked).toEqual([]);
    expect(sql(`SELECT status_code FROM lms.survey WHERE id = '${parcel.id}'`)).toBe('Proposed');
  });
});
