import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Client requirements of 2 Nov 2026 (docs/reports/CLIENT_REQUIREMENTS_ANALYSIS_2026-11-02.md):
//  1. temporary access — a role grant with an end date that can be changed or removed
//     (POST /api/users set_role_expiry = revoke + grant again; the database never edits a grant);
//  2. no duplicate people or parcels — GET /api/landowners?check_duplicate=1 and a named
//     khasra conflict from POST /api/surveys.
// Needs a running server (IAM_TEST_BASE) and IAM_TEST_PASSWORDS, like the rest of tests/regression.

type ClientMod = typeof import('../iam/client');
let M: ClientMod;
type C = InstanceType<ClientMod['Client']>;
let admin: C, lofield: C, loquetta: C, viewer: C;
const ids: Record<string, string> = {};
const grants: string[] = [];   // revoked again afterwards

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

beforeAll(async () => {
  if (!process.env.IAM_TEST_PASSWORDS) throw new Error('these tests need IAM_TEST_PASSWORDS and a server on IAM_TEST_BASE');
  M = await import('../iam/client');
  for (const line of M.sql(`SELECT username || '|' || id FROM lms.app_user WHERE username IN ('admin','lofield','loquetta','viewer')`).split('\n')) {
    const [u, id] = line.split('|'); ids[u] = id;
  }
  // Leftovers of an earlier run would make the first grant a 409.
  M.sql(`UPDATE iam.user_role SET revoked_at = now(), revoke_reason = 'temp-access test cleanup'
          WHERE user_id = '${ids.lofield}' AND revoked_at IS NULL AND role_id = (SELECT id FROM iam.role WHERE code = 'viewer')`);
  admin = await M.signInAs('admin');
  lofield = await M.signInAs('lofield');
  loquetta = await M.signInAs('loquetta');
  viewer = await M.signInAs('viewer');
}, 240_000);

afterAll(() => {
  if (!M) return;
  M.sql(`UPDATE iam.user_role SET revoked_at = now(), revoke_reason = 'temp-access test cleanup'
          WHERE user_id = '${ids.lofield}' AND revoked_at IS NULL AND role_id = (SELECT id FROM iam.role WHERE code = 'viewer')`);
});

describe('temporary access: role valid until', () => {
  it('grants a role until a date, then changes and removes the end date', async () => {
    const g = await admin.post('/api/users', { action: 'assign_role', user_id: ids.lofield, role_code: 'viewer', expires_at: day(3), reason: 'temp-access test grant' });
    expect(g.status, JSON.stringify(g.data)).toBe(200);
    const first = g.data.assignment.id as string;
    grants.push(first);

    const list = await admin.get('/api/users');
    const row = list.data.assignments.find((a: any) => a.id === first);
    expect(row.expires_at).toBeTruthy();
    expect(row.expired).toBe(false);

    const ch = await admin.post('/api/users', { action: 'set_role_expiry', assignment_id: first, expires_at: day(60), reason: 'extended for the survey season' });
    expect(ch.status, JSON.stringify(ch.data)).toBe(200);
    expect(ch.data.replaced).toBe(first);
    const second = ch.data.assignment.id as string;
    expect(second).not.toBe(first);
    expect(M.sql(`SELECT (revoked_at IS NOT NULL) || '|' || revoke_reason FROM iam.user_role WHERE id = '${first}'`)).toMatch(/^true\|Valid until changed from .* to .*: extended/);
    expect(M.sql(`SELECT (expires_at > now() + interval '59 days') || '|' || reason FROM iam.user_role WHERE id = '${second}'`)).toBe('true|temp-access test grant');

    const none = await admin.post('/api/users', { action: 'set_role_expiry', assignment_id: second, expires_at: null, reason: 'made permanent' });
    expect(none.status, JSON.stringify(none.data)).toBe(200);
    expect(M.sql(`SELECT expires_at IS NULL FROM iam.user_role WHERE id = '${none.data.assignment.id}'`)).toBe('t');
    expect(M.sql(`SELECT count(*) FROM iam.user_role WHERE user_id = '${ids.lofield}' AND revoked_at IS NULL AND role_id = (SELECT id FROM iam.role WHERE code = 'viewer')`)).toBe('1');
  });

  it('refuses a past date, a revoked grant, your own grant, an administrator grant and a caller without users:assign', async () => {
    const open = M.sql(`SELECT ur.id FROM iam.user_role ur JOIN iam.role r ON r.id = ur.role_id
                         WHERE ur.user_id = '${ids.lofield}' AND r.code = 'viewer' AND ur.revoked_at IS NULL`);
    expect((await admin.post('/api/users', { action: 'set_role_expiry', assignment_id: open, expires_at: '2001-01-01', reason: 'in the past' })).status).toBe(400);
    expect((await admin.post('/api/users', { action: 'set_role_expiry', assignment_id: open, reason: 'no date given' })).status).toBe(400);
    expect((await admin.post('/api/users', { action: 'set_role_expiry', assignment_id: grants[0], expires_at: day(5), reason: 'already revoked' })).status).toBe(404);
    const mine = M.sql(`SELECT ur.id FROM iam.user_role ur JOIN iam.role r ON r.id = ur.role_id
                         WHERE ur.user_id = '${ids.admin}' AND r.code = 'system-administrator' AND ur.revoked_at IS NULL LIMIT 1`);
    expect((await admin.post('/api/users', { action: 'set_role_expiry', assignment_id: mine, expires_at: day(5), reason: 'my own grant' })).status).toBe(403);
    expect((await viewer.post('/api/users', { action: 'set_role_expiry', assignment_id: open, expires_at: day(5), reason: 'no authority' })).status).toBe(403);
  });
});

describe('duplicate-person check', () => {
  let owner = { cnic: '', code: '', name: '', father: '' };
  beforeAll(() => {
    const [cnic, code, name, father] = M.sql(`SELECT cnic, code, full_name, coalesce(father_name, '') FROM lms.landowner
                                                WHERE province_code = 'SND' AND father_name IS NOT NULL ORDER BY code LIMIT 1`).split('|');
    owner = { cnic, code, name, father };
  });
  const check = (c: C, q: Record<string, string>) => c.get(`/api/landowners?${new URLSearchParams({ check_duplicate: '1', ...q })}`);

  it('names the person already registered with the CNIC', async () => {
    const r = await check(lofield, { cnic: owner.cnic, name: 'Someone Else', father_name: '', province: 'SND' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.cnic_match).toEqual(expect.objectContaining({ code: owner.code, province_code: 'SND' }));
  });

  it('lists similar names with the same father name, without the exact-CNIC record', async () => {
    const typo = owner.name.replace(/a/, 'aa');   // a one-letter spelling variant
    const r = await check(lofield, { cnic: '', name: typo, father_name: owner.father, province: 'SND' });
    expect(r.status).toBe(200);
    expect(r.data.name_matches.map((m: any) => m.code)).toContain(owner.code);
    expect(r.data.name_matches.length).toBeLessThanOrEqual(5);
    const same = await check(lofield, { cnic: owner.cnic, name: owner.name, father_name: owner.father, province: 'SND' });
    expect(same.data.name_matches.map((m: any) => m.code)).not.toContain(owner.code);
  });

  it('stays within the caller\'s provinces and needs landowners:create', async () => {
    const other = await check(loquetta, { cnic: owner.cnic, name: owner.name, father_name: owner.father, province: 'SND' });
    expect(other.status).toBe(200);
    expect(other.data.cnic_match).toBeNull();
    expect(other.data.name_matches).toEqual([]);
    expect((await check(viewer, { cnic: owner.cnic, name: owner.name, province: 'SND' })).status).toBe(403);
    expect((await check(lofield, { name: owner.name, province: 'sindh' })).status).toBe(400);
  });
});

describe('duplicate khasra', () => {
  it('says which parcel already has the khasra / survey no. in that deh', async () => {
    const [au, no, block] = M.sql(`SELECT admin_unit_id, survey_no, coalesce(block_no, '') FROM lms.survey
                                    WHERE province_code = 'SND' ORDER BY code LIMIT 1`).split('|');
    const code = M.sql(`SELECT code FROM lms.survey WHERE admin_unit_id = '${au}' AND survey_no = '${no.replace(/'/g, "''")}' LIMIT 1`);
    const r = await lofield.post('/api/surveys', { province_code: 'SND', admin_unit_id: au, survey_no: ` ${no.toUpperCase()} `,
      block_no: block || undefined, recorded_area: '1', recorded_unit: 'Acre', land_class: 'Agricultural' });
    expect(r.status, JSON.stringify(r.data)).toBe(409);
    expect(r.data.error).toMatch(new RegExp(`already exists in .+ as ${code}`));
  });
});
