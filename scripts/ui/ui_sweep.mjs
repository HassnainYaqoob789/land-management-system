#!/usr/bin/env node
// UI sweep: signs in, opens every page at desktop, tablet and phone widths and
// records layout and usability defects a person would notice. Evidence, not a
// verdict — read the JSON and the screenshots.
//
//   node scripts/ui/ui_sweep.mjs <baseUrl> <outDir> [user] [credentialsJson]
//
// Per page and width it records: sideways scrolling, elements that spill past
// the right edge, text cut off inside buttons/headers/chips/cells, tap targets
// under 32 px on phones, console errors, failed requests (4xx/5xx), alert/error
// panels shown, and (desktop) axe WCAG 2.1 AA violations.
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const [base = 'http://localhost:3050', out = 'ui-sweep', user = 'mland', credFile = '.data/demo-credentials.json'] = process.argv.slice(2);
const creds = JSON.parse(readFileSync(credFile, 'utf8')).accounts.find((a) => a.username === user);
if (!creds) { console.error(`no demo account ${user}`); process.exit(2); }
const ROUTES = ['/dashboard', '/projdash', '/province', '/projects', '/surveys', '/landowners', '/acquisitions', '/cases', '/mutations',
  '/leases', '/rows', '/dbpfc', '/requests', '/payments', '/budgets', '/legal', '/grievances', '/encroachments', '/documents',
  '/gis', '/calendar', '/inbox', '/reports', '/import', '/units', '/matrix', '/arch', '/audit', '/users', '/roles', '/settings', '/account/security'];
const VIEWPORTS = [['desktop', 1440, 900], ['tablet', 820, 1180], ['phone', 390, 844]];
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const results = [];
for (const [vp, w, h] of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.fill('#lgU', creds.username); await page.fill('#lgP', creds.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/dashboard|account/, { timeout: 90_000 });
  // The province chooser appears after the profile loads; wait for it (or for a
  // page that needs no choice) before going on, or every page shows the chooser.
  await page.waitForLoadState('networkidle'); await page.waitForTimeout(1500);
  const all = page.locator('a.prov-all');
  if (await all.count()) await all.click(); else { const c = page.locator('a.prov-card').first(); if (await c.count()) await c.click(); }
  await page.waitForTimeout(800);
  if (await page.locator('a.prov-all, a.prov-card').count()) throw new Error('province chooser did not close');
  for (const route of ROUTES) {
    const errors = [], failed = [];
    const onConsole = (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 240)); };
    const onResp = (r) => { if (r.status() >= 400 && !r.url().includes('/_next/')) failed.push(`${r.status()} ${new URL(r.url()).pathname}`); };
    page.on('console', onConsole); page.on('response', onResp);
    let status = 'ok';
    try { await page.goto(base + route, { waitUntil: 'networkidle', timeout: 120_000 }); await page.waitForTimeout(1200); }
    catch (e) { status = 'navigation failed: ' + String(e).slice(0, 120); }
    const m = await page.evaluate((vw) => {
      const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const desc = (el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;
      const spill = []; const clipped = []; const tiny = [];
      for (const el of document.querySelectorAll('body *')) {
        if (!vis(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.right > vw + 1 && !el.closest('[aria-hidden=true],.gs-panel,.sr-only') && getComputedStyle(el).position !== 'fixed') spill.push(desc(el));
        if (el.matches('button,a.btn,th,.chip,label,h1,h2,h3,.kpi .v,.badge,td,.tab,[role=tab]')) {
          const s = getComputedStyle(el);
          if (el.scrollWidth > el.clientWidth + 2 && (s.overflow === 'hidden' || s.textOverflow === 'ellipsis' || s.overflowX === 'hidden'))
            clipped.push(`${desc(el)}: "${(el.innerText || '').trim().slice(0, 40)}"`);
        }
        if (vw < 600 && el.matches('button,a,input,select,[role=button],[role=tab]') && !el.closest('.sr-only,nav.crumbs')) {
          if ((r.height < 32 || r.width < 32) && (el.innerText || el.getAttribute('aria-label'))) tiny.push(`${desc(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
      }
      const alerts = [...document.querySelectorAll('[role=alert],.err-msg,.al.d')].filter(vis).map((e) => e.innerText.trim().slice(0, 140)).filter(Boolean);
      const empty = /no records|nothing to show|no data/i.test(document.querySelector('main')?.innerText || '');
      return { overflowX: document.documentElement.scrollWidth - vw, spill: [...new Set(spill)].slice(0, 8), spillCount: spill.length,
               clipped: [...new Set(clipped)].slice(0, 8), clippedCount: clipped.length, tiny: [...new Set(tiny)].slice(0, 8), tinyCount: tiny.length,
               alerts: alerts.slice(0, 4), emptyState: empty, title: document.title };
    }, w).catch((e) => ({ evalError: String(e).slice(0, 160) }));
    let axe = null;
    if (vp === 'desktop' && status === 'ok') {
      try {
        const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
        axe = r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ') }));
      } catch (e) { axe = [{ id: 'axe-error', sample: String(e).slice(0, 120) }]; }
    }
    const shot = `${out}/${vp}${route.replace(/\//g, '_')}.png`;
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    page.off('console', onConsole); page.off('response', onResp);
    results.push({ route, vp, status, ...m, axe, consoleErrors: [...new Set(errors)].slice(0, 5), failedRequests: [...new Set(failed)].slice(0, 6), shot });
    process.stdout.write(`${vp} ${route} overflowX=${m.overflowX ?? '?'} clipped=${m.clippedCount ?? '?'} tiny=${m.tinyCount ?? '?'} err=${errors.length} fail=${failed.length}${axe ? ' axe=' + axe.length : ''}\n`);
  }
  await ctx.close();
}
await browser.close();
writeFileSync(`${out}/results.json`, JSON.stringify({ base, user, at: new Date().toISOString(), results }, null, 2));
console.log(`\nwrote ${out}/results.json (${results.length} page views)`);
