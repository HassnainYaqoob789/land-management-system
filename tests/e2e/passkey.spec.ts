import { test, expect, type CDPSession, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Passkeys (package P3) in a real browser: add a passkey on the security page,
// sign out, sign in with it (no username), then remove it with confirmation.
// The authenticator is Chrome's CDP virtual authenticator (a platform
// authenticator with resident keys and user verification), so this runs in
// the Chromium desktop project only. The server's APP_ORIGIN must be the
// BASE_URL origin on "localhost" (WebAuthn needs a domain, not an IP).
// Passwords come from IAM_TEST_PASSWORDS; state is reset with psql on
// IAM_TEST_DB, as tests/iam/client.ts does.

const PW: Record<string, string> = process.env.IAM_TEST_PASSWORDS
  ? JSON.parse(readFileSync(process.env.IAM_TEST_PASSWORDS, 'utf8')) : {};
const DB = process.env.IAM_TEST_DB || 'lms_iam_test';
const USER = 'dmqta';            // used by no other suite
const LABEL = 'E2E laptop';
const id = `(SELECT id FROM lms.app_user WHERE username='${USER}')`;

function sql(q: string): string {
  return execFileSync('psql', ['-At', '-q', '-U', 'lms_migrator', '-d', DB, '-c',
    `SET ROLE lms_owner; SET lms.actor_id='00000000-0000-0000-0000-000000000001'; ${q}`], { encoding: 'utf8' }).replace(/\r/g, '').trim();   // psql on Windows: CRLF
}
const reset = () => sql(`UPDATE iam.account_security SET failed_count=0, locked_until=NULL WHERE user_id=${id};
  DELETE FROM iam.mfa_webauthn WHERE user_id=${id}; DELETE FROM iam.mfa_recovery_code WHERE user_id=${id}; DELETE FROM iam.mfa_totp WHERE user_id=${id}`);

async function virtualAuthenticator(page: Page): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
      automaticPresenceSimulation: true },
  });
  return { cdp, authenticatorId };
}

const me = (page: Page) => page.evaluate(async () => {
  const r = await fetch('/api/auth/me');
  return { status: r.status, body: r.ok ? await r.json() : null };
});

test.describe('passkeys', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'chromium', 'the CDP virtual authenticator is driven from the desktop Chromium project');
    test.skip(!PW[USER], 'IAM_TEST_PASSWORDS is not set; this flow needs a real account');
    reset();
  });
  test.afterEach(() => { if (PW[USER]) reset(); });

  test('register a passkey, sign out, sign in with it, then remove it', async ({ page }) => {
    const opts = await (await page.request.get('/api/auth/options')).json();
    test.skip(opts.passkey !== true, 'passkeys are unavailable at this origin (APP_ORIGIN must be https or http://localhost)');
    const { cdp, authenticatorId } = await virtualAuthenticator(page);

    // 1. Password sign-in, then the security page.
    await page.goto('/login');
    await page.locator('#lgU').fill(USER);
    await page.locator('#lgP').fill(PW[USER]);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(/\/(dashboard|account\/security)/);
    await page.goto('/account/security');

    // 2. Add a passkey with a name.
    const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Passkeys', exact: true }) });
    await expect(card).toBeVisible();
    await card.getByLabel('Name for the new passkey').fill(LABEL);
    await card.getByRole('button', { name: 'Add a passkey' }).click();
    await expect(card.getByRole('status')).toContainText(`Passkey “${LABEL}” added`);
    const table = card.getByRole('region', { name: 'Your passkeys' });
    await expect(table.getByRole('cell', { name: LABEL, exact: true })).toBeVisible();
    const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
    expect(credentials).toHaveLength(1);
    expect(credentials[0].isResidentCredential).toBe(true);
    expect(sql(`SELECT label FROM iam.mfa_webauthn WHERE user_id=${id}`)).toBe(LABEL);

    // 3. Sign out.
    expect(await page.evaluate(async () => {
      const { csrfToken } = await (await fetch('/api/auth/me')).json();
      return (await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } })).status;
    })).toBe(200);
    await page.goto('/login');
    expect((await me(page)).status).toBe(401);

    // 4. Sign in with the passkey, no username (discoverable credential).
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await page.waitForURL(/\/dashboard/);
    const session = await me(page);
    expect(session.status).toBe(200);
    expect(session.body.user.username).toBe(USER);
    expect(session.body.session).toMatchObject({ method: 'passkey', mfaSatisfied: true });

    // 5. Remove it, after confirming.
    await page.goto('/account/security');
    await expect(table.getByRole('cell', { name: LABEL, exact: true })).toBeVisible();
    await card.getByRole('button', { name: `Remove passkey ${LABEL}` }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove this passkey?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Remove passkey' }).click();
    await expect(card.getByRole('status')).toContainText(`Passkey “${LABEL}” removed`);
    await expect(table).toContainText('You have no passkeys yet.');
    expect(sql(`SELECT count(*) FROM iam.mfa_webauthn WHERE user_id=${id}`)).toBe('0');

    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
  });

  test('without WebAuthn the page explains the fallback instead of offering the button', async ({ page }) => {
    // Hide WebAuthn from the page before any script runs.
    await page.addInitScript(() => { Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true }); });
    await page.goto('/login');
    await page.locator('#lgU').fill(USER);
    await page.locator('#lgP').fill(PW[USER]);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(/\/(dashboard|account\/security)/);
    await page.goto('/account/security');
    const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Passkeys', exact: true }) });
    await expect(card).toContainText('does not support passkeys');
    await expect(card.getByRole('button', { name: 'Add a passkey' })).toHaveCount(0);
  });
});
