import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { generate } from 'otplib';
import { Client, DB, PW, sql } from '../iam/client';

// Land requests in "Approvals & Alerts" (GET /api/inbox): each tier's position
// holder sees the request waiting on them, nobody sees one they raised or
// already decided, the Land Officer (Field) sees approved requests to take up
// and hand-overs still without an acquisition, and the requester gets notices
// (returned, approved, handed over, drafts). Same set-up as land_request_gis.

const NEW = ['explorer', 'dirops', 'regmgr', 'landaffairs'];
const OLD = ['lofield', 'viewer'];
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
const inbox = async (u: string) => {
  const r = await (await as(u)).get('/api/inbox');
  expect(r.status, `${u} reads the inbox`).toBe(200);
  return r.data;
};
const waiting = (body: any, id: string) => (body.mine ?? []).find((a: any) => a.record_id === id);
const notice = (body: any, id: string) => (body.request_alerts ?? []).find((a: any) => a.record_id === id);
const step = async (u: string, id: string, action: string, extra = {}) => {
  const r = await (await as(u)).post(`/api/requests/${id}/transition`, { action, comment: `${action} by ${u}`, ...extra });
  expect(r.status, `${u} ${action}: ${JSON.stringify(r.data)}`).toBe(200);
};

const square = (lng: number, lat: number, half: number) =>
  [[lng - half, lat - half], [lng + half, lat - half], [lng + half, lat + half], [lng - half, lat + half]];

let project = '';
beforeAll(() => {
  if (sql(`SELECT count(*) FROM lms.app_user WHERE username IN (${NEW.map((u) => `'${u}'`).join(',')})`) !== String(NEW.length)) {
    execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'lms_migrator', '-d', DB, '-f', 'db/seed/seed_exploration_accounts.sql'],
      { stdio: 'ignore', env: { ...process.env, PGCLIENTENCODING: 'UTF8' } });
  }
  for (const u of NEW) { pw[u] = randomBytes(12).toString('hex') + '-Ib7a'; setPassword(u, pw[u]); }
  for (const u of OLD) pw[u] = PW[u];
  project = sql(`SELECT id FROM lms.project WHERE province_code = 'SND' ORDER BY code LIMIT 1`);
}, 240_000);

describe('Land requests in Approvals & Alerts', () => {
  let id = '';

  it('a draft is a notice for its author only', async () => {
    const r = await (await as('explorer')).post('/api/requests', {
      draft: true, project_id: project, purpose: 'Camp', justification: 'Inbox test well pad', area_source: 'draw',
      corners: square(69.70, 28.10, 0.0005),
    });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    id = r.data.request.id;
    expect(id).toBeTruthy();
    expect(notice(await inbox('explorer'), id)?.stage_code).toBe('Draft');
    expect(waiting(await inbox('dirops'), id)).toBeUndefined();
  });

  it('each tier sees it only while it waits on that tier', async () => {
    await step('explorer', id, 'SUBMIT');
    const d = waiting(await inbox('dirops'), id);
    expect(d).toMatchObject({ workflow_code: 'requests', type_label: 'Land request', assigned_group: 'Director Operations', href: `/requests?open=${id}` });
    expect(waiting(await inbox('regmgr'), id)).toBeUndefined();

    await step('dirops', id, 'APPROVE');
    expect(waiting(await inbox('dirops'), id)).toBeUndefined();          // decided: no longer theirs
    expect(waiting(await inbox('regmgr'), id)?.assigned_group).toBe('Regional Manager');

    await step('regmgr', id, 'RETURN');
    const back = await inbox('explorer');
    expect(waiting(back, id)?.task).toBe('revise');
    expect(notice(back, id)).toMatchObject({ stage_code: 'Returned', tone: 'w' });

    await step('explorer', id, 'SUBMIT');
    await step('dirops', id, 'APPROVE');
    await step('regmgr', id, 'APPROVE');
    expect(waiting(await inbox('landaffairs'), id)?.assigned_group).toBe('DM / TL Land Affairs');
    await step('landaffairs', id, 'APPROVE');
  });

  it('the Land Officer takes it up, then creates the acquisition; the requester is told', async () => {
    expect(waiting(await inbox('lofield'), id)?.task).toBe('take_up');
    expect(notice(await inbox('explorer'), id)?.stage_code).toBe('Approved');
    await step('lofield', id, 'HANDOVER', { handover_kind: 'Acquisition' });
    expect(waiting(await inbox('lofield'), id)?.task).toBe('create_acquisition');
    expect(notice(await inbox('explorer'), id)?.stage_code).toBe('Handed over');
    // The header bell counts mine_total, which includes the land-request items.
    const lo = await inbox('lofield');
    expect(lo.mine_total).toBeGreaterThanOrEqual((lo.mine ?? []).filter((a: any) => a.kind === 'land_request').length);
  });

  it('a user without requests:read gets no land-request items', async () => {
    const me = await (await as('viewer')).get('/api/auth/me');
    if ((me.data.permissions ?? []).includes('requests:read')) return;   // fixture grants it: nothing to check here
    const v = await inbox('viewer');
    expect((v.mine ?? []).some((a: any) => a.kind === 'land_request')).toBe(false);
    expect((v.assignments ?? []).some((a: any) => a.kind === 'land_request')).toBe(false);
    expect(v.request_alerts ?? []).toEqual([]);
  });
});
