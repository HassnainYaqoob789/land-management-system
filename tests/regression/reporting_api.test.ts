import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import AdmZip from 'adm-zip';
import { generate } from 'otplib';
import { BASE, Client, sql } from '../iam/client';

// The reporting acceptance criteria, through real sign-in against the real
// database (migration 0043 applied). beforeAll loads db/seeds/reporting_fixture.sql
// (idempotent, test databases only; every code starts RPTFX). Steps that change
// data (adjustments, reversals, templates) use records created for this run,
// so the file can run again.
//
// Roles: mland = land-manager (all provinces, pii, export, share, approve,
// release); viewer = the security auditor account `audit` (reads, no pii, no
// export; since 0047 the analyst account `viewer` no longer reads these registers); lofield =
// data-entry (Sindh only, no export); finance = finance-approver (no release).

async function signIn(user: string): Promise<Client> {
  const c = new Client();
  expect((await c.login(user)).status, `sign in ${user}`).toBe(200);
  const me = await c.get('/api/auth/me');
  if (me.data.mfa?.enrolmentOutstanding) {
    const s = await c.post('/api/auth/mfa/totp/start');
    await c.post('/api/auth/mfa/totp/confirm', { code: await generate({ secret: s.data.secret }) });
  }
  return c;
}

const RUN = Date.now().toString(36).toUpperCase().slice(-6);
const fx = (field = 'parcel_code') => ({ field, op: 'starts', value: 'RPTFX' });
const cases = (extra: Record<string, unknown> = {}) => ({
  dataset: 'cases', filters: [fx('case_code')],
  columns: ['case_code', 'province_code', 'stage_code', 'assessed_amount', 'approved_amount', 'adjustment_amount', 'payable_amount',
    'paid_amount', 'wht_amount', 'paid_net_amount', 'reversed_amount', 'outstanding_amount', 'settlement_status'],
  sort: [{ field: 'case_code', dir: 'asc' }], page: { limit: 500, offset: 0 }, ...extra,
});
const cents = (s: string | null) => (s === null ? 0n : BigInt(s.replace('.', '')));
const detail = (r: any) => r.data.rows.filter((x: any) => x.kind === 'detail');
const total = (r: any) => r.data.rows.find((x: any) => x.kind === 'total');
const byCode = (r: any, key: string, code: string) => detail(r).find((x: any) => x.cells[key] === code);
const authEvents = (type: string, extra = '') => Number(sql(`SELECT count(*) FROM audit.auth_event WHERE event_type = '${type}' ${extra}`));

async function download(c: Client, body: unknown): Promise<{ status: number; type: string; disposition: string; buf: Buffer; json?: any }> {
  const r = await fetch(`${BASE}/api/reports/export`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/json', cookie: c.cookieHeader(), origin: c.origin, 'x-csrf-token': c.csrf },
    body: JSON.stringify(body),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  let json: any; try { json = JSON.parse(buf.toString('utf8')); } catch { /* a file */ }
  return { status: r.status, type: r.headers.get('content-type') ?? '', disposition: r.headers.get('content-disposition') ?? '', buf, json };
}

let mland: Client, viewer: Client, lofield: Client, finance: Client;
let runCaseId = ''; let runReleaseId = '';

beforeAll(async () => {
  sql(readFileSync('db/seeds/reporting_fixture.sql', 'utf8'));
  // A case of this run for the adjustment and reversal steps: approved 10,000,
  // paid in full by a cheque released by Finance (so a land manager may reverse it).
  // Prepared by the land officer, then approved and released by Manager Land: whoever
  // prepared a case may not adjust its award (separation of duties).
  sql(`SELECT api.set_actor((SELECT id FROM lms.app_user WHERE username = 'lofield'));
    DO $$ DECLARE s uuid; c uuid; p uuid; lo uuid; pr uuid; BEGIN
      SELECT id INTO p FROM lms.project WHERE code = 'RPTFX-SND';
      SELECT id INTO lo FROM lms.landowner WHERE code = 'RPTFX-LO1';
      INSERT INTO lms.survey (code, province_code, admin_unit_id, survey_no, land_class, total_area, status_code)
      SELECT 'RPTRUN-S${RUN}', 'SND', (SELECT id FROM lms.admin_unit WHERE province_code = 'SND' ORDER BY level DESC, code LIMIT 1), 'RPTRUN-${RUN}', 'Private', 1, 'Proposed'
      RETURNING id INTO s;
      INSERT INTO lms.compensation_case (code, province_code, project_id, land_use_code, case_date, effective_date, lease_term_months, stage_code)
      VALUES ('RPTFX-R${RUN}', 'SND', p, 'Well Location', current_date, current_date, 12, 'Prepared') RETURNING id INTO c;
      INSERT INTO lms.case_lease_line (case_id, survey_id, lease_area, line_no) VALUES (c, s, 1, 1);
      INSERT INTO lms.case_misc_line (case_id, payment_type, amount) VALUES (c, 'RPTFX award', 10000);
      INSERT INTO lms.case_owner (case_id, landowner_id, owner_status, share_pct) VALUES (c, lo, 'O', 100);
      PERFORM api.recalculate_case_totals(c);
      SET CONSTRAINTS ALL IMMEDIATE;
      PERFORM api.set_actor((SELECT id FROM lms.app_user WHERE username = 'mland'));
      UPDATE lms.compensation_case SET stage_code = 'HO Approved', approved_at = now() WHERE id = c;
      INSERT INTO lms.payment_request (code, province_code, landowner_id, project_id, case_id, category_code, pay_type, period_from, gross_amount, wht_pct, payment_mode, stage_code, remarks)
      VALUES ('RPTFX-RV${RUN}', 'SND', lo, p, c, 'Lease Rent', 'One-time', current_date, 10000, 0, 'Cross Cheque', 'Verified', 'RPTFX run payment') RETURNING id INTO pr;
      INSERT INTO lms.payment_release (payment_id, province_code, cheque_no, cheque_date, released_amount, released_by)
      VALUES (pr, 'SND', 'RPTFX-RC${RUN}', current_date, 10000, (SELECT id FROM lms.app_user WHERE username = 'finance'));
      UPDATE lms.payment_request SET stage_code = 'Released' WHERE id = pr;
      PERFORM api.allocate_payment(pr, c, 10000, lo, 'RPTFX run');
    END $$;`);
  runCaseId = sql(`SELECT id FROM lms.compensation_case WHERE code = 'RPTFX-R${RUN}'`);
  runReleaseId = sql(`SELECT r.id FROM lms.payment_release r JOIN lms.payment_request p ON p.id = r.payment_id WHERE p.code = 'RPTFX-RV${RUN}'`);
  sql(`UPDATE iam.account_security SET failed_count = 0, locked_until = NULL`);
  // Every fixture account may need MFA (0041: sensitive permissions), and other test files
  // enrol some (e.g. lofield); start each file from no authenticator at all.
  sql(`DELETE FROM iam.mfa_totp WHERE user_id IN (SELECT id FROM lms.app_user WHERE NOT is_service_account);
       DELETE FROM iam.mfa_recovery_code WHERE user_id IN (SELECT id FROM lms.app_user WHERE NOT is_service_account)`);
  [mland, viewer, lofield, finance] = await Promise.all(['mland', 'audit', 'lofield', 'finance'].map(signIn));
}, 180_000);

const run = (c: Client, config: unknown) => c.post('/api/reports/run', { config });

describe('1. a province report shows the province\'s unit', () => {
  it('Punjab parcels are in kanals; Sindh parcels in acres', async () => {
    const pnj = await run(mland, { dataset: 'parcels', columns: ['parcel_code', 'province_code', 'area'], filters: [fx(), { field: 'province_code', op: 'eq', value: 'PNJ' }] });
    expect(pnj.status, JSON.stringify(pnj.data)).toBe(200);
    const p1 = byCode(pnj, 'parcel_code', 'RPTFX-P1');
    expect(p1.unit).toBe('Kanal');
    expect(p1.cells.area).toBe('16.0000');
    expect(pnj.data.meta.uom.provinceUnits.find((u: any) => u.province === 'PNJ').unit).toBe('Kanal');
    const snd = await run(mland, { dataset: 'parcels', columns: ['parcel_code', 'area'], filters: [fx(), { field: 'province_code', op: 'eq', value: 'SND' }] });
    expect(byCode(snd, 'parcel_code', 'RPTFX-S1').unit).toBe('Acre');
    expect(byCode(snd, 'parcel_code', 'RPTFX-S1').cells.area).toBe('2.0000');
  });
});

describe('2. a consolidated report keeps units apart', () => {
  it('totals per unit and no grand total of area across units', async () => {
    const r = await run(mland, { dataset: 'parcels', columns: ['parcel_code', 'province_code', 'area'], filters: [fx()] });
    expect(r.status).toBe(200);
    const acre = r.data.unitTotals.find((u: any) => u.unit === 'Acre');
    const kanal = r.data.unitTotals.find((u: any) => u.unit === 'Kanal');
    expect(acre.cells.area).toBe('6.0000');        // S1 2 + S2 2 + B1 2 acres
    expect(kanal.cells.area).toBe('40.0000');      // P1 16 + K1 24 kanal
    expect(total(r).cells.area).toBeNull();
    expect(r.data.meta.mixedUnits).toBe(true);
  });
});

describe('3. converting to a common unit', () => {
  it('converts every area exactly and totals it', async () => {
    const r = await run(mland, { dataset: 'parcels', columns: ['parcel_code', 'area'], filters: [fx()], uom: { mode: 'common', unit: 'Hectare' } });
    expect(r.status).toBe(200);
    expect(r.data.columns.find((c: any) => c.key === 'area').unit).toBe('Hectare');
    expect(byCode(r, 'parcel_code', 'RPTFX-S1').cells.area).toBe('0.8094');   // 2 × 0.40468564224
    // 11 acres: S1 2 + S2 2 + B1 2 + P1 2 (16 kanal) + K1 3 (24 kanal) = 4.4515 ha. The old
    // 5.2609 (13 acres) also counted parcels left over from earlier runs.
    expect(total(r).cells.area).toBe('4.4515');
    expect(r.data.meta.mixedUnits).toBe(false);
  });
  it('an area filter in another unit is compared in acres', async () => {
    const r = await run(mland, { dataset: 'parcels', columns: ['parcel_code', 'area'], filters: [fx(), { field: 'area', op: 'gte', value: '16', unit: 'Kanal' }] });
    expect(r.status).toBe(200);
    expect(detail(r).map((x: any) => x.cells.parcel_code).sort()).toEqual(['RPTFX-B1', 'RPTFX-K1', 'RPTFX-P1', 'RPTFX-S1', 'RPTFX-S2']);
  });
});

describe('4. unsupported, provisional and missing units are flagged', () => {
  it('original mode shows the recorded unit and flags where it was not kept', async () => {
    const r = await run(mland, { dataset: 'parcels', columns: ['parcel_code', 'area'], filters: [fx()], uom: { mode: 'original' } });
    expect(byCode(r, 'parcel_code', 'RPTFX-S2').unit).toBe('Jireb');
    expect(byCode(r, 'parcel_code', 'RPTFX-S2').cells.area).toBe('4.0000');
    expect(byCode(r, 'parcel_code', 'RPTFX-K1').flags).toContain('recorded_unit_unknown');
    expect(r.data.flags.recorded_unit_unknown).toBeGreaterThanOrEqual(1);
    expect(byCode(r, 'parcel_code', 'RPTFX-S2').flags).toContain('recorded_provisional');
  });
  it('a provisional factor and an unapproved province unit are flagged and counted', async () => {
    const j = await run(mland, { dataset: 'parcels', columns: ['parcel_code', 'area'], filters: [fx()], uom: { mode: 'common', unit: 'Jireb' } });
    expect(j.data.flags.provisional_factor).toBe(5);
    expect(j.data.meta.flagText.provisional_factor).toMatch(/provisional/i);
    const p = await run(mland, { dataset: 'parcels', columns: ['parcel_code', 'area'], filters: [fx()] });
    expect(p.data.flags.province_unit_unapproved).toBe(5);
  });
  it('a unit with no factor is refused, naming the setting', async () => {
    const r = await run(mland, { dataset: 'parcels', columns: ['parcel_code', 'area'], uom: { mode: 'common', unit: 'Furlong' } });
    expect(r.status).toBe(400);
    expect(r.data.field).toBe('uom.unit');
  });
});

describe('5. the person / CNIC statement', () => {
  it('associates the owner, parcels, cases, payments and balances', async () => {
    const r = await mland.get('/api/reports/person?cnic=99701-0000001-1');
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.identity.code).toBe('RPTFX-LO1');
    expect(r.data.identity.cnic).toBe('99701-0000001-1');
    const shares = detail({ data: r.data.parcels }).map((x: any) => [x.cells.parcel_code, x.cells.share_pct]);
    expect(shares).toEqual(expect.arrayContaining([['RPTFX-S1', '60.0000'], ['RPTFX-S2', '100.0000']]));
    const c1 = detail({ data: r.data.cases }).find((x: any) => x.cells.case_code === 'RPTFX-C1');
    expect([c1.cells.payable_amount, c1.cells.paid_amount, c1.cells.wht_amount, c1.cells.outstanding_amount]).toEqual(['60000.00', '30000.00', '3000.00', '30000.00']);
    expect(r.data.balances).toMatchObject({ payable: expect.any(String), paid: expect.any(String) });
    // Fixture money (this run's case RPTFX-R… adds 10,000 payable and its payment, net zero unless reversed later).
    expect(r.data.otherPayments.map((x: any) => x.voucher_code)).toContain('RPTFX-V5');
    expect(r.data.payments.some((x: any) => x.voucher_code === 'RPTFX-V1' && x.settled_gross === '30000.00' && x.allocated_net === '27000.00')).toBe(true);
    const last = r.data.statement[r.data.statement.length - 1];
    expect(cents(last.running_total)).toBe(cents(r.data.balances.outstanding));
  });
  it('a co-owner sees only their share', async () => {
    const r = await mland.get('/api/reports/person?cnic=99701-0000002-2');
    const c1 = detail({ data: r.data.cases }).find((x: any) => x.cells.case_code === 'RPTFX-C1');
    expect([c1.cells.payable_amount, c1.cells.paid_amount, c1.cells.outstanding_amount]).toEqual(['40000.00', '20000.00', '20000.00']);
  });
  it('masks the CNIC, phone, IBAN and address for a viewer without pii:read', async () => {
    // A CNIC lookup needs pii:read (audit 2026-10-31); by landowner code the statement is shown, masked.
    expect((await viewer.get('/api/reports/person?cnic=99701-0000001-1')).status).toBe(403);
    const r = await viewer.get('/api/reports/person?landowner=RPTFX-LO1');
    expect(r.status).toBe(200);
    expect(r.data.identity.cnic).toContain('•');
    expect(r.data.piiMasked).toBe(true);
  });
});

describe('6. assessed, approved, paid, adjusted and outstanding reconcile', () => {
  it('per case and in total, and with the database', async () => {
    const r = await run(mland, cases({ filters: [{ field: 'case_code', op: 'in', value: ['RPTFX-C1', 'RPTFX-C2', 'RPTFX-C3', 'RPTFX-C4', 'RPTFX-C5'] }] }));
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const status = Object.fromEntries(detail(r).map((x: any) => [x.cells.case_code, x.cells.settlement_status]));
    expect(status).toEqual({ 'RPTFX-C1': 'Part paid', 'RPTFX-C2': 'Settled', 'RPTFX-C3': 'Overpaid', 'RPTFX-C4': 'Unpaid', 'RPTFX-C5': 'Not approved' });
    expect(byCode(r, 'case_code', 'RPTFX-C3').cells.outstanding_amount).toBe('-5000.00');   // never clamped to zero
    expect(byCode(r, 'case_code', 'RPTFX-C4').cells.reversed_amount).toBe('30000.00');
    expect(byCode(r, 'case_code', 'RPTFX-C5').cells.outstanding_amount).toBeNull();
    const t = total(r).cells;
    expect([t.assessed_amount, t.approved_amount, t.adjustment_amount, t.payable_amount, t.paid_amount, t.outstanding_amount])
      .toEqual(['25000.00', '190000.00', '-5000.00', '185000.00', '110000.00', '75000.00']);
    expect(cents(t.paid_amount) + cents(t.outstanding_amount)).toBe(cents(t.payable_amount));
    expect(cents(t.wht_amount) + cents(t.paid_net_amount)).toBe(cents(t.paid_amount));
    expect(r.data.flags.overpaid).toBe(1);
    // 12. the same figures straight from the database
    expect(sql(`SELECT sum(payable_amount) || '|' || sum(paid_amount) || '|' || sum(outstanding_amount) FROM lms.case_money
                WHERE case_code IN ('RPTFX-C1','RPTFX-C2','RPTFX-C3','RPTFX-C4','RPTFX-C5')`)).toBe('185000.00|110000.00|75000.00');
  });
});

describe('7. filters, sorting, grouping, subtotals and saved templates', () => {
  const five = { field: 'case_code', op: 'in', value: ['RPTFX-C1', 'RPTFX-C2', 'RPTFX-C3', 'RPTFX-C4', 'RPTFX-C5'] };
  it('subtotals per province, in group order', async () => {
    const r = await run(mland, cases({ filters: [five], groupBy: ['province_code'] }));
    const subs = r.data.rows.filter((x: any) => x.kind === 'subtotal');
    const by = Object.fromEntries(subs.map((s: any) => [s.cells.province_code, s.cells.outstanding_amount]));
    expect(by).toMatchObject({ SND: '50000.00', PNJ: '-5000.00', BAL: '30000.00' });
    // each subtotal follows the last detail row of its group
    const order = r.data.rows.map((x: any) => `${x.kind}:${x.cells.province_code ?? ''}`);
    expect(order.indexOf('subtotal:SND')).toBeGreaterThan(order.lastIndexOf('detail:SND'));
  });
  it('sorts, and filters with in / between / starts', async () => {
    const s = await run(mland, cases({ filters: [five], sort: [{ field: 'outstanding_amount', dir: 'desc' }] }));
    expect(detail(s).map((x: any) => x.cells.case_code)).toEqual(['RPTFX-C1', 'RPTFX-C4', 'RPTFX-C2', 'RPTFX-C3', 'RPTFX-C5']);
    const f = await run(mland, cases({ filters: [five, { field: 'settlement_status', op: 'in', value: ['Unpaid', 'Part paid'] }] }));
    expect(detail(f).map((x: any) => x.cells.case_code)).toEqual(['RPTFX-C1', 'RPTFX-C4']);
    const b = await run(mland, cases({ filters: [five, { field: 'payable_amount', op: 'between', value: ['20000', '35000'] }] }));
    expect(detail(b).map((x: any) => x.cells.case_code)).toEqual(['RPTFX-C2', 'RPTFX-C3', 'RPTFX-C4']);
    expect(b.data.meta.filtersApplied.join(' ')).toContain('Payable between 20000 and 35000');
  });
  it('a bad field is refused with a 400 naming it', async () => {
    const r = await run(mland, { dataset: 'cases', columns: ['case_code', 'secret_column'] });
    expect(r.status).toBe(400);
    expect(r.data.code).toBe('invalid_config');
    expect(r.data.error).toContain('secret_column');
  });
  it('saves, shares, edits and deletes templates under the access rules', async () => {
    const config = cases({ filters: [five] });
    const mine = await mland.post('/api/reports/templates', { name: `RPTFX private ${RUN}`, config });
    expect(mine.status, JSON.stringify(mine.data)).toBe(201);
    expect(mine.data.mine).toBe(true);
    expect((await viewer.get('/api/reports/templates')).data.some((t: any) => t.id === mine.data.id)).toBe(false);
    expect((await viewer.post('/api/reports/templates', { name: `RPTFX shared ${RUN}`, config, visibility: 'shared' })).status).toBe(403);
    const shared = await mland.post('/api/reports/templates', { name: `RPTFX shared ${RUN}`, config, visibility: 'shared' });
    expect(shared.status).toBe(201);
    expect((await viewer.get('/api/reports/templates')).data.some((t: any) => t.id === shared.data.id)).toBe(true);
    expect((await viewer.req('DELETE', `/api/reports/templates?id=${shared.data.id}`)).status).toBe(404);
    const renamed = await mland.req('PUT', `/api/reports/templates?id=${mine.data.id}`, { name: `RPTFX renamed ${RUN}`, config, isDefault: true });
    expect(renamed.status).toBe(200);
    expect(renamed.data.isDefault).toBe(true);
    expect((await mland.post('/api/reports/templates', { name: `RPTFX bad ${RUN}`, config: { dataset: 'cases', columns: ['nope'] } })).status).toBe(400);
    for (const id of [mine.data.id, shared.data.id]) expect((await mland.req('DELETE', `/api/reports/templates?id=${id}`)).status).toBe(200);
  });
});

describe('8. PDF, Excel, CSV and print output match the screen', () => {
  const config = () => cases({ filters: [{ field: 'case_code', op: 'in', value: ['RPTFX-C1', 'RPTFX-C2', 'RPTFX-C3', 'RPTFX-C4', 'RPTFX-C5'] }] });
  it('CSV carries exactly the rows and totals of the screen', async () => {
    const screen = await run(mland, config());
    const f = await download(mland, { config: config(), format: 'csv', title: 'RPTFX reconciliation' });
    expect(f.status).toBe(200);
    expect(f.type).toContain('text/csv');
    expect(f.disposition).toMatch(/^attachment; filename="RPTFX_reconciliation_RPT-\d{8}-\d{4}-[0-9a-f]{4}\.csv"$/);
    const text = f.buf.toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    for (const row of detail(screen)) {
      const line = text.split('\r\n').find((l) => l.startsWith(`"${row.cells.case_code}"`))!;
      expect(line, row.cells.case_code).toContain(`"${row.cells.outstanding_amount ?? ''}"`);
    }
    expect(text).toContain(`"Total (5 records)"`);
    expect(text).toContain(`"${total(screen).cells.outstanding_amount}"`);
    for (const k of ['Reference', 'Generated', 'Scope', 'Filters', 'Unit of measure']) expect(text).toContain(`"${k}"`);
    expect(text).toContain('CONFIDENTIAL');
  });
  it('Excel, PDF and HTML are produced from the same rows', async () => {
    const x = await download(mland, { config: config(), format: 'xlsx' });
    expect(x.status).toBe(200);
    const sheet = new AdmZip(x.buf).readAsText('xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<v>-5000.00</v>');
    expect(sheet).not.toMatch(/<f>/);
    const p = await download(mland, { config: config(), format: 'pdf' });
    expect(p.status).toBe(200);
    expect(p.buf.subarray(0, 5).toString()).toBe('%PDF-');
    const h = await download(mland, { config: config(), format: 'html' });
    expect(h.status).toBe(200);
    const html = h.buf.toString('utf8');
    for (const c of ['RPTFX-C1', 'RPTFX-C5']) expect(html).toContain(c);
    expect(html).toContain('data:image/png;base64,');
    expect(html).toContain('counter(page)');
  });
});

describe('9. unauthorised users cannot reach restricted reports, fields or exports', () => {
  it('no export without reports:export, and the refusal is audited', async () => {
    const before = authEvents('report_export', `AND outcome = 'denied'`);
    const r = await download(viewer, { config: cases(), format: 'csv' });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('forbidden');
    expect(authEvents('report_export', `AND outcome = 'denied'`)).toBe(before + 1);
    expect((await viewer.get('/api/analytics/reports?report=r5&format=csv')).status).toBe(403);
  });
  it('CNICs are masked without pii:read, and a partial CNIC search is refused', async () => {
    const r = await run(viewer, { dataset: 'persons', columns: ['owner_code', 'cnic'], filters: [fx('owner_code')] });
    expect(r.status).toBe(200);
    expect(detail(r).every((x: any) => String(x.cells.cnic).includes('•'))).toBe(true);
    expect(r.data.meta.piiMasked).toBe(true);
    const p = await run(viewer, { dataset: 'persons', filters: [{ field: 'cnic', op: 'contains', value: '99701' }] });
    expect(p.status).toBe(400);
    expect(p.data.field).toBe('filters.cnic');
    const full = await run(mland, { dataset: 'persons', columns: ['owner_code', 'cnic'], filters: [{ field: 'cnic', op: 'eq', value: '99701-0000003-3' }] });
    expect(detail(full)[0].cells.cnic).toBe('99701-0000003-3');
  });
  it('a province-scoped user sees only their province', async () => {
    const r = await run(lofield, cases({ filters: [fx('case_code')] }));
    expect(r.status).toBe(200);
    expect(new Set(detail(r).map((x: any) => x.cells.province_code))).toEqual(new Set(['SND']));
    expect((await lofield.get('/api/reports/person?cnic=99701-0000003-3')).status).toBe(404);   // a Punjab owner
    const ex = await run(lofield, { dataset: 'executive_province', columns: ['province_code', 'area'] });
    expect(detail(ex).map((x: any) => x.cells.province_code)).toEqual(['SND']);
  });
  it('the catalogue tells each user what they may do', async () => {
    const v = await viewer.get('/api/reports/catalog');
    expect(v.data.can).toMatchObject({ export: false, seePii: false });
    const m = await mland.get('/api/reports/catalog');
    expect(m.data.can).toMatchObject({ export: true, seePii: true, share: true });
    expect(m.data.datasets.find((d: any) => d.key === 'cases').fields.every((f: any) => !('column' in f))).toBe(true);
    expect((await new Client().get('/api/reports/catalog')).status).toBe(401);
  });
  it('adjusting needs cases:approve and reversing needs payments:release', async () => {
    expect((await lofield.post(`/api/cases/${runCaseId}/adjustments`, { amount: '-1.00', reason: 'not allowed to do this' })).status).toBe(403);
    expect((await finance.post(`/api/payments/releases/${runReleaseId}/reverse`, { reason: 'not allowed to do this' })).status).toBe(403);
  });
});

describe('adjustments and reversals through the API', () => {
  it('a negative adjustment lowers the payable award and can show an over-payment', async () => {
    expect((await mland.post(`/api/cases/${runCaseId}/adjustments`, { amount: 'abc', reason: 'court decree reduced it' })).status).toBe(400);
    expect((await mland.post(`/api/cases/${runCaseId}/adjustments`, { amount: '-10', reason: 'short' })).status).toBe(400);
    const r = await mland.post(`/api/cases/${runCaseId}/adjustments`, { amount: '-2500.00', reason: 'RPTFX court decree reduced the award' });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.case).toMatchObject({ payable_amount: '7500.00', outstanding_amount: '-2500.00', settlement_status: 'Overpaid' });
    expect((await mland.post(`/api/cases/${runCaseId}/adjustments`, { amount: '-99999.00', reason: 'more than the whole award' })).status).toBe(409);
    expect((await mland.get(`/api/cases/${runCaseId}/adjustments`)).data.adjustments.length).toBe(1);
  });
  it('a reversal un-pays the cheque, once', async () => {
    const r = await mland.post(`/api/payments/releases/${runReleaseId}/reverse`, { reason: 'RPTFX cheque returned by the bank' });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect((await mland.post(`/api/payments/releases/${runReleaseId}/reverse`, { reason: 'RPTFX cheque returned again' })).status).toBe(409);
    const c = await mland.get(`/api/cases/${runCaseId}/adjustments`);
    expect(c.data.case).toMatchObject({ paid_amount: '0.00', outstanding_amount: '7500.00', settlement_status: 'Unpaid' });
  });
});

describe('10. large reports stay bounded', () => {
  it('pages are capped and a run over every voucher returns quickly', async () => {
    const t0 = Date.now();
    const r = await run(mland, { dataset: 'vouchers', page: { limit: 500, offset: 0 } });
    expect(r.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(detail(r).length).toBeLessThanOrEqual(500);
    expect(r.data.page.total).toBeGreaterThanOrEqual(detail(r).length);
    expect((await run(mland, { dataset: 'vouchers', page: { limit: 5000, offset: 0 } })).status).toBe(400);
    const far = await run(mland, { dataset: 'vouchers', page: { limit: 10, offset: 9_000_000 } });
    expect(far.status).toBe(200);
    expect(detail(far)).toEqual([]);
  });
});

describe('11. sensitive runs and exports are audited, without personal data', () => {
  it('a run, a statement and an export each leave one audit event', async () => {
    const runs = authEvents('report_run', `AND metadata->>'dataset' = 'persons'`);
    await run(mland, { dataset: 'persons', columns: ['owner_code', 'cnic'], filters: [{ field: 'cnic', op: 'eq', value: '99701-0000001-1' }] });
    expect(authEvents('report_run', `AND metadata->>'dataset' = 'persons'`)).toBe(runs + 1);
    const last = sql(`SELECT metadata::text FROM audit.auth_event WHERE event_type = 'report_run' AND metadata->>'dataset' = 'persons' ORDER BY id DESC LIMIT 1`);
    expect(last).not.toContain('99701-');          // the CNIC searched for is not written down
    expect(last).toContain('value_withheld');
    const st = authEvents('report_run', `AND metadata->>'dataset' = 'person_statement'`);
    await mland.get('/api/reports/person?cnic=99701-0000001-1');
    expect(authEvents('report_run', `AND metadata->>'dataset' = 'person_statement'`)).toBe(st + 1);
    expect(sql(`SELECT metadata::text FROM audit.auth_event WHERE event_type = 'report_run' AND metadata->>'dataset' = 'person_statement' ORDER BY id DESC LIMIT 1`)).not.toContain('99701-');
    const ex = authEvents('report_export', `AND outcome = 'success' AND metadata->>'format' = 'xlsx'`);
    await download(mland, { config: cases(), format: 'xlsx' });
    expect(authEvents('report_export', `AND outcome = 'success' AND metadata->>'format' = 'xlsx'`)).toBe(ex + 1);
  });
});

describe('legacy reports r1–r15 keep their shape on the new engine', () => {
  it('r5 shows assessed and approved separately and never a clamped balance', async () => {
    const r = await mland.get('/api/analytics/reports?report=r5');
    expect(r.status).toBe(200);
    expect(r.data.cols).toEqual(expect.arrayContaining(['Assessed (PKR)', 'Approved (PKR)', 'Outstanding (PKR)']));
    expect(r.data.rows.some((row: string[]) => row.includes('RPTFX-C3') && row.includes('-5,000.00'))).toBe(true);
  });
  it('an unsupported filter is refused instead of ignored', async () => {
    const r = await mland.get('/api/analytics/reports?report=r11&province=SND');
    expect(r.status).toBe(400);
    expect(r.data.field).toBe('province');
  });
  it('the KPI package uses the same definitions', async () => {
    const k = await mland.get('/api/analytics/kpis?province=PNJ');
    expect(k.status).toBe(200);
    const [out, over] = sql(`SELECT sum(greatest(outstanding_amount, 0)) || '|' || sum(greatest(-outstanding_amount, 0)) FROM lms.case_money WHERE province_code = 'PNJ'`).split('|');
    // Compared as amounts: '0' and '0.00' are the same figure.
    expect(Number(k.data.kpis.executive.outstanding_liability)).toBe(Number(out));
    expect(Number(k.data.kpis.executive.overpaid_amount)).toBe(Number(over));
  });
});
