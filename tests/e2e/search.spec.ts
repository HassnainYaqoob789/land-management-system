import { test, expect, type Browser, type Page, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Top-bar global search (P6, UX-05): GET /api/search returns only records the
// signed-in user may read — modules they hold <module>:read on, rows inside
// their province scope, CNICs only with pii:read — and the header combobox is
// fully keyboard-operable. Expectations are derived from each account's own
// /api/auth/me, so the checks stay true whatever roles the fixtures carry.
//
//   viewer  — security-auditor, all provinces, no pii:read
//   lofield — data-entry, Sindh only
//   mland   — land-manager, all provinces

const PW: Record<string, string> = process.env.IAM_TEST_PASSWORDS
  ? JSON.parse(readFileSync(process.env.IAM_TEST_PASSWORDS, 'utf8')) : {};
const FULL_CNIC = /\b\d{5}-\d{7}-\d\b/;
const MODULE_OF: Record<string, string> = {
  landowners: 'landowners', surveys: 'surveys', leases: 'leases', cases: 'cases', rows: 'rows',
  payments: 'payments', projects: 'projects', grievances: 'grievances', legal: 'legal',
};
const LINK = /^\/(landowners|surveys|leases|cases|rows|payments|grievances|legal)\?q=[^&]+$|^\/projdash\?id=[0-9a-f-]{36}$/;

test.beforeEach(({}, info) => { test.skip(info.project.name !== 'chromium', 'API and keyboard checks run once'); });

async function signIn(browser: Browser, user: string): Promise<Page> {
  test.skip(!PW[user], 'IAM_TEST_PASSWORDS is not set');
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto('/login');
  await page.fill('#lgU', user);
  await page.fill('#lgP', PW[user]);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard');
  const chooser = page.locator('.screen[role="dialog"] .prov-wrap');
  await expect(chooser.or(page.locator('main.content .card').first())).toBeVisible();
  if (await chooser.isVisible()) {
    const all = page.locator('.prov-all');
    await (await all.count() ? all : page.locator('.prov-card').first()).click();   // search across every province the user has
    await expect(chooser).toHaveCount(0);
  }
  return page;
}

async function me(req: APIRequestContext) {
  const r = await req.get('/api/auth/me');
  expect(r.status()).toBe(200);
  const b = await r.json();
  return { permissions: (b.permissions ?? []) as string[], provinces: (b.provinces ?? []) as string[] };
}

async function search(req: APIRequestContext, q: string, province?: string) {
  const qs = new URLSearchParams({ q });
  if (province) qs.set('province', province);
  const r = await req.get(`/api/search?${qs}`);
  return { status: r.status(), body: await r.json().catch(() => ({})) };
}

/** The invariants every response must satisfy for this user. */
function expectPermitted(body: any, who: { permissions: string[]; provinces: string[] }) {
  for (const g of body.groups) {
    const module = MODULE_OF[g.key];
    expect(module, `unknown group ${g.key}`).toBeTruthy();
    expect(who.permissions, `group ${g.key} returned without ${module}:read`).toContain(`${module}:read`);
    expect(g.items.length).toBeGreaterThan(0);
    expect(g.items.length).toBeLessThanOrEqual(5);
    for (const it of g.items) {
      expect(it.href).toMatch(LINK);
      // Every item names its province last in the sub-line; it must be one of the user's.
      const prov = String(it.sub).split(' · ').find((p: string) => /^(SND|PNJ|BAL|KPK)$/.test(p));
      if (prov && who.provinces.length) expect(who.provinces).toContain(prov);
    }
  }
  if (!who.permissions.includes('pii:read')) expect(JSON.stringify(body)).not.toMatch(FULL_CNIC);
}

test.describe('GET /api/search', () => {
  test('needs a session and validates its input', async ({ request, browser }) => {
    expect((await request.get('/api/search?q=Daharki')).status()).toBe(401);
    const page = await signIn(browser, 'viewer');
    expect((await search(page.request, 'a')).status).toBe(400);
    expect((await search(page.request, 'x'.repeat(101))).status).toBe(400);
    expect((await search(page.request, 'Daharki', 'XYZ')).status).toBe(400);
    expect((await search(page.request, 'ab\u0001c')).status).toBe(400);
    // Wildcards are text, not patterns.
    const pct = await search(page.request, '%%');
    expect(pct.status).toBe(200);
    expect(pct.body.total).toBe(0);
  });

  for (const user of ['viewer', 'lofield', 'mland']) {
    test(`${user}: results only from permitted modules, provinces and fields`, async ({ browser }) => {
      const page = await signIn(browser, user);
      const who = await me(page.request);
      for (const q of ['Daharki', 'Karak', 'Sui', 'PAY', 'CC-2026', 'Ali']) {
        const r = await search(page.request, q);
        expect(r.status, q).toBe(200);
        expectPermitted(r.body, who);
      }
    });
  }

  test('province scope: a Sindh-only user never sees another province; an all-province user does', async ({ browser }) => {
    const lo = await signIn(browser, 'lofield');
    const ml = await signIn(browser, 'mland');
    const loMe = await me(lo.request), mlMe = await me(ml.request);
    test.skip(loMe.provinces.join() !== 'SND', 'lofield is expected to be limited to Sindh');
    test.skip(!mlMe.permissions.includes('projects:read') || !mlMe.provinces.includes('KPK'), 'mland needs projects:read in KPK');
    const codes = (b: any) => b.groups.flatMap((g: any) => g.items.map((i: any) => i.code));

    const karakMl = await search(ml.request, 'Karak');
    expect(codes(karakMl.body)).toContain('KRK-007');            // seed project in Khyber Pakhtunkhwa
    const karakLo = await search(lo.request, 'Karak');
    expect(codes(karakLo.body)).not.toContain('KRK-007');
    expect(JSON.stringify(karakLo.body)).not.toMatch(/· (KPK|PNJ|BAL)\b/);

    const daharki = await search(lo.request, 'Daharki');
    expect(codes(daharki.body)).toContain('DHRK-001');           // in Sindh: found

    // Narrowing to a province the user selected.
    const onlyKpk = await search(ml.request, 'Daharki', 'KPK');
    expect(codes(onlyKpk.body)).not.toContain('DHRK-001');
  });

  test('CNIC: matched only with pii:read; otherwise not searched and never shown in full', async ({ browser }) => {
    for (const user of ['viewer', 'mland']) {
      const page = await signIn(browser, user);
      const who = await me(page.request);
      const r = await search(page.request, '45102');
      expect(r.status).toBe(200);
      if (who.permissions.includes('pii:read')) {
        expect(r.body.cnic).toBe('searched');
      } else {
        expect(r.body.cnic).toBe('not_permitted');
        expect(JSON.stringify(r.body)).not.toMatch(FULL_CNIC);
      }
      const byName = await search(page.request, 'Jarwar');
      expectPermitted(byName.body, who);
    }
  });
});

test.describe('header combobox', () => {
  test('Ctrl+K and / focus it; arrows, Enter and Escape work; the count is announced', async ({ browser }) => {
    const page = await signIn(browser, 'mland');
    const box = page.getByRole('combobox', { name: 'Search records and screens' });

    await page.locator('body').click({ position: { x: 5, y: 400 } });
    await page.keyboard.press('Control+k');
    await expect(box).toBeFocused();
    await box.blur();
    await page.locator('body').focus();
    await page.keyboard.press('/');
    await expect(box).toBeFocused();

    await box.pressSequentially('Daharki', { delay: 30 });
    const options = page.getByRole('listbox', { name: 'Search results' }).getByRole('option');
    await expect(options.first()).toBeVisible();
    await expect(box).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.gs [role="status"]')).toContainText(/\d+ results? for Daharki/);

    await page.keyboard.press('ArrowDown');
    const first = options.first();
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await expect(box).toHaveAttribute('aria-activedescendant', (await first.getAttribute('id'))!);
    await expect(box).toBeFocused();                               // focus stays in the input
    await page.keyboard.press('ArrowUp');                          // wraps to the last option
    await expect(options.last()).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('Escape');
    await expect(box).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Escape');
    await expect(box).toHaveValue('');

    await box.pressSequentially('Daharki', { delay: 30 });
    await expect(options.first()).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/(landowners|surveys|leases|cases|rows|payments|grievances|legal)\?q=|\/projdash\?id=/);
    await expect(page.locator('main.content .card').first()).toBeVisible();
  });

  test('screens are offered only when the user may open them', async ({ browser }) => {
    for (const user of ['viewer', 'lofield']) {
      const page = await signIn(browser, user);
      const who = await me(page.request);
      const box = page.getByRole('combobox', { name: 'Search records and screens' });
      await box.fill('Audit');
      const audit = page.getByRole('option', { name: /Audit Trail/ });
      if (who.permissions.includes('audit_logs:read')) await expect(audit).toBeVisible();
      else {
        await expect(page.locator('.gs [role="status"]')).not.toBeEmpty();
        await expect(audit).toHaveCount(0);
      }
    }
  });

  test('without pii:read a CNIC-shaped search says why CNICs were not searched', async ({ browser }) => {
    const page = await signIn(browser, 'viewer');
    const who = await me(page.request);
    test.skip(who.permissions.includes('pii:read'), 'viewer holds pii:read here');
    await page.getByRole('combobox', { name: 'Search records and screens' }).fill('45102-11');
    await expect(page.locator('.gs-note')).toContainText('Searching by CNIC needs permission to view personal data');
  });
});
