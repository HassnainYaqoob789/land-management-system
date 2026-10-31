import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SIGNIN_UNAVAILABLE_MESSAGE } from '../../src/lib/iam/signin-methods';

// The sign-in experience (package P5) in a real browser: the Mari Energies
// logo, every method the server lists — one that cannot be used is shown as
// unavailable with the reason, never as a dead link — accessible errors, a
// sign-in done with the keyboard alone, and no horizontal scrolling at phone,
// tablet and desktop widths. Passwords come from IAM_TEST_PASSWORDS; the
// disabled-provider fixture is written with psql to IAM_TEST_DB, as
// tests/iam/client.ts does.

const PW: Record<string, string> = process.env.IAM_TEST_PASSWORDS
  ? JSON.parse(readFileSync(process.env.IAM_TEST_PASSWORDS, 'utf8')) : {};
const DB = process.env.IAM_TEST_DB || 'lms_iam_test';
const USER = 'viewer';   // read-only, no sensitive permission, so no MFA step
const GENERIC = 'Invalid credentials, or the account is unavailable.';
const OFF = { name: 'p5-e2e-off', display: 'Contoso SSO (test)' };

function sql(q: string): string {
  return execFileSync('psql', ['-At', '-q', '-U', 'lms_migrator', '-d', DB, '-c',
    `SET ROLE lms_owner; SET lms.actor_id='00000000-0000-0000-0000-000000000001'; ${q}`], { encoding: 'utf8' }).replace(/\r/g, '').trim();   // psql on Windows: CRLF
}
const needsAccount = () => test.skip(!PW[USER], 'IAM_TEST_PASSWORDS is not set; these checks need a real account');

/** The page has no horizontal scroll and the card sits inside the viewport. */
async function fitsWidth(page: Page) {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  expect(m.sw, 'no horizontal scroll').toBeLessThanOrEqual(m.w);
  const box = await page.locator('.login-card').boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(m.w + 0.5);
}

test.describe('sign-in page', () => {
  test.beforeAll(() => {
    if (!PW[USER]) return;
    const id = `(SELECT id FROM lms.app_user WHERE username='${USER}')`;
    sql(`UPDATE iam.account_security SET failed_count=0, locked_until=NULL WHERE user_id=${id};
         DELETE FROM iam.mfa_recovery_code WHERE user_id=${id}; DELETE FROM iam.mfa_totp WHERE user_id=${id}`);
  });

  test('shows the Mari Energies logo at its own aspect ratio', async ({ page }) => {
    await page.goto('/login');
    const logo = page.locator('.login-card').getByRole('img', { name: 'Mari Energies' });
    await expect(logo).toBeVisible();
    const m = await logo.evaluate((img: HTMLImageElement) => ({ nw: img.naturalWidth, nh: img.naturalHeight, w: img.clientWidth, h: img.clientHeight }));
    expect(m.nw).toBeGreaterThan(0);                       // the file loaded
    expect(Math.abs(m.w / m.h - m.nw / m.nh)).toBeLessThan(0.02);
    await expect(page.locator('.login-card h1')).toHaveText('Land Management System');
  });

  for (const [w, h] of [[360, 740], [768, 1024], [1280, 800]] as const) {
    test(`fits a ${w}px-wide screen without horizontal scrolling`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.goto('/login');
      await expect(page.locator('#lgU')).toBeVisible();
      await fitsWidth(page);
      await page.goto('/forgot-password');
      await expect(page.locator('#fpId')).toBeVisible();
      await fitsWidth(page);
    });
  }

  test('a provider that cannot be used is shown as unavailable, with the reason, not as a link', async ({ page }) => {
    test.skip(!process.env.IAM_TEST_PASSWORDS, 'needs the test database (IAM_TEST_PASSWORDS / IAM_TEST_DB)');
    sql(`INSERT INTO iam.auth_provider(kind, name, display_name, enabled, config) VALUES ('oidc', '${OFF.name}', '${OFF.display}', false, '{}')
         ON CONFLICT (name) DO UPDATE SET enabled = false, display_name = EXCLUDED.display_name`);
    try {
      const opts = await (await page.request.get('/api/auth/options')).json();
      const listed = (opts.providers as any[]).find((p) => p.name === OFF.name);
      expect(listed, 'the options API lists configured providers, usable or not').toBeTruthy();
      expect(listed.available).toBe(false);
      expect(listed.startUrl).toBeNull();
      expect(JSON.stringify(opts)).not.toMatch(/secret|client_id|bind_dn|password/i);

      await page.goto('/login');
      const label = `Sign in with ${OFF.display}`;
      const button = page.getByRole('button', { name: label });
      await expect(button).toBeVisible();
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(page.getByRole('link', { name: label })).toHaveCount(0);
      const reason = page.locator(`#${await button.getAttribute('aria-describedby')}`);
      await expect(reason).toHaveText(SIGNIN_UNAVAILABLE_MESSAGE);
      // still reachable by keyboard, so the reason is announced; activating it does nothing
      await button.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/login$/);
    } finally {
      sql(`DELETE FROM iam.auth_provider WHERE name = '${OFF.name}'`);
    }
  });

  test('the passkey option matches what the server offers', async ({ page }) => {
    await page.goto('/login');
    const opts = await (await page.request.get('/api/auth/options')).json();
    const button = page.getByRole('button', { name: 'Sign in with a passkey' });
    if (opts.passkey === true) {
      await expect(button).toBeVisible();
      await expect(button).not.toHaveAttribute('aria-disabled', 'true');
    } else if (opts.passkey === false) {
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(page.getByText(SIGNIN_UNAVAILABLE_MESSAGE).first()).toBeVisible();
    }
    await expect(page.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute('href', '/forgot-password');
  });

  test('keyboard only: type, Tab, Enter — signed in without the mouse', async ({ page }) => {
    needsAccount();
    await page.goto('/login');
    await expect(page.locator('#lgU')).toBeFocused();       // focus starts in the username field
    await page.keyboard.type(USER);
    await page.keyboard.press('Tab');
    await expect(page.locator('#lgP')).toBeFocused();
    const ring = await page.locator('#lgP').evaluate((el) => { const s = getComputedStyle(el); return s.outlineStyle !== 'none' || s.boxShadow !== 'none'; });
    expect(ring, 'the focused field shows a focus indicator').toBe(true);
    await page.keyboard.type(PW[USER]);
    await page.keyboard.press('Enter');
    await page.waitForURL('**/dashboard');
    expect((await (await page.request.get('/api/auth/me')).json()).user.username).toBe(USER);
  });

  test('a wrong password is announced as an alert and keeps the user on the page', async ({ page }) => {
    needsAccount();
    await page.goto('/login');
    await page.locator('#lgU').fill(USER);
    await page.locator('#lgP').fill('definitely-not-the-password');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toHaveText(GENERIC);
    await expect(page.locator('#lgP')).toHaveValue('');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('#lgP')).toBeFocused();
  });

  test('an empty form is explained, not sent', async ({ page }) => {
    await page.goto('/login');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toHaveText('Enter your username.');
    await expect(page.locator('#lgU')).toHaveAttribute('aria-invalid', 'true');
  });

  test('forgot password is reachable by keyboard and never claims delivery', async ({ page }) => {
    await page.goto('/login');
    const link = page.getByRole('link', { name: 'Forgot password?' });
    await link.focus();
    await page.keyboard.press('Enter');
    await page.waitForURL('**/forgot-password');
    await expect(page.locator('.login-card').getByRole('img', { name: 'Mari Energies' })).toBeVisible();
    await expect(page.locator('#fpId')).toBeFocused();
    await page.keyboard.type(`e2e-nobody-${Date.now()}`);
    await page.keyboard.press('Enter');
    const status = page.getByRole('status');
    await expect(status).toContainText('Request received');
    await expect(status).not.toContainText(/has been sent|was sent|delivered/i);
  });

  test('a reset link that does not work says so before anything is typed', async ({ page }) => {
    await page.goto('/reset-password?token=not-a-real-token-0123456789');
    await expect(page.getByRole('alert')).toContainText('invalid, has already been used, or has expired');
    await expect(page.getByRole('link', { name: 'Ask for a new reset link' })).toHaveAttribute('href', '/forgot-password');
    await expect(page).not.toHaveURL(/token=/);                // the token is not left in the address bar
  });

  for (const path of ['/login', '/forgot-password', '/reset-password?token=not-a-real-token-0123456789']) {
    test(`${path.split('?')[0]} meets WCAG 2.1 AA (axe)`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator('.login-card h1')).toBeVisible();
      const r = await new AxeBuilder({ page }).include('.login-card').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
    });
  }
});
