import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';

// The application must render in the legacy-demo design system (the reference
// HTML in legacy-demo/). These checks sign in for real — passwords come from
// the file named by IAM_TEST_PASSWORDS, never from source — and assert the
// reference's structure on every implemented screen, plus WCAG 2.1 AA with
// colour contrast left ON.

const PW: Record<string, string> = process.env.IAM_TEST_PASSWORDS
  ? JSON.parse(readFileSync(process.env.IAM_TEST_PASSWORDS, 'utf8')) : {};
const USER = 'viewer';   // all four provinces, read-only, no MFA requirement

import { NAV } from '../../src/components/layout/nav';

// Every screen in the navigation (so this list cannot drift from it).
const SCREENS: [string, string, string | undefined][] = NAV.flatMap(([, items]) => items.map((i) => [i.href, i.label, i.perm] as [string, string, string | undefined]));


async function signIn(page: Page) {
  test.skip(!PW[USER], 'IAM_TEST_PASSWORDS is not set; these checks need a real account');
  await page.goto('/login');
  await page.fill('#lgU', USER);
  await page.fill('#lgP', PW[USER]);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard');
  // First screen after sign-in is the reference's province chooser.
  await expect(page.locator('main.screen .prov-wrap h2')).toHaveText('Select province');
  await page.getByText('All provinces — Head Office consolidated view').click();
  await expect(page.locator('main.screen')).toHaveCount(0);
}

test.describe('legacy design system', () => {
  test('sign-in screen is the reference login card, without demo credentials', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('main.screen .login-card .brand-mark')).toHaveText('LMS');
    await expect(page.locator('.login-card h1')).toHaveText('Land Management System');
    await expect(page.locator('.demo-accts table')).toHaveCount(0);
    await expect(page.locator('#lgP')).toHaveValue('');
    const bg = await page.locator('main.screen').evaluate((e) => getComputedStyle(e).backgroundImage);
    expect(bg).toContain('radial-gradient');
  });

  test('a wrong password is refused with the reference error style', async ({ page }) => {
    await page.goto('/login');
    await page.fill('#lgU', USER);
    await page.fill('#lgP', 'definitely-not-the-password');
    await page.click('button[type="submit"]');
    await expect(page.locator('.login-card .err-msg')).toBeVisible();
    expect(page.url()).toContain('/login');
  });

  test('every screen renders inside the reference shell', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // A blocked script, style, image or connection is a CSP violation (src/lib/csp.ts).
    page.on('console', (m) => { if (/Content Security Policy|Refused to (load|execute|connect|apply)/i.test(m.text())) errors.push(m.text()); });
    await signIn(page);
    const perms: string[] = (await (await page.request.get('/api/auth/me')).json()).permissions;
    for (const [path, title, perm] of SCREENS) {
      if (perm && !perms.includes(perm)) continue;
      await page.goto(path);
      await expect(page.locator('.layout > nav.side .side-brand .brand-mark')).toHaveText('LMS');
      await expect(page.locator('header.top .ttl h1')).toHaveText(title);
      await expect(page.locator('nav.crumbs [aria-current="page"]')).toHaveText(title);
      await expect(page.locator('main.content .card').first()).toBeVisible();
      await expect(page.locator('.nav-i.active')).toHaveText(title);
      // Loaded, not stuck on a spinner.
      await expect(page.locator('main.content [role="status"]:has-text("Loading")')).toHaveCount(0, { timeout: 15000 });
    }
    expect(errors).toEqual([]);
  });

  test('sidebar groups follow the reference wording', async ({ page }) => {
    await signIn(page);
    const perms: string[] = (await (await page.request.get('/api/auth/me')).json()).permissions;
    const visible = NAV.filter(([, items]) => items.some((i) => !i.perm || perms.includes(i.perm))).map(([g]) => g.toUpperCase());
    const groups = await page.locator('nav.side .nav-t').allInnerTexts();
    expect(groups.map((g) => g.toUpperCase())).toEqual(visible);
  });

  test('province chip reopens the chooser and narrows the context', async ({ page }) => {
    await signIn(page);
    await page.goto('/cases');
    await page.locator('header.top .chip', { hasText: 'All provinces' }).click();
    await page.locator('.prov-card', { hasText: 'Sindh' }).click();
    await expect(page.locator('header.top .chip', { hasText: 'Sindh' })).toBeVisible();
    // The list refetches for the new province; wait for it to settle.
    await expect.poll(async () => [...new Set(await page.locator('table.t tbody .pill').allInnerTexts())].sort(),
      { timeout: 10000 }).toEqual(['SND']);
    // The choice survives navigation, as in the reference.
    await page.goto('/leases');
    await expect(page.locator('header.top .chip', { hasText: 'Sindh' })).toBeVisible();
  });

  test('theme toggle switches the reference dark tokens and remembers the choice', async ({ page }) => {
    await signIn(page);
    await page.locator('header.top button[aria-label="Toggle dark mode"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe('rgb(9, 13, 22)');   // tokens.css [data-theme="dark"] --bg
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.locator('header.top button[aria-label="Toggle dark mode"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('records open in the reference modal', async ({ page }) => {
    await signIn(page);
    await page.goto('/cases');
    await page.locator('table.t tbody tr.is-link').first().click();
    const modal = page.locator('.mb .modal[role="dialog"]');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.wf .st')).toHaveCount(6);
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
  });

  test('on a phone the sidebar is a drawer behind the burger', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    const side = page.locator('nav.side');
    await expect(page.locator('header.top .burger')).toBeVisible();
    const hiddenX = await side.evaluate((e) => e.getBoundingClientRect().right);
    expect(hiddenX).toBeLessThanOrEqual(0);
    await page.locator('header.top .burger').click();
    await expect(side).toHaveClass(/open/);
    await expect(page.locator('.side-backdrop')).toHaveClass(/show/);
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollW).toBeLessThanOrEqual(390);
  });

  for (const [path, title, perm] of SCREENS) {
    test(`WCAG 2.1 AA (contrast included): ${title}`, async ({ page }) => {
      await signIn(page);
      const perms: string[] = (await (await page.request.get('/api/auth/me')).json()).permissions;
      test.skip(!!perm && !perms.includes(perm), `${USER} cannot open ${title}`);
      await page.goto(path);
      await expect(page.locator('main.content [role="status"]:has-text("Loading")')).toHaveCount(0, { timeout: 15000 });
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      const serious = r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
      expect(serious.map((v) => `${v.id}: ${v.nodes.length} node(s) — ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
    });
  }
});
