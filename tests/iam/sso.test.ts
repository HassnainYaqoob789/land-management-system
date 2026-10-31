import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { generate } from 'otplib';
import { BASE, Client, PW, sql } from './client';
import { PENDING_APPROVAL_MESSAGE, SIGNIN_FAILED_MESSAGE, SIGNIN_UNAVAILABLE_MESSAGE } from '../../src/lib/iam/signin-methods';

// Identity administration and external sign-in (package P4), through the API
// as a browser would use it. Needs the server on IAM_TEST_BASE, started with
// APP_ORIGIN equal to the test IdPs' app origin and NODE_EXTRA_CA_CERTS set to
// their CA, and the test IdPs (scripts/test-idp/server.mjs) — real OIDC, SAML
// and LDAPS servers — described by IAM_TEST_IDP_CONFIG (their config.json).

/** Every body any response in this file returned, to prove no secret leaks. */
const SEEN: string[] = [];
class Recorder extends Client {
  override async req(method: string, path: string, body?: unknown, opts?: Parameters<Client['req']>[3]) {
    const r = await super.req(method, path, body, opts);
    SEEN.push(typeof r.data === 'string' ? r.data : JSON.stringify(r.data));
    for (const sc of r.setCookie) SEEN.push(sc);
    return r;
  }
  /** Confirm it's you: a fresh re-authentication for privileged changes. */
  async reauth(user: string) {
    const r = await this.post('/api/auth/reauth', { password: PW[user] });
    expect(r.status).toBe(200);
  }
}

const userId = (u: string) => sql(`SELECT id FROM lms.app_user WHERE username = '${u}'`);

/** Sign in a fixture account, enrolling TOTP when the policy requires it. */
async function signIn(user: string): Promise<Recorder> {
  sql(`DELETE FROM iam.mfa_recovery_code WHERE user_id = '${userId(user)}'; DELETE FROM iam.mfa_totp WHERE user_id = '${userId(user)}'`);
  sql(`UPDATE iam.account_security SET failed_count = 0, locked_until = NULL WHERE user_id = '${userId(user)}'`);
  const c = new Recorder();
  const r = await c.login(user);
  expect(r.status).toBe(200);
  const me = await c.get('/api/auth/me');
  if (me.data.mfa?.enrolmentOutstanding) {
    const s = await c.post('/api/auth/mfa/totp/start');
    expect(s.status).toBe(200);
    expect((await c.post('/api/auth/mfa/totp/confirm', { code: await generate({ secret: s.data.secret }) })).status).toBe(200);
  }
  expect((await c.get('/api/auth/me')).data.mfa?.enrolmentOutstanding ?? false).toBe(false);
  return c;
}

const setting = (key: string) => sql(`SELECT value::text FROM lms.system_setting WHERE key = '${key}'`);

// ---------------------------------------------------------------------------
// Settings: identity / security policy is visible and editable only to the
// identity permissions, and only through the validating routine.
// ---------------------------------------------------------------------------
describe('settings and identity policy (UI-11, AUTHZ-24, AUTHZ-16, IAMDB-08)', () => {
  let admin: Recorder, clerk: Recorder, auditor: Recorder;
  const before = { minLen: '', maxFailed: '' };
  beforeAll(async () => {
    before.minLen = setting('security.password_min_length');
    before.maxFailed = setting('security.max_failed_logins');
    admin = await signIn('admin');
    // Since 0047 no system role reads settings without identity_settings:read, so the
    // clerk gets a test role holding settings:read alone (removed in afterAll).
    sql(`INSERT INTO iam.role (code, name, description, db_role_code) VALUES ('t-settings-reader', 'T settings reader', 'sso.test: settings:read only', 'User')
           ON CONFLICT (code) DO NOTHING;
         INSERT INTO iam.role_permission (role_id, permission_id, scope_level)
           SELECT r.id, p.id, 'global' FROM iam.role r, iam.permission p
            WHERE r.code = 't-settings-reader' AND p.resource = 'settings' AND p.action = 'read' ON CONFLICT DO NOTHING;
         INSERT INTO iam.user_role (user_id, role_id, reason)
           SELECT u.id, r.id, 'sso.test settings clerk' FROM lms.app_user u, iam.role r
            WHERE u.username = 'lofield' AND r.code = 't-settings-reader'
              AND NOT EXISTS (SELECT 1 FROM iam.user_role x WHERE x.user_id = u.id AND x.role_id = r.id AND x.revoked_at IS NULL)`);
    clerk = await signIn('lofield');      // data-entry + settings:read only
    auditor = await signIn('audit');      // security-auditor: identity_settings:read
  });
  afterAll(() => {
    sql(`UPDATE iam.user_role SET revoked_at = now(), revoke_reason = 'sso.test done'
          WHERE revoked_at IS NULL AND role_id = (SELECT id FROM iam.role WHERE code = 't-settings-reader')`);
    sql(`UPDATE lms.system_setting SET value = '${before.minLen}'::jsonb WHERE key = 'security.password_min_length'`);
    sql(`UPDATE lms.system_setting SET value = '${before.maxFailed}'::jsonb WHERE key = 'security.max_failed_logins'`);
  });

  it('a reader without identity_settings:read sees no iam.* or security.* setting, nor their history', async () => {
    const r = await clerk.get('/api/settings');
    expect(r.status).toBe(200);
    const keys: string[] = r.data.settings.map((s: any) => s.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((k) => k.startsWith('iam.') || k.startsWith('security.'))).toEqual([]);
    expect(r.data.setting_history.filter((h: any) => /^(iam|security)\./.test(h.key))).toEqual([]);
    expect(JSON.stringify(r.data)).not.toMatch(/mfa_required_roles|rate_limit|lockout_minutes|max_failed_logins/);
    expect(r.data.policy_visible).toBe(false);
    expect((await clerk.get('/api/settings/policy')).status).toBe(403);
  });

  it('a security auditor reads the policy but cannot change it', async () => {
    const r = await auditor.get('/api/settings');
    expect(r.status).toBe(200);
    expect(r.data.settings.map((s: any) => s.key)).toContain('iam.lockout_minutes');
    const p = await auditor.get('/api/settings/policy');
    expect(p.status).toBe(200);
    expect(p.data.policy.map((s: any) => s.key)).toContain('security.max_failed_logins');
    const w = await auditor.req('PUT', '/api/settings/policy', { key: 'security.max_failed_logins', value: 7 });
    expect(w.status).toBe(403);
    expect(setting('security.max_failed_logins')).toBe(before.maxFailed);
  });

  it('the general settings endpoint refuses policy keys instead of writing them unvalidated', async () => {
    await admin.reauth('admin');
    for (const [key, value] of [['security.password_min_length', 1], ['security.max_failed_logins', 1000000],
      ['security.session_minutes', 525600], ['iam.local_login_enabled', false], ['workflow.admin_override', true]] as const) {
      const r = await admin.req('PUT', '/api/settings', { key, value });
      expect(r.status, key).toBe(400);
      expect(r.data.code).toBe('policy_setting');
    }
    expect(setting('security.password_min_length')).toBe(before.minLen);
  });

  it('policy changes go through iam.set_policy: out-of-range and wrongly typed values are refused', async () => {
    await admin.reauth('admin');
    const bad = [['security.password_min_length', 1], ['security.max_failed_logins', 1000000],
      ['security.session_minutes', 525600], ['iam.session_absolute_hours', '12h'], ['iam.reauth_minutes', 0],
      ['workflow.admin_override', true], ['iam.provisioning_mode', 'everyone']] as const;
    for (const [key, value] of bad) {
      const r = await admin.req('PUT', '/api/settings/policy', { key, value });
      expect([400, 403], `${key}=${JSON.stringify(value)}`).toContain(r.status);
      expect(JSON.stringify(r.data)).not.toMatch(/SELECT|stack|at .*\.ts/);
    }
    expect(setting('security.password_min_length')).toBe(before.minLen);
    expect((await admin.req('PUT', '/api/settings/policy', { key: 'finance.wht_pct', value: 10 })).status).toBe(400);
  });

  it('a valid policy change is applied and recorded as a security event', async () => {
    await admin.reauth('admin');
    const r = await admin.req('PUT', '/api/settings/policy', { key: 'security.max_failed_logins', value: 6, note: 'sso.test' });
    expect(r.status).toBe(200);
    expect(setting('security.max_failed_logins')).toBe('6');
    expect(Number(sql(`SELECT count(*) FROM audit.auth_event WHERE event_type = 'policy_changed'
      AND metadata->>'setting' = 'security.max_failed_logins' AND occurred_at > now() - interval '5 minutes'`))).toBeGreaterThan(0);
    expect((await admin.req('PUT', '/api/settings/policy', { key: 'security.max_failed_logins', value: Number(before.maxFailed) })).status).toBe(200);
  });

  it('without settings:update the general endpoint is forbidden', async () => {
    expect((await clerk.req('PUT', '/api/settings', { key: 'grievance.target_days', value: 20 })).status).toBe(403);
  });

  it('a privileged change needs a recent re-authentication', async () => {
    const token = [...admin.cookies.values()][0];
    sql(`UPDATE lms.login_session SET started_at = now() - interval '2 hours', reauth_at = NULL
         WHERE token_sha256 = sha256(convert_to('${token}', 'utf8'))`);
    const r = await admin.req('PUT', '/api/settings/policy', { key: 'security.max_failed_logins', value: Number(before.maxFailed) });
    expect(r.status).toBe(403);
    expect(r.data.code).toBe('reauth_required');
    await admin.reauth('admin');
    expect((await admin.req('PUT', '/api/settings/policy', { key: 'security.max_failed_logins', value: Number(before.maxFailed) })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// External sign-in: OIDC, SAML and LDAP against the real test IdPs, set up by
// an administrator through the API (AUTH-02, UA-03).
// ---------------------------------------------------------------------------
const IDP_FILE = process.env.IAM_TEST_IDP_CONFIG;
const IDP = IDP_FILE ? JSON.parse(readFileSync(IDP_FILE, 'utf8')) : null;
const NAMES = { oidc: 'test-oidc', saml: 'test-saml', ldap: 'test-ldap' } as const;   // test-oidc: the redirect URI the OIDC IdP registered
type Kind = keyof typeof NAMES;
const RESET: Record<Kind, Record<string, string>> = { oidc: { groups_claim: 'reset' }, saml: { attr_email: 'reset' }, ldap: { email_attribute: 'reset' } };
type Resp = Awaited<ReturnType<Client['req']>>;

/** HTTPS to the OIDC test IdP, trusting only its throwaway CA. */
function idpHttps(u: string, o: { method?: string; body?: string; cookie?: string } = {}): Promise<{ status: number; location: string | null; cookies: string[]; text: string }> {
  const ca = readFileSync(IDP.caFile);
  return new Promise((resolve, reject) => {
    const req = https.request(new URL(u), { method: o.method ?? 'GET', ca, headers: {
      ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: (res.headers.location as string) ?? null,
        cookies: (res.headers['set-cookie'] as string[]) ?? [], text }));
    });
    req.on('error', reject); if (o.body) req.write(o.body); req.end();
  });
}

/** Drive the OIDC IdP's sign-in (and consent) pages until it redirects back to the LMS. */
async function oidcIdpLogin(authUrl: string, user: string): Promise<URL> {
  const jar = new Map<string, string>();
  let next = authUrl, method = 'GET', body: string | undefined;
  for (let step = 0; step < 20; step++) {
    const r = await idpHttps(next, { method, body, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') });
    for (const sc of r.cookies) { const [kv] = sc.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    method = 'GET'; body = undefined;
    if (r.location) {
      const to = new URL(r.location, next);
      if (to.pathname.startsWith(`/api/auth/oidc/${NAMES.oidc}/callback`)) return to;
      next = to.href; continue;
    }
    const action = /<form[^>]*action="([^"]+)"/.exec(r.text)?.[1];
    if (!action) throw new Error(`OIDC IdP page without a form (${r.status}) at ${next}`);
    next = new URL(action.replace(/&amp;/g, '&'), next).href; method = 'POST';
    body = new URLSearchParams(r.text.includes('name="login"') ? { prompt: 'login', login: user, password: 'any' } : { prompt: 'consent' }).toString();
  }
  throw new Error('the OIDC IdP did not redirect back');
}

/** OIDC end to end in one "browser" (the client's cookie jar). */
async function oidcSignIn(app: Recorder, user: string): Promise<Resp> {
  const start = await app.get(`/api/auth/oidc/${NAMES.oidc}/start`);
  expect(start.status).toBe(303);
  const cb = await oidcIdpLogin(start.headers.get('location')!, user);
  return app.get(cb.pathname + cb.search);
}

/** SAML: the IdP's sign-in form, then its auto-posted SAMLResponse. */
async function samlIdpResponse(ssoUrl: string, user: string): Promise<string> {
  const page = await (await fetch(ssoUrl)).text();
  const t = /name="t" value="([^"]+)"/.exec(page)?.[1];
  if (!t) throw new Error('SAML IdP sign-in form not found');
  const html = await (await fetch(new URL('/saml/login', ssoUrl), { method: 'POST', body: new URLSearchParams({ t, user }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' } })).text();
  return /name="SAMLResponse" value="([^"]+)"/.exec(html)![1];
}
/** The IdP page's cross-site POST: from the IdP origin, without the LMS's cookies. */
async function postAcs(samlResponse: string): Promise<{ status: number; location: string | null; text: string }> {
  const r = await fetch(`${BASE}/api/auth/saml/${NAMES.saml}/acs`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: new URL(IDP.saml.entryPoint).origin },
    body: new URLSearchParams({ SAMLResponse: samlResponse, RelayState: '' }) });
  const text = await r.text(); SEEN.push(text);
  return { status: r.status, location: r.headers.get('location'), text };
}
async function samlSignIn(app: Recorder, user: string, finisher: Recorder = app): Promise<{ final: Resp | null; acs: { status: number; text: string }; samlResponse: string }> {
  const start = await app.get(`/api/auth/saml/${NAMES.saml}/start`);
  expect(start.status).toBe(303);
  const samlResponse = await samlIdpResponse(start.headers.get('location')!, user);
  const acs = await postAcs(samlResponse);
  if (acs.status !== 303 || !acs.location) return { final: null, acs, samlResponse };
  const to = new URL(acs.location, BASE);
  return { final: await finisher.get(to.pathname + to.search), acs, samlResponse };
}

const ldapSignIn = (app: Recorder, user: string, password = IDP.people[user].password) =>
  app.post('/api/auth/login', { username: user, password, provider: NAMES.ldap });

const sessionSet = (r: Resp) => r.setCookie.some((c) => /lms_session=[^;]/.test(c) && !/max-age=0/i.test(c));
const subjectOf = (kind: Kind, user: string) => (kind === 'ldap' ? `uuid-${user}` : user);
const roleCodes = (role: string) => sql(`SELECT string_agg(p.resource || ':' || p.action, ',' ORDER BY 1)
  FROM iam.role r JOIN iam.role_permission rp ON rp.role_id = r.id JOIN iam.permission p ON p.id = rp.permission_id WHERE r.code = '${role}'`).split(',');

describe.skipIf(!IDP)('external sign-in through OIDC, SAML and LDAP (AUTH-02, UA-03)', () => {
  let admin: Recorder;
  const ids: Partial<Record<Kind, string>> = {};
  const configs = () => ({
    oidc: { config: { issuer: IDP.oidc.issuer, client_id: IDP.oidc.client_id, scopes: 'openid email profile groups' }, secret: IDP.oidc.client_secret },
    saml: { config: { idp_entity_id: IDP.saml.issuer, sso_url: IDP.saml.entryPoint, idp_certificate: IDP.saml.certPem } },
    ldap: { config: { url: IDP.ldap.url, bind_dn: IDP.ldap.bindDn, base_dn: IDP.ldap.userBase, user_filter: IDP.ldap.userFilter,
                      group_attribute: IDP.ldap.groupAttribute, ca_certificate: IDP.ldap.caPem }, secret: IDP.ldap.bindPassword },
  });
  const identity = async () => { const r = await admin.get('/api/settings/identity'); expect(r.status).toBe(200); return r.data; };
  async function approve(kind: Kind, user: string) {
    const req = (await identity()).requests.find((q: any) => q.providerName === NAMES[kind] && q.subject === subjectOf(kind, user) && q.status === 'pending');
    expect(req, `pending request for ${user} via ${kind}`).toBeTruthy();
    await admin.reauth('admin');
    const r = await admin.post(`/api/settings/identity/requests/${req.id}`, { decision: 'approve', note: 'sso.test' });
    expect(r.status).toBe(200);
  }
  async function meOf(app: Recorder) {
    const me = await app.get('/api/auth/me');
    expect(me.status).toBe(200);
    return me.data;
  }

  beforeAll(async () => {
    // Re-runnable: forget what earlier runs linked, requested and mapped for
    // these three providers (the provider rows themselves are reused).
    const linked = `SELECT user_id FROM iam.external_identity WHERE provider_id IN (SELECT id FROM iam.auth_provider WHERE name IN ('test-oidc','test-saml','test-ldap'))`;
    sql(`UPDATE lms.login_session SET ended_at = now(), end_reason = 'revoked' WHERE ended_at IS NULL AND user_id IN (${linked});
         UPDATE iam.user_role SET revoked_at = now() WHERE revoked_at IS NULL AND user_id IN (${linked});
         UPDATE lms.app_user SET username = 'old-' || substr(md5(random()::text), 1, 20) WHERE username LIKE 'ext-%' AND id IN (${linked});
         DELETE FROM iam.external_identity WHERE provider_id IN (SELECT id FROM iam.auth_provider WHERE name IN ('test-oidc','test-saml','test-ldap'));
         DELETE FROM iam.provisioning_request WHERE provider_id IN (SELECT id FROM iam.auth_provider WHERE name IN ('test-oidc','test-saml','test-ldap'));
         DELETE FROM iam.group_mapping WHERE provider_id IN (SELECT id FROM iam.auth_provider WHERE name IN ('test-oidc','test-saml','test-ldap'));
         UPDATE lms.system_setting SET value = '"approval"' WHERE key = 'iam.provisioning_mode'`);
    sql(`UPDATE iam.account_security SET failed_count = 0, locked_until = NULL`);
    admin = await signIn('admin');
  });

  it('an administrator creates (or re-saves) each provider; it starts disabled and cannot be enabled untested', async () => {
    const existing = (await identity()).providers;
    for (const kind of Object.keys(NAMES) as Kind[]) {
      await admin.reauth('admin');
      const { config, secret } = (configs() as any)[kind];
      const found = existing.find((p: any) => p.name === NAMES[kind]);
      // Re-saving an unchanged configuration keeps its old test result, so an
      // earlier run's provider is first changed (which disables it) and then
      // given the real settings again.
      if (found) expect((await admin.req('PUT', `/api/settings/identity/providers/${found.id}`,
        { config: { ...config, ...RESET[kind] } })).status).toBe(200);
      const r = found
        ? await admin.req('PUT', `/api/settings/identity/providers/${found.id}`, { displayName: `Test ${kind.toUpperCase()}`, config, secret })
        : await admin.post('/api/settings/identity/providers', { kind, name: NAMES[kind], displayName: `Test ${kind.toUpperCase()}`, config, secret });
      expect([200, 201], JSON.stringify(r.data)).toContain(r.status);
      ids[kind] = r.data.provider.id;
      expect(r.data.provider.enabled).toBe(false);
      expect(r.data.provider.status).toBe('untested');
      expect(r.data.provider.hasSecret).toBe(kind !== 'saml');
      const on = await admin.req('PUT', `/api/settings/identity/providers/${ids[kind]}/enabled`, { enabled: true });
      expect(on.status).toBe(409);
      expect(on.data.code).toBe('untested');
    }
  });

  it('invalid provider settings are refused with the field named', async () => {
    await admin.reauth('admin');
    const bad = [
      { kind: 'ldap', name: 'bad-ldap', displayName: 'Bad', config: { ...configs().ldap.config, url: 'ldap://localhost:389' }, secret: 'x' },
      { kind: 'ldap', name: 'bad-ldap', displayName: 'Bad', config: { ...configs().ldap.config, user_filter: '(uid=*)' }, secret: 'x' },
      { kind: 'oidc', name: 'bad-oidc', displayName: 'Bad', config: { ...configs().oidc.config, issuer: 'http://idp.example' }, secret: 'x' },
      { kind: 'oidc', name: 'bad-oidc', displayName: 'Bad', config: configs().oidc.config },
      { kind: 'saml', name: 'bad-saml', displayName: 'Bad', config: { ...configs().saml.config, idp_certificate: 'not a certificate' } },
      { kind: 'saml', name: 'Bad Name!', displayName: 'Bad', config: configs().saml.config },
    ];
    for (const b of bad) {
      const r = await admin.post('/api/settings/identity/providers', b);
      expect(r.status, JSON.stringify(b).slice(0, 80)).toBe(400);
      expect(r.data.code).toBe('validation');
    }
    expect(sql(`SELECT count(*) FROM iam.auth_provider WHERE name LIKE 'bad-%'`)).toBe('0');
  });

  it('"Test connection" checks each provider for real and records the result; then it can be enabled', async () => {
    for (const kind of Object.keys(NAMES) as Kind[]) {
      await admin.reauth('admin');
      const t = await admin.post(`/api/settings/identity/providers/${ids[kind]}/test`);
      expect(t.status).toBe(200);
      expect(t.data.ok, `${kind}: ${t.data.detail}`).toBe(true);
      expect(sql(`SELECT last_test_ok FROM iam.auth_provider WHERE id = '${ids[kind]}'`)).toBe('t');
      const on = await admin.req('PUT', `/api/settings/identity/providers/${ids[kind]}/enabled`, { enabled: true });
      expect(on.status).toBe(200);
      expect(on.data.provider.status).toBe('available');
    }
    expect(Number(sql(`SELECT count(*) FROM audit.auth_event WHERE event_type = 'provider_test' AND occurred_at > now() - interval '5 minutes'`))).toBeGreaterThanOrEqual(3);
  });

  it('a failing test is recorded as failed, and the provider is unavailable until it passes again', async () => {
    await admin.reauth('admin');
    const wrong = await admin.req('PUT', `/api/settings/identity/providers/${ids.ldap}`, { secret: 'wrong-bind-password' });
    expect(wrong.status).toBe(200);
    expect(wrong.data.provider).toMatchObject({ enabled: false, status: 'untested' });   // a new secret is untested
    const t = await admin.post(`/api/settings/identity/providers/${ids.ldap}/test`);
    expect(t.status).toBe(200);
    expect(t.data.ok).toBe(false);
    expect(t.data.detail).not.toContain('wrong-bind-password');
    expect(t.data.provider.status).toBe('test_failed');
    expect((await admin.req('PUT', `/api/settings/identity/providers/${ids.ldap}/enabled`, { enabled: true })).status).toBe(409);
    const opts = await new Recorder().get('/api/auth/options');
    expect(opts.data.providers.find((p: any) => p.name === NAMES.ldap)).toMatchObject({ available: false, startUrl: null });
    // the right secret again
    await admin.reauth('admin');
    expect((await admin.req('PUT', `/api/settings/identity/providers/${ids.ldap}`, { secret: IDP.ldap.bindPassword })).status).toBe(200);
    expect((await admin.post(`/api/settings/identity/providers/${ids.ldap}/test`)).data.ok).toBe(true);
    expect((await admin.req('PUT', `/api/settings/identity/providers/${ids.ldap}/enabled`, { enabled: true })).status).toBe(200);
  });

  it('group mappings are explicit, and a privileged role cannot be mapped', async () => {
    await admin.reauth('admin');
    // data-entry holds sensitive permissions (import:update, mutations:update):
    // the database refuses to hand it out by directory group.
    const refused = await admin.post('/api/settings/identity/mappings', { providerId: ids.oidc, externalGroup: 'LMS-LandOfficers', roleCode: 'data-entry' });
    expect(refused.status).toBe(403);
    for (const kind of Object.keys(NAMES) as Kind[]) {
      const r = await admin.post('/api/settings/identity/mappings', { providerId: ids[kind], externalGroup: 'LMS-LandOfficers', roleCode: 'viewer' });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
    }
    const dup = await admin.post('/api/settings/identity/mappings', { providerId: ids.oidc, externalGroup: 'LMS-LandOfficers', roleCode: 'viewer' });
    expect(dup.status).toBe(409);
    const view = await identity();
    expect(view.roles.find((r: any) => r.code === 'system-administrator').mappable).toBe(false);
    expect(view.roles.find((r: any) => r.code === 'viewer').mappable).toBe(true);
  });

  it('the sign-in options list the providers as available, with no configuration', async () => {
    const r = await new Recorder().get('/api/auth/options');
    expect(r.status).toBe(200);
    expect(typeof r.data.local).toBe('boolean');
    expect(typeof r.data.passkey).toBe('boolean');
    for (const kind of Object.keys(NAMES) as Kind[]) {
      const p = r.data.providers.find((x: any) => x.name === NAMES[kind]);
      expect(p).toMatchObject({ kind, available: true, startUrl: kind === 'ldap' ? null : `/api/auth/${kind}/${NAMES[kind]}/start` });
      expect(Object.keys(p).sort()).toEqual(['available', 'displayName', 'kind', 'name', 'startUrl']);
    }
    expect(JSON.stringify(r.data)).not.toMatch(/issuer|client_id|bind_dn|certificate|localhost:(4010|4020|6636)/);
  });

  for (const kind of Object.keys(NAMES) as Kind[]) {
    const signInAs = async (app: Recorder, user: string): Promise<Resp> =>
      kind === 'oidc' ? oidcSignIn(app, user) : kind === 'saml' ? (await samlSignIn(app, user)).final! : ldapSignIn(app, user);

    it(`${kind}: a first sign-in waits for an administrator and makes no session`, async () => {
      for (const user of ['ext.officer', 'ext.nobody']) {
        const app = new Recorder();
        const r = await signInAs(app, user);
        expect(r.status, `${user}: ${String(JSON.stringify(r.data)).slice(0, 200)}`).toBe(403);
        expect(JSON.stringify(r.data)).toContain(PENDING_APPROVAL_MESSAGE);
        expect(sessionSet(r)).toBe(false);
        expect((await app.get('/api/auth/me')).status).toBe(401);
      }
    });

    it(`${kind}: once approved, the mapped group gives exactly the mapped role`, async () => {
      await approve(kind, 'ext.officer');
      const app = new Recorder();
      const r = await signInAs(app, 'ext.officer');
      expect([200, 303], String(JSON.stringify(r.data)).slice(0, 200)).toContain(r.status);
      expect(sessionSet(r)).toBe(true);
      if (kind !== 'ldap') expect(r.headers.get('location')).toMatch(/\/dashboard$/);
      const me = await meOf(app);
      expect(me.roles).toEqual(['viewer']);
      expect([...new Set(me.permissions as string[])].sort()).toEqual(roleCodes('viewer').sort());
      expect(me.session.method).toBe(kind);
      expect((await app.get('/api/projects')).status).toBe(200);            // viewer: projects:read (0047)
      expect((await app.post('/api/projects', { name: 'X' })).status).toBe(403);
    });

    it(`${kind}: a person in no mapped group gets no role at all`, async () => {
      await approve(kind, 'ext.nobody');
      const app = new Recorder();
      const r = await signInAs(app, 'ext.nobody');
      expect(sessionSet(r)).toBe(true);
      const me = await meOf(app);
      expect(me.roles).toEqual([]);
      expect(me.permissions).toEqual([]);
      expect((await app.get('/api/landowners')).status).toBe(403);
      expect(sql(`SELECT count(*) FROM iam.user_role ur JOIN iam.external_identity e ON e.user_id = ur.user_id
        WHERE e.provider_id = '${ids[kind]}' AND e.subject = '${subjectOf(kind, 'ext.nobody')}' AND ur.revoked_at IS NULL`)).toBe('0');
    });
  }

  it('saml: a replayed response is refused', async () => {
    const { final, samlResponse } = await samlSignIn(new Recorder(), 'ext.officer');
    expect(sessionSet(final!)).toBe(true);
    const again = await postAcs(samlResponse);
    expect(again.status).toBe(400);
    expect(again.text).toContain(SIGNIN_FAILED_MESSAGE);
    expect(again.location).toBeNull();
  });

  it('saml: a response finished in another browser is refused (login CSRF)', async () => {
    const attacker = new Recorder(), victim = new Recorder();
    const { final } = await samlSignIn(attacker, 'ext.officer', victim);
    expect(final!.status).toBe(400);
    expect(sessionSet(final!)).toBe(false);
  });

  it('saml: a tampered response is refused', async () => {
    const start = await new Recorder().get(`/api/auth/saml/${NAMES.saml}/start`);
    const xml = Buffer.from(await samlIdpResponse(start.headers.get('location')!, 'ext.nobody'), 'base64').toString();
    const forged = Buffer.from(xml.replace('<saml:AttributeValue>External Unmapped', '<saml:AttributeValue>Someone Else')).toString('base64');
    expect((await postAcs(forged)).status).toBe(400);
  });

  it('oidc: a tampered or replayed state is refused, and so is a callback in another browser', async () => {
    const app = new Recorder();
    const start = await app.get(`/api/auth/oidc/${NAMES.oidc}/start`);
    const cb = await oidcIdpLogin(start.headers.get('location')!, 'ext.officer');
    const tampered = new URL(cb); tampered.searchParams.set('state', cb.searchParams.get('state')!.slice(0, -2) + 'xx');
    const t = await app.get(tampered.pathname + tampered.search);
    expect(t.status).toBe(400);
    expect(String(t.data)).toContain(SIGNIN_FAILED_MESSAGE);
    expect(sessionSet(t)).toBe(false);

    const other = new Recorder();
    const s2 = await app.get(`/api/auth/oidc/${NAMES.oidc}/start`);
    const cb2 = await oidcIdpLogin(s2.headers.get('location')!, 'ext.officer');
    expect((await other.get(cb2.pathname + cb2.search)).status).toBe(400);   // not this browser's sign-in
    expect((await app.get(cb2.pathname + cb2.search)).status).toBe(400);     // and the state is now used up

    const s3 = await app.get(`/api/auth/oidc/${NAMES.oidc}/start`);
    const cb3 = await oidcIdpLogin(s3.headers.get('location')!, 'ext.officer');
    const ok = await app.get(cb3.pathname + cb3.search);
    expect(sessionSet(ok)).toBe(true);
    expect((await new Recorder().get(cb3.pathname + cb3.search)).status).toBe(400);   // replay
  });

  it('ldap: wrong password, unknown person and filter injection get the same answer', async () => {
    // ext.auditor for the wrong password, so repeated runs never rate-limit the officer.
    for (const [u, p] of [['ext.auditor', 'wrong-password'], ['nobody-here', 'whatever'], ['*', IDP.people['ext.officer'].password],
      ['ext.officer)(uid=*', IDP.people['ext.officer'].password]]) {
      const r = await new Recorder().post('/api/auth/login', { username: u, password: p, provider: NAMES.ldap });
      expect(r.status, u).toBe(401);
      expect(r.data.code).toBe('invalid');
    }
  });

  it('automatic provisioning creates the account with no role until a mapping applies', async () => {
    await admin.reauth('admin');
    expect((await admin.req('PUT', '/api/settings/policy', { key: 'iam.provisioning_mode', value: 'auto' })).status).toBe(200);
    try {
      const app = new Recorder();
      const r = await oidcSignIn(app, 'ext.auditor');    // LMS-Auditors: not mapped
      expect(sessionSet(r)).toBe(true);
      const me = await meOf(app);
      expect(me.roles).toEqual([]);
      expect(me.permissions).toEqual([]);
    } finally {
      await admin.reauth('admin');
      expect((await admin.req('PUT', '/api/settings/policy', { key: 'iam.provisioning_mode', value: 'approval' })).status).toBe(200);
    }
  });

  it('a changed configuration disables the provider until it passes a new test', async () => {
    await admin.reauth('admin');
    const rename = await admin.req('PUT', `/api/settings/identity/providers/${ids.saml}`, { displayName: 'Test SAML (renamed)' });
    expect(rename.data.provider.enabled).toBe(true);
    const changed = await admin.req('PUT', `/api/settings/identity/providers/${ids.saml}`,
      { displayName: 'Test SAML', config: { ...configs().saml.config, attr_name: 'cn' } });
    expect(changed.status).toBe(200);
    expect(changed.data.retestRequired).toBe(true);
    expect(changed.data.provider).toMatchObject({ enabled: false, status: 'untested' });
  });

  it('a disabled or untested provider is shown as unavailable, and its start answers with the message', async () => {
    await admin.reauth('admin');
    expect((await admin.req('PUT', `/api/settings/identity/providers/${ids.ldap}/enabled`, { enabled: false })).status).toBe(200);
    const opts = await new Recorder().get('/api/auth/options');
    for (const name of [NAMES.saml, NAMES.ldap])
      expect(opts.data.providers.find((p: any) => p.name === name)).toMatchObject({ available: false, startUrl: null });
    const start = await new Recorder().get(`/api/auth/saml/${NAMES.saml}/start`);
    expect(start.status).toBe(503);
    expect(String(start.data)).toContain(SIGNIN_UNAVAILABLE_MESSAGE);
    expect(String(start.data)).not.toMatch(/at .*\.(ts|js):\d+|Error:/);
    const json = await new Recorder().req('GET', `/api/auth/saml/${NAMES.saml}/start`, undefined, { headers: { accept: 'application/json' } });
    expect(json.data).toMatchObject({ error: SIGNIN_UNAVAILABLE_MESSAGE, code: 'signin_unavailable' });
    const ldap = await ldapSignIn(new Recorder(), 'ext.officer');
    expect(ldap.status).toBe(503);
    expect(ldap.data.error).toBe(SIGNIN_UNAVAILABLE_MESSAGE);
    expect((await new Recorder().get('/api/auth/oidc/no-such-provider/start')).status).toBe(503);

    // Put both back for whoever runs next (the browser tests use them).
    await admin.reauth('admin');
    expect((await admin.post(`/api/settings/identity/providers/${ids.saml}/test`)).data.ok).toBe(true);
    for (const kind of ['saml', 'ldap'] as Kind[])
      expect((await admin.req('PUT', `/api/settings/identity/providers/${ids[kind]}/enabled`, { enabled: true })).status).toBe(200);
  });

  it('only identity administrators may see or change any of this', async () => {
    const clerk = await signIn('lofield'), auditor = await signIn('audit');
    expect((await clerk.get('/api/settings/identity')).status).toBe(403);
    const view = await auditor.get('/api/settings/identity');
    expect(view.status).toBe(200);
    expect(view.data.canConfigure).toBe(false);
    expect((await auditor.post('/api/settings/identity/providers', { kind: 'saml', name: 'auditor-saml', displayName: 'X', config: configs().saml.config })).status).toBe(403);
    expect((await auditor.post(`/api/settings/identity/providers/${ids.oidc}/test`)).status).toBe(403);
    expect((await auditor.req('PUT', `/api/settings/identity/providers/${ids.oidc}/enabled`, { enabled: false })).status).toBe(403);
    expect((await auditor.post('/api/settings/identity/mappings', { providerId: ids.oidc, externalGroup: 'G', roleCode: 'viewer' })).status).toBe(403);
    expect(sql(`SELECT enabled FROM iam.auth_provider WHERE id = '${ids.oidc}'`)).toBe('t');
  });

  it('secrets are stored encrypted and never appear in any response', () => {
    const secrets = [IDP.oidc.client_secret, IDP.ldap.bindPassword];
    const everything = SEEN.join('\n');
    for (const s of secrets) {
      expect(everything.includes(s)).toBe(false);
      expect(sql(`SELECT count(*) FROM iam.secret WHERE position(convert_to('${s}', 'utf8') IN ciphertext) > 0`)).toBe('0');
      expect(sql(`SELECT count(*) FROM iam.auth_provider WHERE config::text LIKE '%${s}%'`)).toBe('0');
      expect(sql(`SELECT count(*) FROM audit.auth_event WHERE metadata::text LIKE '%${s}%'`)).toBe('0');
    }
    expect(everything.length).toBeGreaterThan(1000);   // the recorder really saw the traffic
  });
});
