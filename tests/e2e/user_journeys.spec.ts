import { test, expect, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Role-based user journeys through the real UI (simulated UAT). Each person
// signs in with their own fixture account in their own browser context; every
// outcome is then checked against the API, so a screen that only *looks* right
// fails. Passwords come from IAM_TEST_PASSWORDS, never from source.

const PW: Record<string, string> = process.env.IAM_TEST_PASSWORDS
  ? JSON.parse(readFileSync(process.env.IAM_TEST_PASSWORDS, 'utf8')) : {};

async function signIn(browser: Browser, user: string): Promise<Page> {
  test.skip(!PW[user], 'IAM_TEST_PASSWORDS is not set');
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await page.fill('#lgU', user);
  await page.fill('#lgP', PW[user]);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard');
  // Users with more than one province are asked to choose first; wait for
  // whichever comes up (the chooser, or the shell for a one-province user).
  const chooser = page.locator('main.screen .prov-wrap');
  await expect(chooser.or(page.locator('main.content .card').first())).toBeVisible();
  if (await chooser.isVisible()) {
    await page.locator('.prov-card', { hasText: 'Sindh' }).first().click();
    await expect(chooser).toHaveCount(0);
  }
  return page;
}

/** The value of the first enabled option whose text matches, in a <select>. */
async function pick(page: Page, select: string, text: RegExp = /./) {
  // Pickers search the database, so their options arrive after the request returns.
  let value = '';
  await expect.poll(async () => {
    value = await page.locator(select).first().evaluate((el, src) => {
      const re = new RegExp(src);
      const o = [...(el as HTMLSelectElement).options].find((x) => x.value && !x.disabled && re.test(x.text));
      return o?.value ?? '';
    }, text.source);
    return value;
  }, { message: `an option for ${select}`, timeout: 10_000 }).not.toBe('');
  await page.locator(select).first().selectOption(value);
}

const sub = (page: Page, title: string) => page.locator('.fg.full', { has: page.locator(`label:text-is("${title}")`) });

test.describe('user journeys', () => {
  test('compensation case: prepared by the land officer, refused to them, approved by negotiation', async ({ browser }) => {
    // --- Land officer prepares the case through the form.
    const lo = await signIn(browser, 'lofield');
    await lo.goto('/cases');
    await lo.getByRole('button', { name: '+ Add Compensation Case' }).click();
    await pick(lo, '#cfProj', /\(SND\)/);
    await pick(lo, '#cfUse');
    await lo.fill('#cfRate', '30000');
    await lo.fill('#cfTerm', '12');
    const owners = sub(lo, 'Landowners — shares must total 100%');
    await owners.getByRole('button', { name: '+ Add line' }).click();
    await pick(lo, '.fg.full:has(label:text-is("Landowners — shares must total 100%")) select[aria-label="Landowner"]');

    // Validation: shares that do not total 100% are stopped before any request.
    await owners.getByLabel('Share').fill('90');
    await lo.getByRole('button', { name: 'Create case' }).click();
    await expect(lo.locator('.modal [role="alert"]')).toContainText('must total 100%');

    await owners.getByLabel('Share').fill('100');
    const lease = sub(lo, 'Lease lines');
    await lease.getByRole('button', { name: '+ Add line' }).click();
    await pick(lo, '.fg.full:has(label:text-is("Lease lines")) select[aria-label="Survey"]');
    await lease.getByLabel('Lease area').fill('1.5');
    const crop = sub(lo, 'Crop compensation');
    await crop.getByRole('button', { name: '+ Add line' }).click();
    await crop.getByLabel('Crop', { exact: true }).fill('wheat');
    await crop.getByLabel('Crop rate').fill('20000');
    await crop.getByLabel('Damaged area').fill('0.5');
    await lo.getByRole('button', { name: 'Create case' }).click();

    const detail = lo.locator('.modal[role="dialog"]', { hasText: 'Compensation case' });
    await expect(detail.locator('.code').first()).toBeVisible();
    const code = (await detail.locator('.code').first().innerText()).trim();
    await expect(detail.locator('.wf .st.cur')).toHaveText('Prepared');

    // Persisted, and valued by the database from the lines.
    const list = (await (await lo.request.get('/api/cases')).json()).cases as any[];
    const saved = list.find((c) => c.case_code === code);
    expect(saved, `case ${code} saved`).toBeTruthy();
    expect(Number(saved.total_crop_amount)).toBe(10000);
    expect(Number(saved.total_lease_amount)).toBeGreaterThan(0);

    // The preparer cannot approve their own case: the server refuses and the screen says so.
    await detail.getByRole('button', { name: '→ Checked' }).click();
    await lo.getByRole('button', { name: 'Move to Checked' }).click();
    await expect(lo.locator('.modal [role="alert"]').last()).toBeVisible();
    expect((await (await lo.request.get(`/api/cases?id=${saved.case_id}`)).json()).case.stage_code).toBe('Prepared');
    await lo.keyboard.press('Escape');

    // --- The negotiation position approves it.
    const nego = await signIn(browser, 'nego');
    await nego.goto('/cases');
    await nego.getByPlaceholder('Search case, project, owner or position…').fill(code);
    await nego.locator('table.t tbody tr', { hasText: code }).click();
    const d2 = nego.locator('.modal[role="dialog"]', { hasText: code });
    await d2.getByRole('button', { name: '→ Checked' }).click();
    await nego.locator('textarea[id^="wfn-"]').fill('Rates agreed with the owners at the jirga');
    await nego.getByRole('button', { name: 'Move to Checked' }).click();
    await expect(d2.locator('.wf .st.cur')).toHaveText('Checked');
    await expect(d2.locator('.tl')).toContainText('Prepared → Checked by');
    await expect(d2.locator('.tl')).toContainText('Rates agreed with the owners at the jirga');

    // Seen the same way by the first user, in their own session.
    const after = (await (await lo.request.get(`/api/cases?id=${saved.case_id}`)).json());
    expect(after.case.stage_code).toBe('Checked');
    expect(after.transitions.at(-1).acted_by_name).toBeTruthy();
  });

  test('read-only user: sees the registers, gets no write or export controls, and the API refuses writes', async ({ browser }) => {
    const v = await signIn(browser, 'viewer');
    await v.goto('/cases');
    await expect(v.locator('table.t')).toBeVisible();
    await expect(v.getByRole('button', { name: '+ Add Compensation Case' })).toHaveCount(0);
    await v.goto('/reports');
    await expect(v.locator('main.content .card').first()).toBeVisible();
    await expect(v.getByRole('button', { name: 'Excel (CSV)' })).toHaveCount(0);
    expect((await v.request.get('/api/analytics/reports?report=r1&format=csv')).status()).toBe(403);
    const me = await (await v.request.get('/api/auth/me')).json();
    const write = await v.request.post('/api/grievances', {
      headers: { 'x-csrf-token': me.csrfToken, origin: new URL(v.url()).origin },
      data: { province_code: 'SND', description: 'viewer should not file this' },
    });
    expect(write.status()).toBe(403);
  });

  test('sign-out ends the session for pages and for the API', async ({ browser }) => {
    const p = await signIn(browser, 'legal');
    await p.goto('/legal');
    await p.locator('header [aria-haspopup="menu"]').click();
    await Promise.all([p.waitForURL('**/login', { waitUntil: 'commit' }), p.getByRole('menuitem', { name: 'Sign out' }).click()]);
    expect((await p.request.get('/api/legal')).status()).toBe(401);
    await p.goto('/legal');
    await expect(p).toHaveURL(/\/login$/);
  });
});
