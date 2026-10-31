import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { generate } from 'otplib';

export const BASE = process.env.IAM_TEST_BASE || 'http://localhost:3041';
export const DB = process.env.IAM_TEST_DB || 'lms_iam_test';
const PWFILE = process.env.IAM_TEST_PASSWORDS!;
export const PW: Record<string, string> = JSON.parse(readFileSync(PWFILE, 'utf8'));

/** A browser-like client: keeps its own cookies, sends Origin, attaches CSRF. */
export class Client {
  cookies = new Map<string, string>();
  csrf = '';
  constructor(public origin = BASE) {}
  cookieHeader() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(method: string, path: string, body?: unknown, opts: { csrf?: boolean; origin?: string | null; headers?: Record<string, string> } = {}) {
    const h: Record<string, string> = { ...opts.headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (this.cookies.size) h.cookie = this.cookieHeader();
    if (opts.origin !== null && method !== 'GET') h.origin = opts.origin ?? this.origin;
    if (opts.csrf !== false && this.csrf && method !== 'GET') h['x-csrf-token'] = this.csrf;
    const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const sc of r.headers.getSetCookie()) {
      const [kv] = sc.split(';'); const i = kv.indexOf('=');
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (/max-age=0/i.test(sc) || v === '') this.cookies.delete(k); else this.cookies.set(k, v);
    }
    let data: any = null; const text = await r.text();
    try { data = JSON.parse(text); } catch { data = text; }
    if (data && typeof data === 'object' && data.csrfToken) this.csrf = data.csrfToken;
    return { status: r.status, data, headers: r.headers, setCookie: r.headers.getSetCookie() };
  }
  get(p: string) { return this.req('GET', p); }
  post(p: string, b: unknown = {}, o?: any) { return this.req('POST', p, b, o); }
  async login(user: string, password = PW[user]) {
    const r = await this.post('/api/auth/login', { username: user, password });
    if (r.status === 200 && !r.data.mfaRequired) await this.get('/api/auth/me').then((m) => { if (m.data?.csrfToken) this.csrf = m.data.csrfToken; });
    return r;
  }
}

/** Direct database access for setting up and inspecting state, as the owner. */
export function sql(q: string): string {
  // The SQL goes on stdin, not as a -c argument: Windows re-encodes command-line
  // arguments to the ANSI code page (an em dash becomes 0x97, invalid UTF-8).
  // psql on Windows ends lines with CRLF; callers split on '\n', so drop the CRs.
  // --single-transaction keeps what -c gave: one transaction, so api.set_actor() in
  // the text still holds for the statements after it.
  return execFileSync('psql', ['-At', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-U', 'lms_migrator', '-d', DB, '-f', '-'],
    { encoding: 'utf8', input: `SET ROLE lms_owner; SET lms.actor_id='00000000-0000-0000-0000-000000000001'; ${q}`,
      env: { ...process.env, PGCLIENTENCODING: 'UTF8' } })
    .replace(/\r/g, '').trim();
}

/** Put an account back to its fixture password (tests change some passwords). */
export function resetPassword(user: string) {
  // The libpq host/port from PGHOST/PGPORT when set (a TCP cluster, e.g. Windows), else the /tmp socket.
  const host = process.env.PGHOST ? `${process.env.PGHOST}${process.env.PGPORT ? `:${process.env.PGPORT}` : ''}` : '';
  const dsn = host ? `postgresql://lms_migrator@${host}/${DB}` : `postgresql://lms_migrator@/${DB}?host=/tmp`;
  // npx is npx.cmd on Windows, which Node only starts through a shell.
  execFileSync('npx', ['tsx', 'scripts/iam/bootstrap.ts', '--username', user, '--password-from-env', 'P', '--no-force-change'],
    { env: { ...process.env, P: PW[user], DATABASE_URL_ADMIN: dsn }, stdio: 'ignore', shell: process.platform === 'win32' });
}

/**
 * Sign in as a fixture user and satisfy MFA when policy requires it (since
 * 0041 that includes every holder of a sensitive permission). Any stored
 * authenticator is reset first, so the helper always knows the secret it
 * enrols. Lockout counters are cleared as well: earlier tests may have
 * failed sign-ins on purpose.
 */
export async function signInAs(user: string): Promise<Client> {
  const u = user.replace(/'/g, "''");
  sql(`DELETE FROM iam.mfa_totp WHERE user_id = (SELECT id FROM lms.app_user WHERE username = '${u}');
       DELETE FROM iam.mfa_recovery_code WHERE user_id = (SELECT id FROM lms.app_user WHERE username = '${u}');
       UPDATE iam.account_security SET failed_count = 0, locked_until = NULL
        WHERE user_id = (SELECT id FROM lms.app_user WHERE username = '${u}')`);
  const c = new Client();
  const r = await c.login(user);
  if (r.status !== 200) throw new Error(`sign-in as ${user} failed: ${r.status} ${JSON.stringify(r.data)}`);
  const me = await c.get('/api/auth/me');
  if (me.data?.mfa?.enrolmentOutstanding) {
    const s = await c.post('/api/auth/mfa/totp/start');
    const done = await c.post('/api/auth/mfa/totp/confirm', { code: await generate({ secret: s.data.secret }) });
    if (done.status !== 200) throw new Error(`MFA enrolment for ${user} failed: ${done.status}`);
  }
  return c;
}
