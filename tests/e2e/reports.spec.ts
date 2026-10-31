import { test, expect, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// The reports screen (P8) against the real reporting engine and API (P7).
// Every check signs in for real with the fixture accounts (passwords from
// IAM_TEST_PASSWORDS, never from source):
//
//   mland  — land-manager: reports:read + reports:export, pii:read
//   viewer — security-auditor: reports:read, no reports:export
//
// The only test double is the labelled 500 in "an API error is shown as an error".

const PW: Record<string, string> = process.env.IAM_TEST_PASSWORDS
  ? JSON.parse(readFileSync(process.env.IAM_TEST_PASSWORDS, 'utf8')) : {};

const EXPORT_BUTTONS = /^(PDF|Excel|CSV|Print)$/;

async function signIn(browser: Browser, user: string): Promise<Page> {
  test.skip(!PW[user], 'IAM_TEST_PASSWORDS is not set');
  const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
  await page.goto('/login');
  await page.fill('#lgU', user);
  await page.fill('#lgP', PW[user]);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard');
  const chooser = page.locator('main.screen .prov-wrap');
  await expect(chooser.or(page.locator('main.content .card').first())).toBeVisible();
  if (await chooser.isVisible()) {
    await page.locator('.prov-card', { hasText: 'Sindh' }).first().click();
    await expect(chooser).toHaveCount(0);
  }
  return page;
}

const reportNav = (page: Page) => page.getByRole('navigation', { name: 'Reports' });
const count = (page: Page) => page.getByTestId('report-count');

async function openReports(page: Page) {
  await page.goto('/reports');
  await expect(reportNav(page)).toBeVisible();
}

/** Opens a quick report from the side list and waits for its result (or a state that is not loading). */
async function openQuick(page: Page, label: string) {
  await reportNav(page).getByRole('link', { name: label, exact: true }).click();
  await expect(count(page)).toHaveText(/record|group row|No records|could not|do not have access|need attention/, { timeout: 30_000 });
}

/** Waits until the result reflects the latest settings (the run is debounced and earlier runs are aborted). */
async function settled(page: Page) {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 });
  await expect(count(page)).not.toHaveText('Running report…');
}

async function startBuilder(page: Page, dataset: string) {
  await reportNav(page).getByRole('link', { name: 'Build a report' }).click();
  await page.getByLabel('Dataset').selectOption({ label: dataset });
  await settled(page);
}

test.describe('reports screen', () => {
  test('runs a quick report and says what it covers', async ({ browser }) => {
    const page = await signIn(browser, 'mland');
    await openReports(page);
    await openQuick(page, 'Executive land portfolio by province');
    await expect(count(page)).toHaveText(/\d[\d,]* (record|group row)s?/);
    const covers = page.getByLabel('What this report covers');
    await expect(covers).toContainText('Scope');
    await expect(covers).toContainText('Filters');
    await expect(covers).toContainText('Unit of measure');
    // Column headers are real table headers.
    await expect(page.locator('table.t thead th[scope="col"]').first()).toBeVisible();
  });

  test('switching the unit mode changes the units shown', async ({ browser }) => {
    const page = await signIn(browser, 'mland');
    await openReports(page);
    await startBuilder(page, 'Land parcels');

    await page.getByRole('radio', { name: 'Convert everything to one unit' }).check();
    await page.locator('#rpt-unit').selectOption('Hectare');
    await settled(page);
    await expect(page.locator('table.t thead th', { hasText: 'Area (Hectare)' })).toBeVisible();
    await expect(page.getByLabel('What this report covers')).toContainText('converted to Hectare');

    await page.locator('#rpt-unit').selectOption('Acre');
    await settled(page);
    await expect(page.locator('table.t thead th', { hasText: 'Area (Acre)' })).toBeVisible();
    await expect(page.locator('table.t thead th', { hasText: 'Area (Hectare)' })).toHaveCount(0);

    // Province mode: no single unit in the header; every land quantity carries its row's unit.
    await page.getByRole('radio', { name: 'Each province in its reporting unit' }).check();
    await settled(page);
    await expect(page.getByLabel('What this report covers')).toContainText('Each province in its reporting unit');
    await expect(page.locator('table.t thead th', { hasText: /Area \((Acre|Hectare)\)/ })).toHaveCount(0);
    await expect(page.locator('table.t thead th', { hasText: 'unit shown in each row' }).first()).toBeAttached();
    const areaWithUnit = page.locator('table.t tbody tr[data-kind="detail"] td.num .note');
    if (await page.locator('table.t tbody tr[data-kind="detail"]').count()) await expect(areaWithUnit.first()).toBeVisible();
  });

  test('grouping produces labelled subtotal and total rows', async ({ browser }) => {
    const page = await signIn(browser, 'mland');
    await openReports(page);
    await startBuilder(page, 'Land parcels');
    await page.getByLabel('Group level 1').selectOption({ label: 'Province' });
    await expect(page.getByLabel('Subtotals and grand total')).toBeChecked();
    await page.getByLabel('Summary only (one row per group)').check();
    await settled(page);
    const subs = page.locator('table.t tbody tr[data-kind="subtotal"]');
    await expect(subs.first()).toBeVisible();
    await expect(subs.first()).toContainText(/subtotal/i);
    const total = page.locator('table.t tbody tr[data-kind="total"]');
    await expect(total).toHaveCount(1);
    await expect(total).toContainText(/Total \(\d[\d,]* records?\)/);
    // Labels are row headers for screen readers.
    await expect(total.locator('th[scope="row"]')).toHaveCount(1);
  });

  test('a template can be saved, reloaded and deleted', async ({ browser }) => {
    const page = await signIn(browser, 'mland');
    await openReports(page);
    await startBuilder(page, 'Land parcels');
    await page.getByLabel('Group level 1').selectOption({ label: 'Province' });
    await settled(page);

    const name = `E2E parcels by province ${Date.now()}`;
    await page.getByRole('button', { name: 'Save as template…' }).click();
    await page.locator('#rptTplName').fill(name);
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status').filter({ hasText: `Template “${name}” saved.` })).toBeVisible();

    await page.reload();
    await expect(reportNav(page)).toBeVisible();
    await reportNav(page).getByRole('link', { name: new RegExp(name) }).click();
    await expect(page.locator('main.content .card-h h3').first()).toHaveText(name);
    await settled(page);
    await expect(page.getByLabel('Group level 1')).toHaveValue('province_code');

    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Delete template' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Template deleted.' })).toBeVisible();
    await expect(reportNav(page).getByRole('link', { name: new RegExp(name) })).toHaveCount(0);
  });

  test('CSV export has exactly the rows the screen counts', async ({ browser }) => {
    const page = await signIn(browser, 'mland');
    await openReports(page);
    // A small report without subtotal rows.
    await openQuick(page, 'Units of measure and conversion factors');
    const m = /^(\d[\d,]*) records?$/.exec((await count(page).textContent()) ?? '');
    expect(m, 'the whole report fits on one page').not.toBeNull();
    const screenTotal = Number(m![1].replace(/,/g, ''));

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'CSV', exact: true }).click()]);
    const text = readFileSync((await download.path())!, 'utf8').replace(/^﻿/, '');
    const lines = text.split(/\r\n/);
    // Layout: preamble, blank line, header row, data rows, blank line, notes.
    const head = lines.indexOf('') + 1;
    const end = lines.indexOf('', head + 1);
    expect(end - head - 1).toBe(screenTotal);
    // The file says what it covers (UX-12).
    expect(text).toMatch(/^Records,"?\d/m);
    expect(text).toMatch(/^Filters,/m);
    expect(text).toMatch(/^Scope,/m);
  });

  test('a viewer without reports:export sees no export buttons, and the server refuses an export', async ({ browser }) => {
    const page = await signIn(browser, 'viewer');
    await openReports(page);
    await openQuick(page, 'Units of measure and conversion factors');
    await expect(page.getByRole('button', { name: EXPORT_BUTTONS })).toHaveCount(0);
    // From the page, so the request carries the session's CSRF token: the refusal is the permission, not CSRF.
    const res = await page.evaluate(async () => {
      const r = await fetch('/api/reports/export', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { dataset: 'units', columns: ['unit_code'], filters: [], groupBy: [], sort: [], totals: false, uom: { mode: 'province' } }, format: 'csv' }),
      });
      return { status: r.status, code: (await r.json().catch(() => ({}))).code };
    });
    expect(res).toEqual({ status: 403, code: 'forbidden' });
  });

  test('an API error is shown as an error, never as "no data"', async ({ browser }) => {
    const page = await signIn(browser, 'mland');
    // Test double (labelled): the run endpoint fails once with a server error.
    await page.route('**/api/reports/run', (route) => route.fulfill({
      status: 500, contentType: 'application/json',
      body: JSON.stringify({ error: 'Simulated failure (test double)', code: 'internal', correlationId: 'e2e-reports' }),
    }));
    await openReports(page);
    await openQuick(page, 'Executive land portfolio by province');
    const alert = page.locator('[data-state="error"]');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('The report could not be run');
    await expect(alert).toContainText('e2e-reports');
    await expect(page.getByText('No records match these filters.')).toHaveCount(0);

    // Recovering: once the API answers again, "Try again" shows the result.
    await page.unroute('**/api/reports/run');
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(count(page)).toHaveText(/record|group row/, { timeout: 30_000 });
  });

  test('works at 375 px without horizontal page scrolling', async ({ browser }) => {
    const page = await signIn(browser, 'mland');
    await page.setViewportSize({ width: 375, height: 800 });
    await openReports(page);
    await openQuick(page, 'Executive land portfolio by province');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
