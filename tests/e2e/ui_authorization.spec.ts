import { test, expect, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { NAV, ROUTE_PERMISSIONS, UNREGISTERED_ROUTE, routePermissionOf } from '../../src/components/layout/nav';

// Authorization in the user interface (P1a): pages, menu entries, controls and
// personal data follow the signed-in user's effective permissions, and the UI
// re-reads them when the server refuses something. Every check signs in for real
// with the fixture accounts (passwords from IAM_TEST_PASSWORDS, never from
// source) and, where it matters, confirms the server agrees.
//
//   viewer  — security-auditor: every :read, no write, no pii:read
//   lofield — data-entry (Sindh): no audit_logs:read, users:read, roles:read, cases:approve
//   mland   — land-manager (all provinces): create/update/approve, payments:release, pii:read

const PW: Record<string, string> = process.env.IAM_TEST_PASSWORDS
  ? JSON.parse(readFileSync(process.env.IAM_TEST_PASSWORDS, 'utf8')) : {};

const FULL_CNIC = /^\d{5}-\d{7}-\d$/;
const NO_ACCESS = 'You do not have access to this page';

async function signIn(browser: Browser, user: string): Promise<Page> {
  test.skip(!PW[user], 'IAM_TEST_PASSWORDS is not set');
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await page.fill('#lgU', user);
  await page.fill('#lgP', PW[user]);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard');
  // Users with more than one province choose one first.
  const chooser = page.locator('main.screen .prov-wrap');
  await expect(chooser.or(page.locator('main.content .card').first())).toBeVisible();
  if (await chooser.isVisible()) {
    await page.locator('.prov-card', { hasText: 'Sindh' }).first().click();
    await expect(chooser).toHaveCount(0);
  }
  return page;
}

/** Opens a page and waits until its content (or the no-access panel) has rendered. */
async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('main.content .card').first()).toBeVisible();
}

/** Every <button> in `scope` whose accessible name matches, and is enabled. */
async function enabledButtons(scope: Page | ReturnType<Page['locator']>, name: RegExp) {
  const all = scope.getByRole('button', { name });
  const n = await all.count();
  let enabled = 0;
  for (let i = 0; i < n; i++) if (await all.nth(i).isEnabled()) enabled++;
  return enabled;
}

test.describe('route permission table', () => {
  test('every menu entry is guarded by exactly the permission its page needs', () => {
    for (const [, items] of NAV) for (const i of items)
      expect(ROUTE_PERMISSIONS[i.href], i.href).toEqual(i.perm ? [i.perm] : null);
    expect(routePermissionOf('/audit')).toEqual(['audit_logs:read']);
    expect(routePermissionOf('/dashboard')).toEqual(['reports:read']);    // its KPIs come from /api/analytics/kpis
    expect(routePermissionOf('/province')).toEqual(['reports:read']);
    expect(routePermissionOf('/roles/some-role')).toEqual(['roles:read']);  // nested routes inherit
    expect(routePermissionOf('/account/security')).toBeNull();            // any signed-in user
    expect(routePermissionOf('/not-a-page')).toEqual([UNREGISTERED_ROUTE]); // default deny
  });
});

test.describe('UI authorization', () => {
  test('data entry: administrative pages opened by URL show the no-access panel and load nothing', async ({ browser }) => {
    const p = await signIn(browser, 'lofield');
    const adminCalls: string[] = [];
    p.on('request', (r) => { const u = new URL(r.url()); if (/^\/api\/(audit|users|roles)\b/.test(u.pathname)) adminCalls.push(u.pathname); });

    for (const [path, perm] of [['/audit', 'audit_logs:read'], ['/users', 'users:read'], ['/roles', 'roles:read']] as const) {
      await open(p, path);
      await expect(p.getByRole('heading', { name: NO_ACCESS })).toBeVisible();
      await expect(p.locator('main.content [role="alert"]').first()).toContainText(perm);
      await expect(p.locator('main.content table.t')).toHaveCount(0);
      await expect(p.getByRole('link', { name: /^Go to / })).toBeVisible();
    }
    // Nothing of those pages mounted, so none of their APIs was called…
    expect(adminCalls, 'administrative API calls').toEqual([]);
    // …and the server refuses them anyway.
    expect((await p.request.get('/api/audit')).status()).toBe(403);
    expect((await p.request.get('/api/users')).status()).toBe(403);

    // The menu does not offer them.
    for (const label of ['Audit Trail', 'Users & Roles', 'Roles & Permissions'])
      await expect(p.locator('nav#side a', { hasText: label })).toHaveCount(0);

    // A page the user may open still works.
    await open(p, '/cases');
    await expect(p.getByRole('heading', { name: NO_ACCESS })).toHaveCount(0);
    await expect(p.locator('main.content table.t').first()).toBeVisible();
  });

  test('data entry: a case is not offered for approval without cases:approve', async ({ browser }) => {
    const p = await signIn(browser, 'lofield');
    await open(p, '/cases');
    await p.getByRole('combobox', { name: 'Stage' }).selectOption('Checked');
    const row = p.locator('table.t tbody tr.is-link').first();
    test.skip(await row.count() === 0, 'no case at the Checked stage in this database');
    await row.click();
    const dialog = p.locator('.modal[role="dialog"]', { hasText: 'Compensation case' });
    await expect(dialog.locator('.wf')).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^→ / })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Adjust award' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Print award sheet' })).toBeVisible();
  });

  test('read-only auditor: no create, approve, release, promote, comment or export controls; CNIC masked', async ({ browser }) => {
    const v = await signIn(browser, 'viewer');

    await open(v, '/cases');
    await expect(v.getByRole('button', { name: '+ Add Compensation Case' })).toHaveCount(0);
    const caseRow = v.locator('table.t tbody tr.is-link').first();
    if (await caseRow.count()) {
      await caseRow.click();
      const dialog = v.locator('.modal[role="dialog"]', { hasText: 'Compensation case' });
      await expect(dialog.locator('.wf')).toBeVisible();
      for (const name of [/^→ /, /^Cancel$/, /^Adjust award$/, /^Edit valuation$/])
        await expect(dialog.getByRole('button', { name })).toHaveCount(0);
      await v.keyboard.press('Escape');
    }

    await open(v, '/payments');
    for (const name of ['+ Request Payment', 'Place hold', 'Run reconciliation', 'Verify', 'Release cheque'])
      await expect(v.getByRole('button', { name })).toHaveCount(0);
    await v.getByRole('tab', { name: 'Cheques' }).click();
    await expect(v.locator('main.content table.t').first()).toBeVisible();
    await expect(v.getByRole('button', { name: 'Reverse release' })).toHaveCount(0);
    await expect(v.getByRole('button', { name: 'Record receipt' })).toHaveCount(0);

    await open(v, '/import');
    for (const name of ['+ Upload file', 'Validate', /^Promote/])
      await expect(v.getByRole('button', { name })).toHaveCount(0);

    await open(v, '/inbox');
    await expect(v.getByRole('button', { name: 'Comment' })).toHaveCount(0);

    await open(v, '/leases');
    for (const name of ['+ Add Lease', 'Hold', 'Release', 'Renew'])
      await expect(v.getByRole('button', { name, exact: true })).toHaveCount(0);

    await open(v, '/requests');
    await expect(v.getByRole('button', { name: '+ Add Land Request' })).toHaveCount(0);
    await expect(v.getByRole('button', { name: 'Review' })).toHaveCount(0);

    await open(v, '/surveys');
    await expect(v.getByRole('button', { name: '+ Add Survey' })).toHaveCount(0);
    await expect(v.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);

    // Exports need reports:export, which the auditor does not hold.
    await open(v, '/reports');
    expect(await enabledButtons(v.locator('main.content'), /export|excel|csv|pdf|xlsx/i), 'enabled export controls').toBe(0);
    const session = await (await v.request.get('/api/auth/me')).json();
    const exported = await v.request.post('/api/reports/export', {
      headers: { 'x-csrf-token': session.csrfToken, origin: new URL(v.url()).origin },
      data: { config: {}, format: 'csv' },
    });
    expect(exported.status(), 'POST /api/reports/export without reports:export').toBe(403);

    // Personal data: CNICs come masked from the server and are shown as returned.
    await open(v, '/landowners');
    await expect(v.getByRole('button', { name: '+ Add Landowner' })).toHaveCount(0);
    await expect(v.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    const cnics = (await v.locator('main.content table.t tbody tr td.mono').allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    expect(cnics.length, 'landowner rows with a CNIC').toBeGreaterThan(0);
    for (const c of cnics) expect(c, 'CNIC shown to the auditor').not.toMatch(FULL_CNIC);
    const api = (await (await v.request.get('/api/landowners')).json()).landowners as any[];
    for (const lo of api) if (lo.cnic) expect(String(lo.cnic)).not.toMatch(FULL_CNIC);

    // A page the auditor may read opens normally (positive control).
    await open(v, '/audit');
    await expect(v.getByRole('heading', { name: NO_ACCESS })).toHaveCount(0);
  });

  test('land manager: the same controls are offered, in the user\'s provinces', async ({ browser }) => {
    const m = await signIn(browser, 'mland');

    await open(m, '/cases');
    await expect(m.getByRole('button', { name: '+ Add Compensation Case' })).toBeEnabled();
    await m.getByRole('combobox', { name: 'Stage' }).selectOption('Verified');
    const verified = m.locator('table.t tbody tr.is-link').first();
    if (await verified.count()) {
      await verified.click();
      const dialog = m.locator('.modal[role="dialog"]', { hasText: 'Compensation case' });
      await expect(dialog.getByRole('button', { name: /^→ / })).toBeVisible();
      await m.keyboard.press('Escape');
    }
    await m.getByRole('combobox', { name: 'Stage' }).selectOption('HO Approved');
    const approved = m.locator('table.t tbody tr.is-link').first();
    if (await approved.count()) {
      await approved.click();
      const dialog = m.locator('.modal[role="dialog"]', { hasText: 'Compensation case' });
      const adjust = dialog.getByRole('button', { name: 'Adjust award' });
      await expect(adjust).toBeVisible();
      if (await adjust.isEnabled()) {
        // The adjustment asks for an amount, a reason and a confirmation before anything is sent.
        await adjust.click();
        const adj = m.locator('.modal[role="dialog"]', { hasText: 'Adjust award' });
        await adj.getByRole('button', { name: 'Review' }).click();
        await expect(adj.locator('[role="alert"]')).toContainText('non-zero amount');
        await adj.getByRole('button', { name: 'Cancel' }).click();
      } else {
        // Separation of duties: the preparer is told why.
        await expect(adjust).toHaveAttribute('title', /prepared this case/);
      }
    }

    await open(m, '/payments');
    await m.getByRole('tab', { name: 'Cheques' }).click();
    await expect(m.locator('main.content table.t').first()).toBeVisible();
    // One row per released cheque (the cheque number is set in .mono); each offers a reversal
    // (disabled, with the reason, for the person who released it).
    if (await m.locator('main.content table.t').first().locator('tbody tr span.mono').count()) {
      const reverse = m.getByRole('button', { name: 'Reverse release' });
      expect(await reverse.count(), 'Reverse release offered').toBeGreaterThan(0);
      // A disabled one says why (the releaser may not reverse their own release).
      for (let i = 0; i < await reverse.count(); i++)
        if (await reverse.nth(i).isDisabled()) await expect(reverse.nth(i)).toHaveAttribute('title', /released this cheque|already been reversed/);
    }

    await open(m, '/leases');
    await expect(m.getByRole('button', { name: '+ Add Lease' })).toBeEnabled();
    if (await m.locator('main.content table.t tbody tr').filter({ has: m.locator('.code') }).count())
      expect(await m.getByRole('button', { name: /^(Hold|Release)$/ }).count()).toBeGreaterThan(0);

    await open(m, '/requests');
    await expect(m.getByRole('button', { name: '+ Add Land Request' })).toBeEnabled();

    await open(m, '/landowners');
    await expect(m.getByRole('button', { name: '+ Add Landowner' })).toBeEnabled();
    // pii:read: the full CNIC is returned and shown.
    const cnics = (await m.locator('main.content table.t tbody tr td.mono').allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    expect(cnics.some((c) => FULL_CNIC.test(c)), 'a full CNIC for a pii:read holder').toBe(true);

    await open(m, '/inbox');
    if (await m.locator('main.content table.t tbody tr').filter({ has: m.locator('.code') }).count())
      expect(await m.getByRole('button', { name: 'Comment' }).count(), 'Comment offered to a writer').toBeGreaterThan(0);
  });

  test('the shell re-reads permissions after a refusal and when the window regains focus', async ({ browser }) => {
    const p = await signIn(browser, 'lofield');
    await open(p, '/cases');
    let me = 0;
    p.on('request', (r) => { if (new URL(r.url()).pathname === '/api/auth/me') me++; });
    await p.waitForTimeout(2_500);   // past the refresh debounce after the page loaded

    // A refused API call (403 forbidden) makes the UI re-read /api/auth/me.
    const status = await p.evaluate(async () => (await fetch('/api/audit')).status);
    expect(status).toBe(403);
    await expect.poll(() => me, { message: '/api/auth/me after a 403' }).toBeGreaterThan(0);

    // So does regaining focus.
    const before = me;
    await p.waitForTimeout(2_500);
    await p.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => me, { message: '/api/auth/me after focus' }).toBeGreaterThan(before);
  });
});
