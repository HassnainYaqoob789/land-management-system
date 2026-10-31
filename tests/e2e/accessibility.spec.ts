import { test, expect, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';

// Accessibility of the application shell (P6): WCAG 2.1 AA (axe) on the main
// screens at desktop, tablet and phone widths, no sideways scrolling, and the
// keyboard-only paths — skip link, user menu and sign out, dialogs (focus in,
// trap, Escape, focus back), the tablet drawer, the province chip on phones,
// tabs, and printing a document instead of the page behind a dialog.
//
// Signs in for real with fixture accounts (passwords from IAM_TEST_PASSWORDS,
// never from source):
//   viewer — security-auditor: every :read (so every screen opens), no writes
//   mland  — land-manager: can create landowners (for the dialog tests)

const PW: Record<string, string> = process.env.IAM_TEST_PASSWORDS
  ? JSON.parse(readFileSync(process.env.IAM_TEST_PASSWORDS, 'utf8')) : {};

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const WIDTHS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'phone', width: 375, height: 812 },
] as const;
const SCREENS = ['/dashboard', '/cases', '/landowners', '/payments', '/reports', '/users', '/settings'];

// One browser project is enough: the widths are set here, not by the project.
test.beforeEach(({}, info) => { test.skip(info.project.name !== 'chromium', 'widths are set per test'); });

async function signIn(browser: Browser, user: string, viewport = { width: 1280, height: 800 }, province = 'Sindh'): Promise<Page> {
  test.skip(!PW[user], 'IAM_TEST_PASSWORDS is not set');
  const page = await (await browser.newContext({ viewport })).newPage();
  await page.goto('/login');
  await page.fill('#lgU', user);
  await page.fill('#lgP', PW[user]);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard');
  // Users with more than one province choose one first (a modal dialog).
  const chooser = page.locator('.screen[role="dialog"] .prov-wrap');
  await expect(chooser.or(page.locator('main.content .card').first())).toBeVisible();
  if (await chooser.isVisible()) {
    const card = page.locator('.prov-card', { hasText: province });
    await (await card.count() ? card.first() : page.locator('.prov-card').first()).click();
    await expect(chooser).toHaveCount(0);
  }
  return page;
}

async function openScreen(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('main.content .card').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
}

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(WCAG).exclude('#map').exclude('.maplibregl-canvas').analyze();
  return r.violations.map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

async function noSidewaysScroll(page: Page) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, iw: window.innerWidth }));
  expect(sw, `page is ${sw - iw}px wider than the ${iw}px viewport`).toBeLessThanOrEqual(iw + 1);
}

const activeInside = (page: Page, selector: string) =>
  page.evaluate((s) => !!document.activeElement && !!document.activeElement.closest(s), selector);

// ---- axe and layout at three widths -------------------------------------------------
for (const vp of WIDTHS) {
  test.describe(`WCAG 2.1 AA at ${vp.width}px (${vp.name})`, () => {
    test('sign-in page', async ({ browser }) => {
      const page = await (await browser.newContext({ viewport: { width: vp.width, height: vp.height } })).newPage();
      await page.goto('/login');
      await expect(page.locator('#lgU')).toBeVisible();
      expect(await axe(page)).toEqual([]);
      await noSidewaysScroll(page);
    });

    test('main screens', async ({ browser }) => {
      const page = await signIn(browser, 'viewer', { width: vp.width, height: vp.height });
      for (const path of SCREENS) {
        await openScreen(page, path);
        await test.step(path, async () => {
          expect(await axe(page), path).toEqual([]);
          await noSidewaysScroll(page);
          // Every route has its own title (UX-10).
          await expect(page).toHaveTitle(/ · Mari Energies LMS$/);
          expect(await page.title()).not.toMatch(/^Land Management System ·/);
        });
      }
    });
  });
}

test('phones: the province chip collapses and nothing scrolls sideways at 360px (UX-15)', async ({ browser }) => {
  // A Khyber Pakhtunkhwa user: the longest province name on the chip.
  const page = await signIn(browser, 'lopnj', { width: 360, height: 780 }, 'Khyber Pakhtunkhwa');
  await openScreen(page, '/landowners');
  const chip = page.locator('#provChip');
  await expect(chip).toHaveAttribute('aria-label', /^Province: .+ — change$/);
  expect((await chip.boundingBox())!.width).toBeLessThan(60);
  await noSidewaysScroll(page);
});

// ---- branding ------------------------------------------------------------------------------
test('the Mari Energies logo is in the sidebar, the header (tablet) and the favicon links', async ({ browser }) => {
  const page = await signIn(browser, 'viewer', { width: 1280, height: 800 });
  const side = page.locator('#side .side-brand img[alt="Mari Energies"]');
  await expect(side).toBeVisible();
  const ratio = await side.evaluate((img: HTMLImageElement) => img.naturalWidth / img.naturalHeight - img.clientWidth / img.clientHeight);
  expect(Math.abs(ratio)).toBeLessThan(0.05);                       // aspect ratio preserved
  await expect(page.locator('.brand-mark')).toHaveCount(0);          // no text "LMS" mark left
  await expect(page.locator('link[rel="icon"][href*="/images/icons/favicon-32.png"]')).toHaveCount(1);
  await expect(page.locator('link[rel="apple-touch-icon"][href*="apple-touch-icon.png"]')).toHaveCount(1);
  const icon = await page.request.get('/images/icons/favicon-32.png');
  expect(icon.status()).toBe(200);
  expect(icon.headers()['content-type']).toContain('image/png');
  await expect(page.locator('.site-foot')).toContainText('Developed by Alisons Technology');
  await page.setViewportSize({ width: 820, height: 1180 });
  await expect(page.locator('.top .top-brand img[alt="Mari Energies"]')).toBeVisible();
});

// ---- keyboard only ---------------------------------------------------------------------
test.describe('keyboard only', () => {
  test('skip link is the first tab stop and moves focus to the content', async ({ browser }) => {
    const page = await signIn(browser, 'viewer');
    await openScreen(page, '/cases');
    await page.locator('body').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('.skip-link')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('content');
  });

  test('user menu opens, moves by arrow keys, closes on Escape, and signs out (UX-02)', async ({ browser }) => {
    const page = await signIn(browser, 'viewer');
    const trigger = page.locator('#uMenuBtn');
    await expect(trigger).toHaveAttribute('aria-label', /^Account menu: /);
    await trigger.focus();
    await page.keyboard.press('Enter');
    const items = page.locator('#uMenu [role="menuitem"]');
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#uMenu')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await page.keyboard.press('Space');
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.locator('#uMenu [role="menuitem"]', { hasText: 'Sign out' })).toBeFocused();
    await page.keyboard.press('Enter');
    await page.waitForURL('**/login');
    expect((await page.request.get('/api/auth/me')).status()).toBe(401);
  });

  test('a dialog: focus moves in once, typing in a later field stays there, Tab is trapped, Escape closes and focus returns (UX-01, UX-07)', async ({ browser }) => {
    const page = await signIn(browser, 'mland');
    await openScreen(page, '/landowners');
    const opener = page.getByRole('button', { name: '+ Add Landowner' });
    test.skip(await opener.count() === 0, 'this account cannot add landowners here');
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Add Landowner' });   // named by its title
    await expect(dialog).toBeVisible();
    expect(await activeInside(page, '.modal[role="dialog"]')).toBe(true);

    // Every keystroke re-renders the form; focus must stay in the field being typed in.
    const father = dialog.locator('#loFather');
    await father.focus();
    await father.pressSequentially('Ghulam Hussain', { delay: 20 });
    await expect(father).toHaveValue('Ghulam Hussain');
    await expect(father).toBeFocused();

    // The page behind is inert and Tab never leaves the dialog.
    await expect(page.locator('.layout')).toHaveAttribute('inert', '');
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      expect(await activeInside(page, '.modal[role="dialog"]'), `tab ${i + 1}`).toBe(true);
    }
    await page.keyboard.press('Shift+Tab');
    expect(await activeInside(page, '.modal[role="dialog"]')).toBe(true);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(page.locator('.layout')).not.toHaveAttribute('inert', '');
  });

  test('Enter in a record picker search does not submit the form (UX-13)', async ({ browser }) => {
    const page = await signIn(browser, 'mland');
    await openScreen(page, '/payments');
    const opener = page.getByRole('button', { name: '+ Request Payment' });
    test.skip(await opener.count() === 0 || !(await opener.isEnabled()), 'this account cannot request a voucher here');
    await opener.click();
    const dialog = page.locator('.modal[role="dialog"]').last();
    const search = dialog.locator('.picker input[type="search"]').first();
    test.skip(await search.count() === 0, 'no record picker in this dialog');
    await search.fill('zzzz-no-such-record');
    await search.press('Enter');
    await expect(dialog).toBeVisible();                                  // not submitted
    await expect(dialog.locator('.picker [role="status"]').first()).toContainText(/match/);
  });

  test('tabs follow the ARIA tabs keyboard model (UX-14)', async ({ browser }) => {
    const page = await signIn(browser, 'viewer');
    await openScreen(page, '/payments');
    const tabs = page.locator('[role="tablist"] [role="tab"]');
    test.skip(await tabs.count() < 2, 'no tabs on this screen');
    const first = tabs.first();
    await expect(first).toHaveAttribute('tabindex', '0');
    await expect(tabs.nth(1)).toHaveAttribute('tabindex', '-1');
    await first.focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.nth(1)).toBeFocused();
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(first).toBeFocused();
  });

  test('tablet drawer: closed links are not focusable, focus moves in, Escape closes, wide screens drop the backdrop (UX-08)', async ({ browser }) => {
    const page = await signIn(browser, 'viewer', { width: 820, height: 1180 });
    await openScreen(page, '/cases');
    const side = page.locator('#side');
    await expect(side).toHaveAttribute('inert', '');
    // No tab stop lands off-screen in the closed drawer.
    await page.locator('body').focus();
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      expect(await activeInside(page, '#side'), `tab ${i + 1}`).toBe(false);
    }
    const burger = page.locator('.top .burger');
    await burger.focus();
    await page.keyboard.press('Enter');
    await expect(side).not.toHaveAttribute('inert', '');
    await expect.poll(() => activeInside(page, '#side')).toBe(true);
    await expect(page.locator('.side-backdrop.show')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(side).toHaveAttribute('inert', '');
    await expect(burger).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.locator('.side-backdrop.show')).toHaveCount(1);
    await page.setViewportSize({ width: 1180, height: 820 });              // rotate to landscape
    await expect(page.locator('.side-backdrop.show')).toHaveCount(0);
    await expect(side).not.toHaveAttribute('inert', '');                 // docked sidebar is usable
  });

  test('province chooser is a dialog that takes focus (UX-09)', async ({ browser }) => {
    const page = await signIn(browser, 'viewer');
    await page.locator('#provChip').focus();
    await page.keyboard.press('Enter');
    const chooser = page.getByRole('dialog', { name: 'Select province' });
    await expect(chooser).toBeVisible();
    await expect(page.locator('#provTitle')).toBeFocused();
    await expect(page.locator('main')).toHaveCount(1);                    // no second <main>
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect(await activeInside(page, '.screen[role="dialog"]')).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(chooser).toHaveCount(0);
    await expect(page.locator('#provChip')).toBeFocused();
  });

  test('a client-side navigation is announced and retitles the page (UX-10)', async ({ browser }) => {
    const page = await signIn(browser, 'viewer');
    await page.locator('#side a.nav-i', { hasText: 'Compensation Cases' }).click();
    await page.waitForURL('**/cases');
    await expect(page).toHaveTitle('Compensation Cases · Mari Energies LMS');
    await expect(page.locator('#routeAnnouncer')).toHaveText('Compensation Cases page');
  });
});

// ---- printing (UX-03) -----------------------------------------------------------------
test('printing an award sheet prints the document, not the register behind the dialog', async ({ browser }) => {
  const page = await signIn(browser, 'viewer');
  await page.addInitScript(() => { (window as any).__prints = 0; window.print = () => { (window as any).__prints++; }; });
  await openScreen(page, '/cases');
  const row = page.locator('table.t tbody tr.is-link').first();
  test.skip(await row.count() === 0, 'no compensation case in this database');
  await row.click();
  const dialog = page.locator('.modal[role="dialog"]', { hasText: 'Compensation case' });
  await dialog.getByRole('button', { name: 'Print award sheet' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__prints)).toBe(1);
  await page.emulateMedia({ media: 'print' });
  const doc = page.locator('#lms-print-root');
  await expect(doc).toBeVisible();
  await expect(doc.locator('img.pd-logo[alt="Mari Energies"]')).toBeVisible();
  await expect(doc).toContainText('Mari Energies Limited');
  await expect(doc).toContainText('Developed by Alisons Technology');
  await expect(doc.locator('thead th').first()).toBeVisible();          // table headers repeat per page
  await expect(page.locator('.layout')).toBeHidden();
  await expect(page.locator('.mb')).toBeHidden();
  await expect(doc.locator('script, [onclick], [onerror]')).toHaveCount(0);
});
