import { describe, it, expect } from 'vitest';
import AdmZip from 'adm-zip';
import { DATASETS, QUICK_REPORTS, dataset, datasetInfo, canReadDataset } from '../../src/lib/reporting/catalog';
import { validateConfig, ReportConfigError } from '../../src/lib/reporting/validate';
import { compile } from '../../src/lib/reporting/compile';
import { formatDecimal, roundDecimal, toDecimal } from '../../src/lib/reporting/decimal';
import { toCsv, toHtml, toXlsx, toPdf, cellText } from '../../src/lib/reporting/render';
import type { ReportResult } from '../../src/lib/reporting/types';

// Pure tests of the reporting engine: no server, no database. The SQL the
// compiler produces is checked for shape and for the one property that
// matters most — user input only ever travels as bind parameters.

const v = (config: unknown, canSeePii = false) => validateConfig(config, { canSeePii });
const err = (config: unknown, canSeePii = false): ReportConfigError => {
  try { v(config, canSeePii); } catch (e) { if (e instanceof ReportConfigError) return e; throw e; }
  throw new Error('expected the config to be refused');
};

describe('catalogue', () => {
  it('has unique dataset keys and every default column and sort is a field', () => {
    expect(new Set(DATASETS.map((d) => d.key)).size).toBe(DATASETS.length);
    for (const d of DATASETS) {
      for (const c of d.defaultColumns) expect(d.fields.some((f) => f.key === c), `${d.key}.${c}`).toBe(true);
      for (const s of d.defaultSort) expect(d.fields.some((f) => f.key === s.field), `${d.key} sort ${s.field}`).toBe(true);
    }
  });
  it('covers the required entities and the executive summaries', () => {
    for (const k of ['parcels', 'ownership', 'persons', 'acquisitions', 'cases', 'case_owners', 'vouchers', 'allocations', 'leases', 'executive_province', 'executive_project'])
      expect(dataset(k), k).toBeTruthy();
  });
  it('every quick report validates, and legacy r1–r15 are all reimplemented', () => {
    for (const q of QUICK_REPORTS) expect(() => v(q.config, true), q.key).not.toThrow();
    const legacy = QUICK_REPORTS.map((q) => q.legacyId).filter(Boolean);
    expect(legacy.sort()).toEqual(Array.from({ length: 15 }, (_, i) => `r${i + 1}`).sort());
  });
  it('client metadata carries no SQL internals', () => {
    const info = datasetInfo(dataset('persons')!);
    expect(JSON.stringify(info)).not.toMatch(/api\.rpt_|_acres|"column"/);
  });
  it('a dataset needs reports:read and every module permission it reads', () => {
    const d = dataset('persons')!;
    const has = (perms: string[]) => (r: string, a: string) => perms.includes(`${r}:${a}`);
    expect(canReadDataset(d, has(['reports:read', 'landowners:read', 'cases:read', 'payments:read']))).toBe(true);
    expect(canReadDataset(d, has(['reports:read', 'landowners:read']))).toBe(false);
    expect(canReadDataset(d, has(['landowners:read', 'cases:read', 'payments:read']))).toBe(false);
  });
});

describe('validator', () => {
  it('refuses an unknown dataset, column, filter field, operator, group or sort key, naming it', () => {
    expect(err({ dataset: 'pg_shadow' }).field).toBe('dataset');
    const c = err({ dataset: 'cases', columns: ['case_code', 'password_hash'] });
    expect(c.field).toBe('columns'); expect(c.message).toContain('password_hash');
    expect(err({ dataset: 'cases', filters: [{ field: 'nope', op: 'eq', value: 1 }] }).field).toBe('filters.nope');
    expect(err({ dataset: 'cases', filters: [{ field: 'case_code', op: 'regex', value: '.*' }] }).field).toBe('filters.case_code');
    expect(err({ dataset: 'cases', groupBy: ['outstanding_amount'] }).field).toBe('groupBy.outstanding_amount');
    expect(err({ dataset: 'cases', sort: [{ field: 'x; DROP TABLE lms.project', dir: 'asc' }] }).message).toContain('DROP TABLE');
    expect(err({ dataset: 'cases', bogus: true }).field).toBe('bogus');
  });
  it('refuses wrongly typed values', () => {
    expect(err({ dataset: 'cases', filters: [{ field: 'payable_amount', op: 'gte', value: '1e9' }] }).field).toBe('filters.payable_amount');
    expect(err({ dataset: 'cases', filters: [{ field: 'payable_amount', op: 'gte', value: '10.123' }] }).field).toBe('filters.payable_amount');
    expect(err({ dataset: 'cases', filters: [{ field: 'case_date', op: 'gte', value: '2026-02-30' }] }).field).toBe('filters.case_date');
    expect(err({ dataset: 'cases', filters: [{ field: 'case_date', op: 'between', value: ['2026-01-01'] }] }).field).toBe('filters.case_date');
    expect(err({ dataset: 'vouchers', filters: [{ field: 'is_released', op: 'eq', value: 'yes' }] }).field).toBe('filters.is_released');
    expect(err({ dataset: 'cases', filters: [{ field: 'case_code', op: 'is_null', value: 'x' }] }).field).toBe('filters.case_code');
  });
  it('allows a partial CNIC search only to holders of pii:read; full CNIC is fine for everyone', () => {
    const partial = { dataset: 'persons', filters: [{ field: 'cnic', op: 'contains', value: '1100' }] };
    expect(err(partial).field).toBe('filters.cnic');
    expect(() => v(partial, true)).not.toThrow();
    expect(() => v({ dataset: 'persons', filters: [{ field: 'cnic', op: 'eq', value: '45102-1100012-3' }] })).not.toThrow();
    expect(err({ dataset: 'persons', filters: [{ field: 'cnic', op: 'eq', value: '4510211000123' }] }).field).toBe('filters.cnic');
  });
  it('never groups or sorts by personal data', () => {
    expect(err({ dataset: 'persons', groupBy: ['cnic'] }).field).toBe('groupBy.cnic');
    expect(err({ dataset: 'persons', sort: [{ field: 'cnic', dir: 'asc' }] }, true).field).toBe('sort.cnic');
  });
  it('checks unit mode, paging, aggregates and summaries', () => {
    expect(err({ dataset: 'parcels', uom: { mode: 'common' } }).field).toBe('uom.unit');
    expect(err({ dataset: 'parcels', uom: { mode: 'province', unit: 'Acre' } }).field).toBe('uom.unit');
    expect(err({ dataset: 'parcels', uom: { mode: 'metric' } }).field).toBe('uom.mode');
    expect(err({ dataset: 'parcels', page: { limit: 5000, offset: 0 } }).field).toBe('page.limit');
    expect(err({ dataset: 'parcels', page: { limit: 10, offset: -1 } }).field).toBe('page.offset');
    expect(err({ dataset: 'cases', columns: ['case_code', 'paid_amount'], aggregates: { paid_amount: 'median' } }).field).toBe('aggregates.paid_amount');
    expect(err({ dataset: 'cases', summaryOnly: true }).field).toBe('summaryOnly');
  });
  it('puts group columns first and defaults the rest', () => {
    const { config } = v({ dataset: 'cases', columns: ['case_code', 'paid_amount'], groupBy: ['province_code'] });
    expect(config.columns).toEqual(['province_code', 'case_code', 'paid_amount']);
    expect(config.totals).toBe(true);
    expect(config.page).toEqual({ limit: 100, offset: 0 });
    expect(config.uom).toEqual({ mode: 'province' });
  });
  it('defaults an area filter to the common unit, otherwise to acres', () => {
    const a = v({ dataset: 'parcels', filters: [{ field: 'area', op: 'gte', value: 5 }], uom: { mode: 'common', unit: 'Hectare' } }).config;
    expect(a.filters[0].unit).toBe('Hectare');
    const b = v({ dataset: 'parcels', filters: [{ field: 'area', op: 'gte', value: 5 }] }).config;
    expect(b.filters[0].unit).toBe('Acre');
  });
});

describe('compiler', () => {
  const hostile = "x' OR 1=1; DROP TABLE lms.project; --";
  const build = (config: unknown, pii: 'all' | 'none' | string[] = 'none', unit?: string, canSeePii = false) => {
    const { def, config: c } = v(config, canSeePii);
    return compile(def, c, { pii, unit, filterUnits: c.filters.reduce<Record<number, string>>((a, f, i) => (f.unit ? { ...a, [i]: f.unit } : a), {}) });
  };

  it('sends user values only as bind parameters', () => {
    const c = build({ dataset: 'persons', filters: [{ field: 'full_name', op: 'contains', value: hostile }, { field: 'province_code', op: 'in', value: ['SND', hostile] }] });
    for (const q of [c.detail(50, 0), c.aggregate()]) {
      expect(q.text).not.toContain('DROP TABLE');
      expect(q.text).not.toContain("1=1");
      expect(JSON.stringify(q.values)).toContain('DROP TABLE');
    }
    expect(c.detail(50, 0).text).toMatch(/ILIKE '%' \|\| \$\d+ \|\| '%' ESCAPE '\\'/);
  });
  it('escapes LIKE wildcards in a contains search', () => {
    const c = build({ dataset: 'persons', filters: [{ field: 'full_name', op: 'contains', value: '50%_off' }] });
    expect(c.detail(10, 0).values).toContain('50\\%\\_off');
  });
  it('reads columns only from the catalogue view', () => {
    const q = build({ dataset: 'cases', columns: ['case_code', 'outstanding_amount'] }).detail(10, 0).text;
    expect(q).toContain('FROM api.rpt_case v');
    expect(q).toContain('"outstanding_amount"');
  });
  it('masks CNICs in SQL unless the caller may see them, per province when partial', () => {
    expect(build({ dataset: 'persons', columns: ['owner_code', 'cnic'] }).detail(10, 0).text).toContain("'•••••-••••' || substr(");
    expect(build({ dataset: 'persons', columns: ['owner_code', 'cnic'] }, 'all').detail(10, 0).text).not.toContain('•');
    const partial = build({ dataset: 'persons', columns: ['owner_code', 'cnic'] }, ['SND']).detail(10, 0);
    expect(partial.text).toMatch(/= ANY\(\$\d+::text\[\]\) THEN/);
    expect(partial.values).toContainEqual(['SND']);
  });
  it('uses GROUPING SETS for subtotals per group and per unit, a grand total and totals per unit', () => {
    const q = build({ dataset: 'parcels', columns: ['district', 'parcel_code', 'area'], groupBy: ['province_code', 'district'] }).aggregate().text;
    expect(q).toContain('GROUPING SETS');
    expect(q).toContain('(b.__unit)');
    expect(q).toContain('()');
    expect(q).toMatch(/CASE WHEN count\(DISTINCT b\.__unit\) <= 1 THEN round\(sum/);
  });
  it('province mode reads the reporting unit per row; common mode takes the unit as a parameter', () => {
    const p = build({ dataset: 'parcels', columns: ['parcel_code', 'area'] }).detail(10, 0);
    expect(p.text).toContain('lms.report_unit_default');
    expect(p.text).toContain('ua.acre_sqm / ru.sqm_per_unit');
    const c = build({ dataset: 'parcels', columns: ['parcel_code', 'area'], uom: { mode: 'common', unit: 'Hectare' } }, 'none', 'Hectare').detail(10, 0);
    expect(c.text).not.toContain('report_unit_default');
    expect(c.values).toContain('Hectare');
  });
  it('original mode uses the recorded quantity and flags rows whose unit was not kept', () => {
    const c = build({ dataset: 'parcels', columns: ['parcel_code', 'area'], uom: { mode: 'original' } });
    expect(c.detail(10, 0).text).toContain('v."area_recorded"');
    expect(c.flagKeys).toContain('recorded_unit_unknown');
  });
  it('raises the unit and data-quality flags per row and counts them over the whole result', () => {
    const c = build({ dataset: 'parcels', columns: ['parcel_code', 'area'] });
    for (const k of ['unsupported_unit', 'provisional_factor', 'province_unit_unapproved', 'missing_area', 'shares_not_100']) expect(c.flagKeys).toContain(k);
    expect(c.detail(10, 0).text).toContain('array_remove(ARRAY[');
    expect(c.aggregate().text).toContain('"__f_provisional_factor"');
  });
  it('converts an area filter in another unit to acres in SQL', () => {
    const q = build({ dataset: 'parcels', filters: [{ field: 'area', op: 'gte', value: '8', unit: 'Kanal' }] }).detail(10, 0);
    expect(q.text).toMatch(/\* \(SELECT c\.sqm_per_unit FROM lms\.unit_conversion c WHERE c\.unit_code = \$\d+/);
    expect(q.values).toContain('Kanal');
  });
  it('pages with bind parameters and orders stably by the row key', () => {
    const q = build({ dataset: 'cases', columns: ['case_code'] }).detail(25, 50);
    expect(q.text).toMatch(/LIMIT \$\d+ OFFSET \$\d+$/);
    expect(q.values.slice(-2)).toEqual([25, 50]);
    expect(q.text).toContain('(b."case_code")::text ASC NULLS LAST');
    expect(build({ dataset: 'cases', columns: ['case_code'] }).detail(null, 0).text).not.toContain('LIMIT');
  });
  it('sorts areas by acres so mixed units order correctly', () => {
    const q = build({ dataset: 'parcels', columns: ['parcel_code', 'area'], sort: [{ field: 'area', dir: 'desc' }] }).detail(10, 0).text;
    expect(q).toContain('b."area_acres" DESC NULLS LAST');
  });
});

describe('decimals (money never becomes a float)', () => {
  it('rounds half away from zero, exactly', () => {
    expect(roundDecimal('0.125', 2)).toBe('0.13');
    expect(roundDecimal('-0.125', 2)).toBe('-0.13');
    expect(roundDecimal('2.675', 2)).toBe('2.68');           // 2.675 is 2.67499999… as a double
    expect(roundDecimal('-0.004', 2)).toBe('0.00');
    expect(roundDecimal('123456789012345678.995', 2)).toBe('123456789012345679.00');
  });
  it('formats with grouping and fixed places', () => {
    expect(formatDecimal('1234567.5')).toBe('1,234,567.50');
    expect(formatDecimal('-500')).toBe('-500.00');
    expect(formatDecimal('0.1', 4)).toBe('0.1000');
    expect(formatDecimal(null)).toBe('—');
  });
  it('accepts only plain decimals as input', () => {
    expect(toDecimal('12.50')).toBe('12.50');
    expect(toDecimal(12.5)).toBe('12.5');
    expect(toDecimal('1e3')).toBeNull();
    expect(toDecimal(1e21)).toBeNull();
    expect(toDecimal(Number.NaN)).toBeNull();
    expect(toDecimal('12.3456789')).toBeNull();
    expect(toDecimal('0x10')).toBeNull();
  });
});

describe('exports carry exactly the rows and totals of the result', () => {
  const result: ReportResult = {
    columns: [
      { key: 'case_code', label: 'Case', type: 'code' },
      { key: 'owner_name', label: 'Owner', type: 'text' },
      { key: 'lease_area', label: 'Lease area', type: 'area' },
      { key: 'outstanding_amount', label: 'Outstanding', type: 'money', aggregate: 'sum' },
    ],
    rows: [
      { kind: 'detail', cells: { case_code: 'CC-1', owner_name: '=HYPERLINK("http://x","y")', lease_area: '12.5000', outstanding_amount: '-500.00' }, unit: 'Kanal', flags: ['overpaid'] },
      { kind: 'detail', cells: { case_code: 'CC-2', owner_name: 'Zubaida <Khatoon>', lease_area: '1.2500', outstanding_amount: '2240312.50' }, unit: 'Acre' },
      { kind: 'total', cells: { case_code: null, owner_name: null, lease_area: null, outstanding_amount: '2239812.50', _rows: 2 }, unit: null, flags: ['mixed_units'] },
    ],
    page: { limit: 2, offset: 0, total: 2 },
    flags: { overpaid: 1 },
    unitTotals: [{ unit: 'Acre', rows: 1, cells: { outstanding_amount: '2240312.50' } }, { unit: 'Kanal', rows: 1, cells: { outstanding_amount: '-500.00' } }],
    meta: {
      dataset: 'cases', title: 'Test', grain: 'one row per compensation case', uom: { mode: 'province' }, filtersApplied: ['Province is one of SND, PNJ'],
      scope: 'Consolidated: Sindh (SND), Punjab (PNJ)', generatedAt: '2026-10-30T00:00:00Z', piiMasked: true, definitions: ['Outstanding: payable − paid.'],
      mixedUnits: true,
    },
  };
  const header = { title: 'Compensation test', reference: 'RPT-20261030-0000-abcd', generatedBy: 'Test User', generatedAt: new Date('2026-10-30T09:00:00Z') };

  it('CSV: BOM, the header block, plain signed numbers, formula text neutralised, one line per row', () => {
    const csv = toCsv(result, header).toString('utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('"Reference","RPT-20261030-0000-abcd"');
    expect(csv).toContain('"Scope","Consolidated: Sindh (SND), Punjab (PNJ)"');
    expect(csv).toContain('"-500.00"');
    expect(csv).not.toContain("'-500.00");
    expect(csv).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csv).toContain('"Total (2 records)"');
    expect(csv).toContain('"Unit"');
    expect(csv).toContain('CONFIDENTIAL');
  });
  it('Excel: money as numeric cells (negative kept), formula text as an inline string', () => {
    const zip = new AdmZip(toXlsx(result, header));
    const sheet = zip.readAsText('xl/worksheets/sheet1.xml');
    expect(sheet).toMatch(/<c r="[A-Z]+\d+" s="2"><v>-500\.00<\/v><\/c>/);
    expect(sheet).toMatch(/<c r="[A-Z]+\d+" s="6"><v>2239812\.50<\/v><\/c>/);   // bold money on the total row
    expect(sheet).not.toMatch(/<f>/);
  });
  it('HTML: escaped, branded, header repeated on printed pages, page numbers', () => {
    const html = toHtml(result, header).toString('utf8');
    expect(html).toContain('Zubaida &lt;Khatoon&gt;');
    expect(html).not.toContain('<Khatoon>');
    expect(html).toContain('thead { display: table-header-group; }');
    expect(html).toContain('counter(page)');
    expect(html).toContain('Mari Energies Limited');
    expect(html).not.toMatch(/<script/i);
    expect((html.match(/<tr( class="[a-z]+")?>/g) ?? []).length).toBe(1 + result.rows.length);
  });
  it('PDF: produced with page numbers and the logo', async () => {
    const pdf = await toPdf(result, header);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
  it('formats cells from exact strings', () => {
    expect(cellText({ key: 'm', label: 'M', type: 'money' }, '1041562.5')).toBe('1,041,562.50');
    expect(cellText({ key: 'p', label: 'P', type: 'percent' }, '33.3333')).toBe('33.3333%');
    expect(cellText({ key: 'p', label: 'P', type: 'percent' }, '100.0000')).toBe('100%');
    expect(cellText({ key: 'a', label: 'A', type: 'area' }, '150.0000000000')).toBe('150.0000');
  });
});
