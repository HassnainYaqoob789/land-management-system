import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generate } from 'otplib';
import { Client, PW, sql, resetPassword } from './client';
import { SIGNIN_UNAVAILABLE_MESSAGE } from '../../src/lib/iam/signin-methods';

const GENERIC = 'Invalid credentials, or the account is unavailable.';

// Every request from this suite comes from one address, and the per-address
// limit counts the deliberate failures below. It is held out of the way here
// (the test DB only) and tested on its own in 'source address'.
const HIGH_IP_LIMIT = '100000';
beforeAll(() => { sql(`UPDATE lms.system_setting SET value='${HIGH_IP_LIMIT}' WHERE key='iam.rate_limit_per_ip'`); });

/** host(source_ip) of the newest matching auth event ('' when NULL or none). */
const lastIp = (where: string) =>
  sql(`SELECT coalesce(host(source_ip),'') FROM audit.auth_event WHERE ${where} ORDER BY id DESC LIMIT 1`);

// Accounts this file signs in with a password and expects a session from.
// Other suites may leave a TOTP enrolment on them; that would turn their
// sign-in into an MFA challenge, so it is cleared first.
const PASSWORD_ONLY = ['finance', 'mland', 'lofield', 'loquetta', 'viewer', 'audit', 'sradmin', 'sradmpnj', 'legal', 'nego', 'dmfield'];
const uid = (u: string) => `(SELECT id FROM lms.app_user WHERE username='${u}')`;
const dropMfa = (users: string[]) =>
  sql(users.map((u) => `DELETE FROM iam.mfa_recovery_code WHERE user_id=${uid(u)}; DELETE FROM iam.mfa_totp WHERE user_id=${uid(u)};`).join(' '));

/** A session that satisfies the MFA policy: TOTP is enrolled when the account
 * must use it (data entry and approval roles hold sensitive permissions).
 * Callers drop the enrolment afterwards with dropMfa. */
async function usable(user: string): Promise<Client> {
  dropMfa([user]);
  const c = new Client();
  expect((await c.login(user)).status).toBe(200);
  if ((await c.get('/api/auth/me')).data.mfa?.enrolmentOutstanding) await enrolTotp(c);
  return c;
}

beforeAll(() => {
  // Re-runnable: put back what earlier runs changed — lockouts, MFA
  // enrolments made by the tests, and the one password the tests change.
  sql(`UPDATE iam.account_security SET failed_count = 0, locked_until = NULL`);
  dropMfa(PASSWORD_ONLY);
  sql(`DELETE FROM iam.password_history WHERE user_id = (SELECT id FROM lms.app_user WHERE username = 'legal')`);
  resetPassword('legal');   // recorded in history, which the reuse test relies on
});

describe('unauthenticated requests', () => {
  const c = new Client();
  for (const p of ['/api/auth/me', '/api/landowners', '/api/audit', '/api/payments', '/api/gis', '/api/analytics/kpis',
                   '/api/units', '/api/provinces', '/api/requests', '/api/cases', '/api/projects', '/api/dbpfc'])
    it(`${p} → 401`, async () => {
      const r = await c.get(p);
      expect(r.status).toBe(401);
      expect(r.data.code).toBe('unauthenticated');
    });

  it('a forged legacy lms_user_id cookie is not a session', async () => {
    const admin = sql(`SELECT id FROM lms.app_user WHERE username='admin'`);
    const r = await fetch(`${c.origin}/api/auth/me`, { headers: { cookie: `lms_user_id=${admin}` } });
    expect(r.status).toBe(401);
  });
  it('no account list is exposed before sign-in', async () => {
    const r = await c.get('/api/auth/options');
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.data)).not.toMatch(/username|full_name|lofield|admin/);
  });
});

describe('login', () => {
  it('wrong password, unknown user and missing password all get the same answer', async () => {
    const a = await new Client().login('lofield', 'not-the-password');
    const b = await new Client().login('no-such-user-zz', 'whatever-password');
    const d = await new Client().post('/api/auth/login', { username: 'lofield' });
    expect(a.status).toBe(401); expect(b.status).toBe(401);
    expect(a.data.error).toBe(GENERIC); expect(b.data.error).toBe(GENERIC);
    expect(d.status).toBe(400);
  });
  it('a correct password yields an HttpOnly, SameSite session cookie and no user-id cookie', async () => {
    const c = new Client();
    const r = await c.login('lofield');
    expect(r.status).toBe(200);
    const sc = r.setCookie.join('\n');
    expect(sc).toMatch(/lms_session=/);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=lax/i);
    expect(sc).not.toMatch(/lms_user_id/);
    const me = await c.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.data.user.username).toBe('lofield');
    expect(me.data.permissions).toContain('landowners:read');
  });
  it('login from another origin is refused', async () => {
    const r = await new Client().post('/api/auth/login', { username: 'lofield', password: PW.lofield }, { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
  });
  it('the session token is stored only as a hash', async () => {
    const c = new Client(); await c.login('lofield');
    const token = [...c.cookies.values()][0];
    expect(sql(`SELECT count(*) FROM lms.login_session WHERE encode(token_sha256,'hex') = '${token}'`)).toBe('0');
    expect(Number(sql(`SELECT count(*) FROM lms.login_session WHERE token_sha256 = sha256(convert_to('${token}','utf8')) AND ended_at IS NULL`))).toBe(1);
  });
});

describe('CSRF and origin on state-changing requests', () => {
  it('a signed-in POST without the CSRF token is refused', async () => {
    const c = new Client(); await c.login('lofield');
    const r = await c.post('/api/landowners', { full_name: 'X' }, { csrf: false });
    expect(r.status).toBe(403); expect(r.data.code).toBe('csrf');
  });
  it('a signed-in POST from a foreign origin is refused even with the token', async () => {
    const c = new Client(); await c.login('lofield');
    const r = await c.post('/api/landowners', { full_name: 'X' }, { origin: 'https://evil.example' });
    expect(r.status).toBe(403); expect(r.data.code).toBe('csrf');
  });
  it('a CSRF token from one session does not work for another', async () => {
    const a = new Client(); await a.login('lofield');
    const b = new Client(); await b.login('loquetta');
    b.csrf = a.csrf;
    const r = await b.post('/api/landowners', { full_name: 'X' });
    expect(r.status).toBe(403);
  });
});

describe('authorization', () => {
  it('a read-only reader can read but not create', async () => {
    // Since 0047 the read-only reader of the landowner register is the security auditor
    // (the analyst `viewer` no longer reads it); since 0048 it holds a sensitive
    // permission (audit_logs:export), so it signs in with MFA.
    try {
      const c = await usable('audit');
      expect((await c.get('/api/landowners')).status).toBe(200);
      const r = await c.post('/api/landowners', { full_name: 'Test', father_name: 'T', cnic: '45102-0000001-1', province_code: 'SND' });
      expect(r.status).toBe(403); expect(r.data.code).toBe('forbidden');
    } finally { dropMfa(['audit']); }
  });
  it('data entry cannot read the audit trail; the security auditor can', async () => {
    try {
      const lo = await usable('lofield');
      const r = await lo.get('/api/audit');
      expect(r.status).toBe(403); expect(r.data.code).toBe('forbidden');   // the permission, not MFA, refuses it
    } finally { dropMfa(['lofield']); }
    try {
      const au = await usable('audit');   // MFA since 0048 (audit_logs:export is sensitive)
      expect((await au.get('/api/audit')).status).toBe(200);
    } finally { dropMfa(['audit']); }
  });
  it('a denial is recorded in the security log', async () => {
    const before = Number(sql(`SELECT count(*) FROM audit.auth_event WHERE event_type='authz_denied'`));
    const c = new Client(); await c.login('viewer');
    await c.post('/api/landowners', { full_name: 'Test' });
    expect(Number(sql(`SELECT count(*) FROM audit.auth_event WHERE event_type='authz_denied'`))).toBeGreaterThan(before);
  });
  it('a finance approver cannot release a payment (separation of duties)', async () => {
    const c = new Client(); const r0 = await c.login('finance');
    // finance-approver requires MFA by policy: enrol it so the permission check, not MFA, is what is tested
    await enrolTotp(c);
    const pid = sql(`SELECT id FROM lms.payment_request WHERE stage_code='Verified' LIMIT 1`);
    const r = await c.post('/api/payments', { action: 'release', payment_id: pid });
    expect(r0.status).toBe(200);
    expect(r.status).toBe(403);
  });
});

describe('province isolation through the API', () => {
  it('a Sindh officer sees only Sindh landowners; a Balochistan officer only Balochistan', async () => {
    try {
      const s = await usable('lofield');
      const b = await usable('loquetta');
      const sl = (await s.get('/api/landowners')).data.landowners as any[];
      const bl = (await b.get('/api/landowners')).data.landowners as any[];
      expect(sl.length).toBeGreaterThan(0); expect(bl.length).toBeGreaterThan(0);
      expect(new Set(sl.map((x) => x.province_code))).toEqual(new Set(['SND']));
      expect(new Set(bl.map((x) => x.province_code))).toEqual(new Set(['BAL']));
    } finally { dropMfa(['lofield', 'loquetta']); }
  });
  it('asking for another province explicitly returns nothing (no IDOR by filter)', async () => {
    try {
      const s = await usable('lofield');
      const r = await s.get('/api/landowners?province=BAL');
      expect(r.status).toBe(200);
      expect(r.data.landowners).toEqual([]);
    } finally { dropMfa(['lofield']); }
  });
  it('a Balochistan case cannot be advanced by a Sindh account (object id manipulation)', async () => {
    const caseBal = sql(`SELECT id FROM lms.compensation_case WHERE province_code='BAL' LIMIT 1`);
    try {
      const n = await usable('nego');
      const r = await n.post(`/api/cases/${caseBal}/transition`, { to_stage: 'Checked' });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.data.code).not.toBe('mfa_required');   // refused for the province, not for MFA
    } finally { dropMfa(['nego']); }
    expect(sql(`SELECT stage_code FROM lms.compensation_case WHERE id='${caseBal}'`)).not.toBe('Checked');
  });
});

async function enrolTotp(c: Client): Promise<{ secret: string; codes: string[] }> {
  const s = await c.post('/api/auth/mfa/totp/start');
  expect(s.status).toBe(200);
  const code = await generate({ secret: s.data.secret });
  const k = await c.post('/api/auth/mfa/totp/confirm', { code });
  expect(k.status).toBe(200);
  return { secret: s.data.secret, codes: k.data.recoveryCodes };
}

describe('MFA', () => {
  let secret = ''; let codes: string[] = [];
  it('a land manager must enrol before using the system', async () => {
    sql(`DELETE FROM iam.mfa_totp WHERE user_id=(SELECT id FROM lms.app_user WHERE username='mland');
         DELETE FROM iam.mfa_recovery_code WHERE user_id=(SELECT id FROM lms.app_user WHERE username='mland')`);
    const c = new Client(); const r = await c.login('mland');
    expect(r.data.mfaEnrollmentRequired).toBe(true);
    const p = await c.get('/api/payments');
    expect(p.status).toBe(403); expect(p.data.code).toBe('mfa_required');
    ({ secret, codes } = await enrolTotp(c));
    expect(codes).toHaveLength(10);
    expect((await c.get('/api/payments')).status).toBe(200);
  });
  it('recovery codes and the TOTP secret are not stored in the clear', () => {
    expect(sql(`SELECT count(*) FROM iam.mfa_recovery_code WHERE encode(verifier,'escape') LIKE '%${codes[0]}%'`)).toBe('0');
    expect(sql(`SELECT position('${secret}' IN encode(secret_ct,'escape')) FROM iam.mfa_totp WHERE user_id=(SELECT id FROM lms.app_user WHERE username='mland')`)).toBe('0');
  });
  it('the next sign-in asks for a code, and a code cannot be replayed', async () => {
    const c = new Client(); const r = await c.login('mland');
    expect(r.data.mfaRequired).toBe(true);
    expect(c.cookies.size).toBe(0);            // no session until the second factor
    const code = await generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 });
    const ok = await c.post('/api/auth/mfa/verify', { challenge: r.data.challenge, code });
    expect(ok.status).toBe(200);
    const d = new Client(); const r2 = await d.login('mland');
    const replay = await d.post('/api/auth/mfa/verify', { challenge: r2.data.challenge, code });
    expect(replay.status).toBe(401);
  });
  it('a recovery code works exactly once', async () => {
    const c = new Client(); const r = await c.login('mland');
    expect((await c.post('/api/auth/mfa/verify', { challenge: r.data.challenge, code: codes[0], method: 'recovery' })).status).toBe(200);
    const d = new Client(); const r2 = await d.login('mland');
    expect((await d.post('/api/auth/mfa/verify', { challenge: r2.data.challenge, code: codes[0], method: 'recovery' })).status).toBe(401);
  });
  it('a challenge allows five attempts, then expires', async () => {
    const c = new Client(); const r = await c.login('mland');
    for (let i = 0; i < 5; i++) await c.post('/api/auth/mfa/verify', { challenge: r.data.challenge, code: '000000' });
    const last = await c.post('/api/auth/mfa/verify', { challenge: r.data.challenge, code: await generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 }) });
    expect(last.status).toBe(401); expect(last.data.code).toBe('challenge_expired');
    sql(`UPDATE iam.account_security SET failed_count=0, locked_until=NULL WHERE user_id=(SELECT id FROM lms.app_user WHERE username='mland')`);
  });

  const MLAND = `(SELECT id FROM lms.app_user WHERE username='mland')`;
  const unlock = () => sql(`UPDATE iam.account_security SET failed_count=0, locked_until=NULL WHERE user_id=${MLAND}`);
  const futureCode = () => generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 });
  /** n six-digit codes that are certainly wrong (none valid in the ±1 step window). */
  const wrongCodes = async (n: number, from: number) => {
    const t = Math.floor(Date.now() / 1000);
    const valid = new Set(await Promise.all([-60, -30, 0, 30, 60].map((d) => generate({ secret, epoch: t + d }))));
    const out: string[] = [];
    for (let x = from; out.length < n; x++) if (!valid.has(String(x))) out.push(String(x));
    return out;
  };
  const recentMfa = (outcome: string) => Number(sql(`SELECT count(*) FROM audit.auth_event
    WHERE event_type='mfa' AND outcome='${outcome}' AND user_id=${MLAND} AND occurred_at > now() - interval '2 minutes'`));
  const unusedRecovery = () => sql(`SELECT count(*) FROM iam.mfa_recovery_code WHERE user_id=${MLAND} AND used_at IS NULL`);

  it('a locked account cannot finish signing in, even with a valid code, and its challenge is spent', async () => {
    unlock();
    const c = new Client(); const r = await c.login('mland');
    expect(r.data.mfaRequired).toBe(true);
    expect(r.data.methods).toEqual(['totp', 'recovery']);   // only the factors this account has
    sql(`UPDATE iam.account_security SET locked_until = now() + interval '10 minutes' WHERE user_id=${MLAND}`);
    try {
      const v = await c.post('/api/auth/mfa/verify', { challenge: r.data.challenge, code: await futureCode() });
      expect(v.status).toBe(401); expect(v.data.code).toBe('challenge_expired');
      expect(c.cookies.size).toBe(0);
      expect(recentMfa('locked_out')).toBeGreaterThan(0);
      expect(lastIp(`event_type='mfa' AND outcome='locked_out' AND user_id=${MLAND}`)).not.toBe('');
    } finally { unlock(); }
    // unlocked again, the same challenge is still refused (it was spent), but a new sign-in works
    expect((await c.post('/api/auth/mfa/verify', { challenge: r.data.challenge, code: codes[1], method: 'recovery' })).data.code).toBe('challenge_expired');
    const d = new Client(); const r2 = await d.login('mland');
    expect((await d.post('/api/auth/mfa/verify', { challenge: r2.data.challenge, code: codes[1], method: 'recovery' })).status).toBe(200);
  });

  it('a suspended account cannot finish signing in', async () => {
    unlock();
    const c = new Client(); const r = await c.login('mland');
    const unused = unusedRecovery();
    sql(`UPDATE lms.app_user SET status='Suspended' WHERE username='mland'`);
    try {
      const v = await c.post('/api/auth/mfa/verify', { challenge: r.data.challenge, code: codes[2], method: 'recovery' });
      expect(v.status).toBe(401);
      expect(c.cookies.size).toBe(0);
    } finally { sql(`UPDATE lms.app_user SET status='Active' WHERE username='mland'`); }
    expect(unusedRecovery()).toBe(unused);   // the refused attempt did not spend the code
  });

  it('attempts are counted atomically: ten concurrent wrong codes on one challenge are at most five guesses', async () => {
    unlock();
    sql(`UPDATE lms.system_setting SET value='1000' WHERE key='security.max_failed_logins'`);   // the cap, not the lockout, is under test
    try {
      const c = new Client(); const r = await c.login('mland');
      const before = recentMfa('mfa_failed');
      const guesses = await wrongCodes(10, 100000);
      const all = await Promise.all(guesses.map((code) => c.post('/api/auth/mfa/verify', { challenge: r.data.challenge, code })));
      expect(all.filter((x) => x.data.code === 'invalid_code').length).toBe(5);
      expect(all.filter((x) => x.data.code === 'challenge_expired').length).toBe(5);
      expect(recentMfa('mfa_failed') - before).toBe(5);
      // the challenge is spent: a valid code no longer works on it
      expect((await c.post('/api/auth/mfa/verify', { challenge: r.data.challenge, code: codes[3], method: 'recovery' })).data.code).toBe('challenge_expired');
      expect(c.cookies.size).toBe(0);
    } finally {
      sql(`UPDATE lms.system_setting SET value='5' WHERE key='security.max_failed_logins'`);
      unlock();
    }
  });

  it('second-factor failures count towards the account lockout', async () => {
    unlock();
    const c = new Client(); const r = await c.login('mland');
    for (const code of await wrongCodes(5, 200000))
      expect((await c.post('/api/auth/mfa/verify', { challenge: r.data.challenge, code })).data.code).toBe('invalid_code');
    expect(sql(`SELECT locked_until > now() FROM iam.account_security WHERE user_id=${MLAND}`)).toBe('t');
    // locked: the password step now refuses even the right password
    expect((await new Client().login('mland')).status).toBe(401);
    unlock();
  });
});

describe('MFA policy follows sensitive permissions, not only role codes', () => {
  beforeAll(() => sql(`DELETE FROM iam.mfa_totp WHERE user_id=(SELECT id FROM lms.app_user WHERE username='dmfield');
                       DELETE FROM iam.mfa_recovery_code WHERE user_id=(SELECT id FROM lms.app_user WHERE username='dmfield')`));
  it('a case approver (approval authority, outside the listed roles) must enrol', async () => {
    const c = new Client(); const r = await c.login('dmfield');
    expect(r.status).toBe(200);
    expect(r.data.mfaEnrollmentRequired).toBe(true);
    const me = await c.get('/api/auth/me');
    expect(me.data.mfa.required).toBe(true);
    expect(me.data.mfa.enrolmentOutstanding).toBe(true);
  });
  it('an account with no sensitive permission is not asked to', async () => {
    const c = new Client(); const r = await c.login('viewer');
    expect(r.data.mfaEnrollmentRequired).toBe(false);
    expect((await c.get('/api/auth/me')).data.mfa.required).toBe(false);
  });
  it('a custom role carrying one sensitive permission makes MFA required', async () => {
    sql(`INSERT INTO iam.role(code, name, description, is_system, db_role_code)
           VALUES ('p5-mfa-probe', 'MFA policy probe', 'Test role: one sensitive permission', false, 'Viewer') ON CONFLICT (code) DO NOTHING;
         INSERT INTO iam.role_permission(role_id, permission_id, scope_level)
           SELECT r.id, p.id, 'global' FROM iam.role r, iam.permission p
           WHERE r.code = 'p5-mfa-probe' AND p.resource = 'audit_logs' AND p.action = 'export' ON CONFLICT DO NOTHING`);
    expect(sql(`SELECT is_sensitive FROM iam.permission WHERE resource='audit_logs' AND action='export'`)).toBe('t');
    sql(`INSERT INTO iam.user_role(user_id, role_id) SELECT u.id, r.id FROM lms.app_user u, iam.role r
         WHERE u.username = 'viewer' AND r.code = 'p5-mfa-probe'`);
    try {
      const r = await new Client().login('viewer');
      expect(r.status).toBe(200);
      expect(r.data.mfaEnrollmentRequired).toBe(true);
    } finally {
      sql(`UPDATE iam.user_role SET revoked_at = now(), revoked_by = '00000000-0000-0000-0000-000000000001'
           WHERE role_id = (SELECT id FROM iam.role WHERE code = 'p5-mfa-probe') AND revoked_at IS NULL`);
    }
    expect((await new Client().login('viewer')).data.mfaEnrollmentRequired).toBe(false);
  });
});

describe('password sign-in against a directory (provider)', () => {
  it('an unknown directory is reported as unavailable, never as a crash or a dead end', async () => {
    const r = await new Client().post('/api/auth/login', { username: 'someone', password: 'whatever-password', provider: 'no-such-directory' });
    expect(r.status).toBe(503);
    expect(r.data.code).toBe('provider_unavailable');
    expect(r.data.error).toBe(SIGNIN_UNAVAILABLE_MESSAGE);
  });
  it('a malformed provider name gets the generic answer', async () => {
    const r = await new Client().post('/api/auth/login', { username: 'someone', password: 'whatever-password', provider: '../../etc/passwd' });
    expect(r.status).toBe(401);
    expect(r.data.error).toBe(GENERIC);
  });
  // AUTH-05: directory failures carry the client address, so they count toward
  // the per-address limit like local ones. Needs the test IdP's LDAP server and
  // the 'test-ldap' provider row that tests/iam/sso.test.ts creates (and reuses);
  // it is switched on for this test only.
  it('a directory failure is logged with the client address and counts toward the per-address limit', async (ctx) => {
    const LDAP = `name='test-ldap' AND kind='ldap'`;
    const was = sql(`SELECT enabled FROM iam.auth_provider WHERE ${LDAP} AND last_test_ok IS TRUE`);
    if (!was) { ctx.skip(); return; }   // run tests/iam/sso.test.ts once first
    sql(`UPDATE iam.auth_provider SET enabled=true WHERE ${LDAP}`);
    try {
      const local = `ldap-ip-local-${Date.now()}`, probe = `ldap-ip-probe-${Date.now()}`;
      await new Client().login(local, 'not-a-password-5');
      const ip = lastIp(`event_type='login' AND username_tried='${local}'`);
      expect(ip).not.toBe('');
      const win = `iam.setting_num('iam.rate_limit_window_minutes',15)::integer`;
      const before = Number(sql(`SELECT by_ip FROM iam.failure_counts(NULL, '${ip}'::inet, ${win})`));

      const r = await new Client().post('/api/auth/login', { username: probe, password: 'not-a-password-6', provider: 'test-ldap' });
      expect(r.status).toBe(401);
      expect(r.data.error).toBe(GENERIC);
      expect(sql(`SELECT outcome FROM audit.auth_event WHERE event_type='login' AND username_tried='${probe}'
                  AND metadata->>'method'='ldap' ORDER BY id DESC LIMIT 1`)).toBe('unknown_user');
      expect(lastIp(`event_type='login' AND username_tried='${probe}'`)).toBe(ip);
      expect(Number(sql(`SELECT by_ip FROM iam.failure_counts(NULL, '${ip}'::inet, ${win})`))).toBeGreaterThan(before);
    } finally {
      sql(`UPDATE iam.auth_provider SET enabled=${was === 't'} WHERE ${LDAP}`);
    }
  });
});

describe('re-authentication', () => {
  it('shares the lockout: failures count, and nothing is checked while locked', async () => {
    const VIEWER = `(SELECT id FROM lms.app_user WHERE username='viewer')`;
    sql(`UPDATE iam.account_security SET failed_count=0, locked_until=NULL WHERE user_id=${VIEWER}`);
    const c = new Client(); expect((await c.login('viewer')).status).toBe(200);
    try {
      for (let i = 0; i < 5; i++) expect((await c.post('/api/auth/reauth', { password: `wrong-${i}` })).status).toBe(401);
      const locked = await c.post('/api/auth/reauth', { password: PW.viewer });
      expect(locked.status).toBe(429); expect(locked.data.code).toBe('locked');
    } finally { sql(`UPDATE iam.account_security SET failed_count=0, locked_until=NULL WHERE user_id=${VIEWER}`); }
    expect((await c.post('/api/auth/reauth', { password: PW.viewer })).status).toBe(200);
  });
  it('changing your password shares it too: guesses at the current one lock the account', async () => {
    const VIEWER = `(SELECT id FROM lms.app_user WHERE username='viewer')`;
    sql(`UPDATE iam.account_security SET failed_count=0, locked_until=NULL WHERE user_id=${VIEWER}`);
    const c = new Client(); expect((await c.login('viewer')).status).toBe(200);
    try {
      for (let i = 0; i < 5; i++)
        expect((await c.post('/api/auth/password', { currentPassword: `wrong-${i}`, newPassword: 'a long unused passphrase 77' })).data.code).toBe('bad_current');
      const r = await c.post('/api/auth/password', { currentPassword: PW.viewer, newPassword: 'a long unused passphrase 77' });
      expect(r.status).toBe(429); expect(r.data.code).toBe('locked');
    } finally { sql(`UPDATE iam.account_security SET failed_count=0, locked_until=NULL WHERE user_id=${VIEWER}`); }
    expect((await new Client().login('viewer')).status).toBe(200);   // the password did not change
  });
});

describe('lockout, rate limiting and revocation', () => {
  it('five wrong passwords lock the account, after which even the right one fails', async () => {
    // The per-username rate limit counts failures from earlier runs still inside
    // its window (the security log is append-only, so they cannot be cleared).
    // sradmpnj is used by no other test, so its failures cannot rate-limit them.
    // Raise it for this test so the lockout, not the limiter, is what is tested.
    sql(`UPDATE lms.system_setting SET value='1000' WHERE key='iam.rate_limit_per_user'`);
    for (let i = 0; i < 5; i++) await new Client().login('sradmpnj', 'wrong-password-' + i);
    const r = await new Client().login('sradmpnj');
    expect(r.status).toBe(401);
    expect(sql(`SELECT locked_until > now() FROM iam.account_security WHERE user_id=(SELECT id FROM lms.app_user WHERE username='sradmpnj')`)).toBe('t');
    sql(`UPDATE iam.account_security SET failed_count=0, locked_until=NULL WHERE user_id=(SELECT id FROM lms.app_user WHERE username='sradmpnj')`);
    sql(`UPDATE lms.system_setting SET value='10' WHERE key='iam.rate_limit_per_user'`);
  });
  it('repeated failures for one username are rate-limited with 429', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await new Client().login('ratelimit-probe', 'x-' + i)).status;
    expect(last).toBe(429);
  });
  it('suspending an account ends its live sessions immediately', async () => {
    try {
      const c = await usable('sradmin');
      expect((await c.get('/api/landowners')).status).toBe(200);
      sql(`UPDATE lms.app_user SET status='Suspended' WHERE username='sradmin'`);
      expect((await c.get('/api/landowners')).status).toBe(401);
      sql(`UPDATE lms.app_user SET status='Active' WHERE username='sradmin'`);
      expect((await c.get('/api/landowners')).status).toBe(401);   // reinstating does not revive the old session
    } finally { dropMfa(['sradmin']); }
  });
  it('removing a role takes effect on the next request', async () => {
    const c = await usable('audit');   // MFA since 0048 (audit_logs:export is sensitive)
    expect((await c.get('/api/audit')).status).toBe(200);
    sql(`UPDATE iam.user_role SET revoked_at=now(), revoked_by='00000000-0000-0000-0000-000000000001'
         WHERE user_id=(SELECT id FROM lms.app_user WHERE username='audit') AND revoked_at IS NULL`);
    expect((await c.get('/api/audit')).status).toBe(403);
    sql(`INSERT INTO iam.user_role(user_id, role_id) SELECT u.id, r.id FROM lms.app_user u, iam.role r WHERE u.username='audit' AND r.code='security-auditor'`);
    dropMfa(['audit']);
  });
  it('logout ends the session; the old cookie is useless', async () => {
    const c = new Client(); await c.login('lofield');
    const saved = new Map(c.cookies);
    expect((await c.post('/api/auth/logout')).status).toBe(200);
    c.cookies = saved;
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });
});

describe('source address', () => {
  // The suite talks to the server directly, so with the default
  // TRUST_PROXY_HOPS=0 the address recorded is the one Next.js took from the socket.
  it('a sign-in records the client address on the event and on the session', async () => {
    const c = new Client();
    expect((await c.login('lofield')).status).toBe(200);
    expect(lastIp(`event_type='login' AND outcome='success' AND username_tried='lofield'`)).not.toBe('');
    const tok = [...c.cookies.values()][0];
    expect(sql(`SELECT source_ip IS NOT NULL FROM lms.login_session WHERE token_sha256 = sha256(convert_to('${tok}','utf8'))`)).toBe('t');
  });
  it('a failed sign-in and a denied request record it too', async () => {
    const probe = `ip-probe-${Date.now()}`;
    await new Client().login(probe, 'not-a-password-1');
    expect(lastIp(`event_type='login' AND username_tried='${probe}'`)).not.toBe('');
    const v = new Client(); await v.login('viewer');
    await v.post('/api/landowners', { full_name: 'Test' });
    expect(lastIp(`event_type='authz_denied' AND username_tried='viewer'`)).not.toBe('');
  });
  it('a forged X-Forwarded-For list is not believed', async () => {
    const probe = `xff-probe-${Date.now()}`;
    await new Client().post('/api/auth/login', { username: probe, password: 'whatever-password' },
      { headers: { 'x-forwarded-for': '203.0.113.7, 198.51.100.9' } });
    const ip = lastIp(`event_type='login' AND username_tried='${probe}'`);
    expect(ip).not.toBe('203.0.113.7');
    expect(ip).not.toBe('198.51.100.9');
  });
  it('the per-address limit is live: past it, even a correct password from that address is refused', async () => {
    const probe = `ip-limit-${Date.now()}`;
    await new Client().login(probe, 'not-a-password-2');
    const ip = lastIp(`event_type='login' AND username_tried='${probe}'`);
    expect(ip).not.toBe('');
    const used = Number(sql(`SELECT by_ip FROM iam.failure_counts('${probe}', '${ip}'::inet,
                               iam.setting_num('iam.rate_limit_window_minutes',15)::integer)`));
    sql(`UPDATE lms.system_setting SET value='${used + 2}' WHERE key='iam.rate_limit_per_ip'`);
    try {
      await new Client().login(`${probe}-a`, 'not-a-password-3');
      await new Client().login(`${probe}-b`, 'not-a-password-4');
      const r = await new Client().login('viewer');
      expect(r.status).toBe(429);
      expect(r.data.code).toBe('rate_limited');
    } finally {
      sql(`UPDATE lms.system_setting SET value='${HIGH_IP_LIMIT}' WHERE key='iam.rate_limit_per_ip'`);
    }
    expect((await new Client().login('viewer')).status).toBe(200);
  });
});

describe('password change', () => {
  // Put the fixture back so later suites can sign in as legal.
  afterAll(() => resetPassword('legal'));
  it('needs the current password, enforces policy, and signs out other sessions', async () => {
    const a = new Client(); await a.login('legal');
    const b = new Client(); await b.login('legal');
    expect((await a.post('/api/auth/password', { currentPassword: 'wrong', newPassword: 'a-long-new-password-1' })).status).toBe(400);
    expect((await a.post('/api/auth/password', { currentPassword: PW.legal, newPassword: 'short' })).status).toBe(400);
    expect((await a.post('/api/auth/password', { currentPassword: PW.legal, newPassword: 'password123' })).status).toBe(400);
    const np = 'correct horse battery staple 42';
    expect((await a.post('/api/auth/password', { currentPassword: PW.legal, newPassword: np })).status).toBe(200);
    expect((await a.get('/api/auth/me')).status).toBe(200);    // this session kept
    expect((await b.get('/api/auth/me')).status).toBe(401);    // the other one ended
    expect((await new Client().login('legal', np)).status).toBe(200);
    // and it cannot be set back to the previous one
    expect((await a.post('/api/auth/password', { currentPassword: np, newPassword: PW.legal })).status).toBe(400);
  });
  it('a stored hash is Argon2id, never plaintext or bcrypt', () => {
    expect(sql(`SELECT password_hash LIKE '$argon2id$%' FROM lms.app_user WHERE username='legal'`)).toBe('t');
  });
  it('the audit trail does not contain password hashes', () => {
    expect(sql(`SELECT count(*) FROM audit.audit_event WHERE entity='app_user' AND (new_data ? 'password_hash' OR old_data ? 'password_hash') AND occurred_at > now() - interval '1 hour'`)).toBe('0');
  });
});

describe('single sign-on simulator', () => {
  it('is off: the passwordless "SSO" routes do nothing', async () => {
    const c = new Client();
    expect((await c.get('/api/auth/sso/login?user=admin')).status).toBe(404);
    expect((await c.post('/api/auth/sso/callback', { username: 'admin' })).status).toBe(404);
    expect(c.cookies.size).toBe(0);
  });
  it('metadata no longer claims protocols that are not implemented', async () => {
    const r = await new Client().get('/api/auth/sso/metadata');
    // Real SAML/OIDC/LDAP exist now: each protocol is reported as it stands ('configured'
    // once sso.test has set a provider up), never as more than that.
    for (const k of ['oidc', 'saml', 'ldap']) expect(['configured', 'not configured']).toContain(r.data.protocols[k]);
    expect(JSON.stringify(r.data)).not.toMatch(/ACTIVE/);
  });
});

describe('errors do not leak internals', () => {
  it('a database error becomes a generic message with a correlation id', async () => {
    const c = new Client(); await c.login('lofield');
    const r = await c.post('/api/auth/password', { currentPassword: 'x'.repeat(2000), newPassword: 'y' });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.data)).not.toMatch(/SELECT|lms\.|iam\.|at .*\.ts/);
  });
});
