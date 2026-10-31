import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BASE, Client, PW, sql, resetPassword } from './client';

// Self-service password recovery (package P5), end to end through the API and
// the real mail path. The server must send through the test IdP's SMTP sink
// (scripts/test-idp/server.mjs), e.g.
//   SMTP_HOST=127.0.0.1 SMTP_PORT=2525 SMTP_CA_FILE=<idp dir>/ca.pem SMTP_FROM=lms-noreply@lms.invalid
// and IAM_TEST_IDP_CONFIG names the sink's config.json, where this file finds
// the directory every message is saved to (one .eml per message).

const CONFIG = process.env.IAM_TEST_IDP_CONFIG;
const MAILDIR: string = CONFIG ? JSON.parse(readFileSync(CONFIG, 'utf8')).smtp.mailDir : '';
const USER = 'lopnj';   // a fixture no other suite signs in as; its password is restored afterwards
const UID = `(SELECT id FROM lms.app_user WHERE username='${USER}')`;
const HIGH = '100000';
const NEW_PASSWORD = `recovered lantern harbour ${Date.now()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const setting = (key: string) => sql(`SELECT value FROM lms.system_setting WHERE key='${key}'`);
const setLimit = (key: string, v: string) => sql(`UPDATE lms.system_setting SET value='${v}' WHERE key='${key}'`);
let savedPerUser = '10';
let email = '';

beforeAll(() => {
  if (!CONFIG) throw new Error('Set IAM_TEST_IDP_CONFIG to the test IdP config.json (scripts/test-idp/server.mjs writes it).');
  // Many requests for one account from one address: the limits are held out of
  // the way here and tested on their own below (per-address stays high, as in auth.test.ts).
  savedPerUser = setting('iam.rate_limit_per_user') || '10';
  setLimit('iam.rate_limit_per_user', HIGH);
  setLimit('iam.rate_limit_per_ip', HIGH);
  sql(`UPDATE iam.account_security SET failed_count=0, locked_until=NULL WHERE user_id=${UID};
       DELETE FROM iam.mfa_recovery_code WHERE user_id=${UID}; DELETE FROM iam.mfa_totp WHERE user_id=${UID}`);
  email = sql(`SELECT email FROM lms.app_user WHERE username='${USER}'`);
  expect(email).toMatch(/@/);
});
afterAll(() => {
  setLimit('iam.rate_limit_per_user', savedPerUser);
  resetPassword(USER);
});

const forgot = (username: string, opts?: { headers?: Record<string, string> }) =>
  new Client().post('/api/auth/password/forgot', { username }, opts);
const redeem = (body: Record<string, unknown>) => new Client().post('/api/auth/password/reset', body);
const mailbox = () => new Set(readdirSync(MAILDIR));
/** The sink names each file "<ms>-<random>-<recipient with [^a-z0-9@.] as _>.eml". */
const forRecipient = (to: string) => `-${to.replace(/[^a-z0-9@.]/gi, '_')}.eml`;

/** The text body of a message as saved by the sink (quoted-printable or base64 decoded). */
function bodyOf(eml: string): string {
  const i = eml.search(/\r?\n\r?\n/);
  const head = eml.slice(0, i), body = eml.slice(i).replace(/^\r?\n\r?\n/, '');
  const cte = /^content-transfer-encoding:\s*([\w-]+)/im.exec(head)?.[1]?.toLowerCase();
  if (cte === 'quoted-printable') return body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  if (cte === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  return body;
}

/** The reset link in the newest message to `to` since `before` whose link still works. */
async function linkFor(to: string, before: Set<string>): Promise<{ link: string; token: string; eml: string }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const fresh = readdirSync(MAILDIR).filter((n) => !before.has(n) && n.endsWith(forRecipient(to))).sort().reverse();
    for (const f of fresh) {
      const eml = readFileSync(join(MAILDIR, f), 'utf8');
      const m = /(https?:\/\/\S+\/reset-password\?token=([A-Za-z0-9_-]+))/.exec(bodyOf(eml));
      if (m && (await redeem({ token: m[2], check: true })).status === 200) return { link: m[1], token: m[2], eml };
    }
    await sleep(250);
  }
  const why = sql(`SELECT coalesce(string_agg(DISTINCT metadata->>'reason', ','), '') FROM audit.auth_event
                   WHERE event_type='password_reset_delivery' AND outcome='failure' AND occurred_at > now() - interval '2 minutes'`);
  throw new Error(`no usable reset e-mail for ${to}${why ? ` (delivery failed: ${why}; are SMTP_* set on the server?)` : ''}`);
}
/** Ask for a reset for USER and return the link from the e-mail. */
async function requestLink() {
  const before = mailbox();
  const r = await forgot(USER);
  expect(r.status).toBe(200);
  return linkFor(email, before);
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const tokenRow = (token: string) => `token_sha256 = sha256(convert_to('${token}','utf8'))`;

describe('forgot password: nothing reveals whether an account exists', () => {
  it('same status and body for an account, a missing one, and one that cannot be recovered by e-mail', async () => {
    const system = sql(`SELECT id FROM lms.app_user WHERE username='system'`);   // service account: no password, no e-mail
    const tokensBefore = sql(`SELECT count(*) FROM iam.invitation WHERE user_id='${system}'`);
    const [a, b, c] = [await forgot(USER), await forgot(`nobody-${Date.now()}`), await forgot('system')];
    for (const r of [a, b, c]) expect(r.status).toBe(200);
    expect(b.data).toEqual(a.data);
    expect(c.data).toEqual(a.data);
    expect(sql(`SELECT count(*) FROM iam.invitation WHERE user_id='${system}'`)).toBe(tokensBefore);
    // and it never claims a message was delivered
    expect(JSON.stringify(a.data)).not.toMatch(/has been sent|was sent|delivered/i);
  });

  it('takes the same time either way (no timing oracle)', async () => {
    const yes: number[] = [], no: number[] = [];
    for (let i = 0; i < 5; i++) {
      let t = performance.now(); expect((await forgot(USER)).status).toBe(200); yes.push(performance.now() - t);
      t = performance.now(); expect((await forgot(`nobody-${Date.now()}-${i}`)).status).toBe(200); no.push(performance.now() - t);
    }
    for (const d of [...yes, ...no]) expect(d).toBeGreaterThanOrEqual(450);   // the response floor
    expect(Math.abs(median(yes) - median(no))).toBeLessThan(120);
  });

  it('each request is recorded with the source address', async () => {
    const probe = `reset-audit-${Date.now()}`;
    await forgot(probe);
    expect(sql(`SELECT count(*) FROM audit.auth_event WHERE event_type='login' AND outcome='info'
                AND metadata->>'flow'='password_reset_request' AND username_tried='${probe}' AND source_ip IS NOT NULL`)).toBe('1');
  });
});

describe('forgot password: the link', () => {
  it('arrives by e-mail on APP_ORIGIN, sets a policy-compliant password once, and ends every session', async () => {
    const a = new Client(); expect((await a.login(USER)).status).toBe(200);
    const b = new Client(); expect((await b.login(USER)).status).toBe(200);
    expect((await a.get('/api/auth/me')).status).toBe(200);

    const { link, token, eml } = await requestLink();
    expect(new URL(link).origin).toBe(new URL(BASE).origin);
    expect(eml).toMatch(/^Subject: Reset your Mari Energies LMS password/m);
    expect((await new Client().get(new URL(link).pathname + new URL(link).search)).status).toBe(200);   // the page opens

    const check = await redeem({ token, check: true });
    expect(check.data).toMatchObject({ valid: true, minLength: 12 });
    const weak = await redeem({ token, newPassword: 'short' });
    expect(weak.status).toBe(400); expect(weak.data.code).toBe('weak_password');
    const reused = await redeem({ token, newPassword: PW[USER] });                  // the current password is history
    expect(reused.status).toBe(400); expect(reused.data.code).toBe('reused');
    expect((await redeem({ token, check: true })).status).toBe(200);                // refusals do not spend the link

    expect((await redeem({ token, newPassword: NEW_PASSWORD })).status).toBe(200);
    expect((await a.get('/api/auth/me')).status).toBe(401);                         // every session ended
    expect((await b.get('/api/auth/me')).status).toBe(401);
    expect((await new Client().login(USER, NEW_PASSWORD)).status).toBe(200);
    expect((await new Client().login(USER, PW[USER])).status).toBe(401);

    // single use: the same link again is refused, and that re-use is recorded
    const again = await redeem({ token, newPassword: `${NEW_PASSWORD} again` });
    expect(again.status).toBe(400); expect(again.data.code).toBe('bad_token');
    const ref = sql(`SELECT metadata->>'link_ref' FROM audit.auth_event WHERE event_type='password_reset' AND outcome='success'
                     AND user_id=${UID} ORDER BY id DESC LIMIT 1`);
    expect(ref).not.toBe('');
    expect(Number(sql(`SELECT count(*) FROM audit.auth_event WHERE event_type='password_reset' AND outcome='denied' AND metadata->>'link_ref'='${ref}'`))).toBeGreaterThan(0);
    expect(Number(sql(`SELECT count(*) FROM audit.auth_event WHERE event_type='password_reset_delivery' AND outcome='success'
                       AND metadata->>'link_ref'='${ref}'`))).toBe(1);
    expect(Number(sql(`SELECT count(*) FROM audit.auth_event WHERE event_type='login' AND metadata->>'flow'='password_reset_request'
                       AND metadata->>'link_ref'='${ref}' AND user_id=${UID}`))).toBe(1);
  });

  it('an expired link is refused', async () => {
    const { token } = await requestLink();
    sql(`UPDATE iam.invitation SET expires_at = now() - interval '1 second' WHERE ${tokenRow(token)}`);
    expect((await redeem({ token, check: true })).status).toBe(400);
    const r = await redeem({ token, newPassword: `${NEW_PASSWORD} expired` });
    expect(r.status).toBe(400); expect(r.data.code).toBe('bad_token');
  });

  it('a newer request replaces the older link', async () => {
    const first = await requestLink();
    const second = await requestLink();
    expect(second.token).not.toBe(first.token);
    expect((await redeem({ token: first.token, check: true })).status).toBe(400);
    expect((await redeem({ token: second.token, check: true })).status).toBe(200);
  });

  it('a reset also clears an account lockout', async () => {
    const { token } = await requestLink();
    sql(`UPDATE iam.account_security SET failed_count=5, locked_until = now() + interval '10 minutes' WHERE user_id=${UID}`);
    const pw = `${NEW_PASSWORD} unlocked`;
    expect((await redeem({ token, newPassword: pw })).status).toBe(200);
    expect((await new Client().login(USER, pw)).status).toBe(200);
  });
});

describe('forgot password: rate limits', () => {
  it('per username: past the limit the answer is 429, whoever asks', async () => {
    const probe = `reset-limit-${Date.now()}`;
    setLimit('iam.rate_limit_per_user', '3');
    try {
      for (let i = 0; i < 3; i++) expect((await forgot(probe)).status).toBe(200);
      const r = await forgot(probe);
      expect(r.status).toBe(429); expect(r.data.code).toBe('rate_limited');
      expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    } finally { setLimit('iam.rate_limit_per_user', HIGH); }
  });

  it('per address', async () => {
    const probe = `reset-ip-${Date.now()}`;
    await forgot(probe);
    const ip = sql(`SELECT coalesce(host(source_ip),'') FROM audit.auth_event WHERE username_tried='${probe}' ORDER BY id DESC LIMIT 1`);
    expect(ip).not.toBe('');
    const used = Number(sql(`SELECT by_ip FROM iam.failure_counts('${probe}', '${ip}'::inet,
                               iam.setting_num('iam.rate_limit_window_minutes',15)::integer)`));
    setLimit('iam.rate_limit_per_ip', String(used + 2));
    try {
      expect((await forgot(`${probe}-a`)).status).toBe(200);
      expect((await forgot(`${probe}-b`)).status).toBe(200);
      expect((await forgot(`${probe}-c`)).status).toBe(429);
    } finally { setLimit('iam.rate_limit_per_ip', HIGH); }
  });
});
