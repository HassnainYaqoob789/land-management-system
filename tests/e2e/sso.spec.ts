import { test, expect, request, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { generate } from 'otplib';
import { PENDING_APPROVAL_MESSAGE, SIGNIN_UNAVAILABLE_MESSAGE } from '../../src/lib/iam/signin-methods';

// External sign-in in a real browser: the sign-in page, the identity
// providers' own pages (OIDC, SAML), the directory option (LDAP), the
// "awaiting approval" step and the unavailable state. The providers are the
// local test IdPs (scripts/test-idp/server.mjs, IAM_TEST_IDP_CONFIG); an
// administrator configures them through the API first. Run against the server
// whose APP_ORIGIN the OIDC test client registered (IDP config "app").

const IDP = process.env.IAM_TEST_IDP_CONFIG ? JSON.parse(readFileSync(process.env.IAM_TEST_IDP_CONFIG, 'utf8')) : null;
const PW: Record<string, string> = process.env.IAM_TEST_PASSWORDS ? JSON.parse(readFileSync(process.env.IAM_TEST_PASSWORDS, 'utf8')) : {};
const APP = (process.env.BASE_URL ?? IDP?.app ?? 'http://localhost:3041').replace(/\/$/, '');
const NAMES = { oidc: 'test-oidc', saml: 'test-saml', ldap: 'test-ldap' } as const;
type Kind = keyof typeof NAMES;

test.use({ baseURL: APP });

/** Test set-up in the test database, as its owner (like tests/iam/client.ts). */
const sql = (q: string) => execFileSync('psql', ['-At', '-q', '-U', 'lms_migrator', '-d', process.env.IAM_TEST_DB || 'lms_iam_test', '-c',
  `SET ROLE lms_owner; SET lms.actor_id='00000000-0000-0000-0000-000000000001'; ${q}`], { encoding: 'utf8' }).replace(/\r/g, '').trim();   // psql on Windows: CRLF

/** Wait briefly for an optional step (an IdP may skip its login or consent page). */
const appears = (l: ReturnType<Page['locator']>, ms: number) => l.waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
test.skip(!IDP || !PW.admin, 'IAM_TEST_IDP_CONFIG and IAM_TEST_PASSWORDS are required');

/** The administrator, through the API (cookies, Origin and CSRF like the app). */
class Admin {
  private csrf = '';
  constructor(private ctx: APIRequestContext) {}
  static async signIn(): Promise<Admin> {
    const uid = sql(`SELECT id FROM lms.app_user WHERE username = 'admin'`);
    sql(`DELETE FROM iam.mfa_recovery_code WHERE user_id = '${uid}'; DELETE FROM iam.mfa_totp WHERE user_id = '${uid}';
         UPDATE iam.account_security SET failed_count = 0, locked_until = NULL WHERE user_id = '${uid}'`);
    const a = new Admin(await request.newContext({ baseURL: APP, extraHTTPHeaders: { origin: APP } }));
    expect((await a.call('POST', '/api/auth/login', { username: 'admin', password: PW.admin })).status).toBe(200);
    const me = await a.call('GET', '/api/auth/me');
    if (me.body.mfa?.enrolmentOutstanding) {
      const s = await a.call('POST', '/api/auth/mfa/totp/start');
      expect((await a.call('POST', '/api/auth/mfa/totp/confirm', { code: await generate({ secret: s.body.secret }) })).status).toBe(200);
      await a.call('GET', '/api/auth/me');
    }
    return a;
  }
  async call(method: string, path: string, data?: unknown): Promise<{ status: number; body: any }> {
    const r = await this.ctx.fetch(path, { method, data, headers: this.csrf ? { 'x-csrf-token': this.csrf } : {} });
    const body = await r.json().catch(() => ({}));
    if (body?.csrfToken) this.csrf = body.csrfToken;
    return { status: r.status(), body };
  }
  reauth() { return this.call('POST', '/api/auth/reauth', { password: PW.admin }); }
  async identity() { const r = await this.call('GET', '/api/settings/identity'); expect(r.status).toBe(200); return r.body; }
  async setEnabled(kind: Kind, enabled: boolean) {
    const p = (await this.identity()).providers.find((x: any) => x.name === NAMES[kind]);
    await this.reauth();
    expect((await this.call('PUT', `/api/settings/identity/providers/${p.id}/enabled`, { enabled })).status).toBe(200);
  }
  /** Configure, test and enable the three providers, and map LMS-LandOfficers → viewer. */
  async ensureProviders() {
    const want: Record<Kind, { config: object; secret?: string }> = {
      oidc: { config: { issuer: IDP.oidc.issuer, client_id: IDP.oidc.client_id, scopes: 'openid email profile groups' }, secret: IDP.oidc.client_secret },
      saml: { config: { idp_entity_id: IDP.saml.issuer, sso_url: IDP.saml.entryPoint, idp_certificate: IDP.saml.certPem } },
      ldap: { config: { url: IDP.ldap.url, bind_dn: IDP.ldap.bindDn, base_dn: IDP.ldap.userBase, user_filter: IDP.ldap.userFilter,
                        group_attribute: IDP.ldap.groupAttribute, ca_certificate: IDP.ldap.caPem }, secret: IDP.ldap.bindPassword },
    };
    for (const kind of Object.keys(NAMES) as Kind[]) {
      await this.reauth();
      let p = (await this.identity()).providers.find((x: any) => x.name === NAMES[kind]);
      if (!p) {
        const r = await this.call('POST', '/api/settings/identity/providers', { kind, name: NAMES[kind], displayName: `Test ${kind.toUpperCase()}`, ...want[kind] });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        p = r.body.provider;
      }
      if (p.status !== 'available') {
        const t = await this.call('POST', `/api/settings/identity/providers/${p.id}/test`);
        expect(t.body.ok, t.body.detail).toBe(true);
        expect((await this.call('PUT', `/api/settings/identity/providers/${p.id}/enabled`, { enabled: true })).status).toBe(200);
      }
      const m = await this.call('POST', '/api/settings/identity/mappings', { providerId: p.id, externalGroup: 'LMS-LandOfficers', roleCode: 'viewer' });
      expect([201, 409]).toContain(m.status);
    }
  }
  async approve(kind: Kind, subject: string) {
    const q = (await this.identity()).requests.find((x: any) => x.providerName === NAMES[kind] && x.subject === subject && x.status === 'pending');
    expect(q, `pending request for ${subject} via ${kind}`).toBeTruthy();
    await this.reauth();
    expect((await this.call('POST', `/api/settings/identity/requests/${q.id}`, { decision: 'approve', note: 'sso.spec' })).status).toBe(200);
  }
}

/** Forget an external person's link, request and roles, so the next sign-in is a first one. */
function forget(kind: Kind, subject: string) {
  const prov = `(SELECT id FROM iam.auth_provider WHERE name = '${NAMES[kind]}')`;
  const linked = `SELECT user_id FROM iam.external_identity WHERE provider_id = ${prov} AND subject = '${subject}'`;
  sql(`UPDATE lms.login_session SET ended_at = now(), end_reason = 'revoked' WHERE ended_at IS NULL AND user_id IN (${linked});
       UPDATE iam.user_role SET revoked_at = now() WHERE revoked_at IS NULL AND user_id IN (${linked});
       UPDATE lms.app_user SET username = 'old-' || substr(md5(random()::text), 1, 20) WHERE username LIKE 'ext-%' AND id IN (${linked});
       DELETE FROM iam.external_identity WHERE provider_id = ${prov} AND subject = '${subject}';
       DELETE FROM iam.provisioning_request WHERE provider_id = ${prov} AND subject = '${subject}'`);
}

// The OIDC test IdP serves HTTPS with a throwaway CA the browser does not
// know; this context accepts it. Only the test IdP is involved.
const browse = async (browser: Browser): Promise<Page> => (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();

async function rolesOf(page: Page): Promise<string[]> {
  const me = await page.request.get('/api/auth/me');
  expect(me.status()).toBe(200);
  return (await me.json()).roles;
}

test.describe.configure({ mode: 'serial' });
test.describe('external sign-in in the browser', () => {
  let admin: Admin;
  test.beforeAll(async () => { admin = await Admin.signIn(); await admin.ensureProviders(); });

  test('the sign-in page offers each provider, and shows a disabled one as unavailable with the message', async ({ browser }) => {
    const page = await browse(browser);
    await page.goto('/login');
    await expect(page.getByRole('link', { name: 'Sign in with Test OIDC' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in with Test SAML' })).toBeVisible();
    await admin.setEnabled('saml', false);
    try {
      await page.reload();
      await expect(page.getByRole('link', { name: 'Sign in with Test SAML' })).toHaveCount(0);
      const disabled = page.getByRole('button', { name: 'Sign in with Test SAML' });
      await expect(disabled).toHaveAttribute('aria-disabled', 'true');
      await expect(page.locator('[data-signin-unavailable]', { hasText: SIGNIN_UNAVAILABLE_MESSAGE }).first()).toBeVisible();
      // Going to its start address directly says the same, with no technical detail.
      await page.goto(`/api/auth/saml/${NAMES.saml}/start`);
      await expect(page.getByText(SIGNIN_UNAVAILABLE_MESSAGE)).toBeVisible();
      await expect(page.locator('body')).not.toContainText(/Error|stack|\.ts:\d+/);
      await page.getByRole('link', { name: 'Return to sign-in' }).click();
      await expect(page).toHaveURL(/\/login$/);
    } finally {
      await admin.setEnabled('saml', true);
    }
  });

  test('OIDC: a first sign-in asks for approval; once approved it opens the dashboard with the mapped role only', async ({ browser }) => {
    forget('oidc', 'ext.officer');
    const page = await browse(browser);
    const viaOidc = async () => {
      await page.goto('/login');
      await page.getByRole('link', { name: 'Sign in with Test OIDC' }).click();
      // The IdP's own pages: sign-in (skipped once it has a session) and consent (skipped once granted).
      const login = page.locator('input[name="login"]');
      if (await appears(login, 8000)) {
        await login.fill('ext.officer');
        await page.locator('input[name="password"]').fill('irrelevant');
        await page.getByRole('button', { name: 'Sign-in' }).click();
      }
      const consent = page.getByRole('button', { name: 'Continue' });
      if (await appears(consent, 4000)) await consent.click();
    };
    await viaOidc();
    await expect(page.getByText(PENDING_APPROVAL_MESSAGE)).toBeVisible({ timeout: 20_000 });
    expect((await page.request.get('/api/auth/me')).status()).toBe(401);

    await admin.approve('oidc', 'ext.officer');
    await viaOidc();
    await page.waitForURL('**/dashboard', { timeout: 30_000 });
    expect(await rolesOf(page)).toEqual(['viewer']);
  });

  test('SAML: the IdP page posts back; first an approval request, then a session with the mapped role', async ({ browser }) => {
    forget('saml', 'ext.officer');
    const page = await browse(browser);
    const viaSaml = async () => {
      await page.goto('/login');
      await page.getByRole('link', { name: 'Sign in with Test SAML' }).click();
      await page.locator('input[name="user"]').fill('ext.officer');
      await page.getByRole('button', { name: 'Sign in' }).click();   // its page then posts the response back
    };
    await viaSaml();
    await expect(page.getByText(PENDING_APPROVAL_MESSAGE)).toBeVisible({ timeout: 20_000 });

    await admin.approve('saml', 'ext.officer');
    await viaSaml();
    await page.waitForURL('**/dashboard', { timeout: 30_000 });
    expect(await rolesOf(page)).toEqual(['viewer']);
  });

  test('LDAP: the directory option of the password form', async ({ browser }) => {
    forget('ldap', 'uuid-ext.officer');
    const page = await browse(browser);
    const viaDirectory = async () => {
      await page.goto('/login');
      await page.locator('#lgM').selectOption(NAMES.ldap);
      await page.fill('#lgU', 'ext.officer');
      await page.fill('#lgP', IDP.people['ext.officer'].password);
      await page.locator('form[aria-label="Sign in with a password"] button[type="submit"]').click();
    };
    await viaDirectory();
    await expect(page.locator('#lgErr')).toHaveText(PENDING_APPROVAL_MESSAGE);

    await admin.approve('ldap', 'uuid-ext.officer');
    await viaDirectory();
    await page.waitForURL('**/dashboard', { timeout: 30_000 });
    expect(await rolesOf(page)).toEqual(['viewer']);
  });
});
