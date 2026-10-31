// Runs a validated report and assembles the result the screen and every
// export share: the same compiled SQL, so a PDF, workbook or CSV carries
// exactly the rows, subtotals and totals the screen shows for that config.
import type { PoolClient } from 'pg';
import { field, type DatasetDef } from './catalog';
import { compile, type Compiled, type PiiScope } from './compile';
import { FLAG_TEXT, type ExportFormat, type FilterSpec, type ReportResult, type RowOut } from './types';
import { ReportConfigError, type ValidConfig } from './validate';

export class ReportTooLargeError extends Error {
  constructor(public rows: number, public limit: number, public format: ExportFormat) {
    super(`This report has ${rows.toLocaleString('en-PK')} rows; ${format.toUpperCase()} exports are limited to ${limit.toLocaleString('en-PK')} rows. `
      + `Narrow the filters${format === 'pdf' || format === 'html' ? ', or export to Excel or CSV' : ''}.`);
    this.name = 'ReportTooLargeError';
  }
}

/** The part of a request context the engine needs. */
export interface RunContext {
  client: PoolClient;
  has(resource: string, action: string): boolean;
  can(resource: string, action: string, rec?: { province?: string | null; project?: string | null }): boolean;
  provinces: string[];
}
export interface RunOpts {
  /** Screen: one page. Export: everything, up to maxRows. */
  paged: boolean;
  maxRows?: number;
  format?: ExportFormat;
  title?: string;
}

const MAX_AGG_ROWS = 50_000;
const OP_TEXT: Record<string, string> = {
  eq: '=', neq: '≠', in: 'is one of', contains: 'contains', starts: 'starts with', gte: '≥', lte: '≤', between: 'between',
  is_null: 'is empty', not_null: 'is not empty',
};
type Row = Record<string, any>;

/** Provinces where the caller may see CNICs in full. */
export function piiScope(rc: Pick<RunContext, 'can'>, provinces: string[]): PiiScope {
  const ok = provinces.filter((p) => rc.can('pii', 'read', { province: p }));
  return ok.length === provinces.length && ok.length > 0 ? 'all' : ok.length === 0 ? 'none' : ok;
}

/** Resolve unit names to canonical codes with a factor in force; refuse unknown ones naming the setting. */
async function resolveUnits(client: PoolClient, cfg: ValidConfig): Promise<{ common?: string; filters: Record<number, string> }> {
  const asked = new Map<string, string>();   // input -> where
  if (cfg.uom.mode === 'common' && cfg.uom.unit) asked.set(cfg.uom.unit, 'uom.unit');
  cfg.filters.forEach((f) => { if (f.unit && !asked.has(f.unit)) asked.set(f.unit, `filters.${f.field}.unit`); });
  if (!asked.size) return { filters: {} };
  const r = await client.query(
    `SELECT u AS input, lms.uom_code(u) AS code,
            EXISTS (SELECT 1 FROM lms.unit_conversion c WHERE c.unit_code = lms.uom_code(u) AND c.valid_range @> CURRENT_DATE) AS ok
     FROM unnest($1::text[]) u`, [[...asked.keys()]]);
  const code = new Map<string, string>();
  for (const x of r.rows) {
    if (!x.ok) throw new ReportConfigError(asked.get(x.input)!, `"${x.input}" is not a unit with a conversion factor`);
    code.set(x.input, x.code);
  }
  const filters: Record<number, string> = {};
  cfg.filters.forEach((f, i) => { if (f.unit) filters[i] = code.get(f.unit)!; });
  return { common: cfg.uom.unit ? code.get(cfg.uom.unit) : undefined, filters };
}

function filterText(def: DatasetDef, f: FilterSpec, pii: PiiScope): string {
  const fd = field(def, f.field)!;
  const one = (v: unknown) => (typeof v === 'boolean' ? (v ? 'Yes' : 'No') : fd.sensitive && pii !== 'all' ? '(withheld)' : String(v));
  const val = f.op === 'is_null' || f.op === 'not_null' ? ''
    : Array.isArray(f.value) ? (f.op === 'between' ? (f.value as unknown[]).map(one).join(' and ') : (f.value as unknown[]).map(one).join(', '))
      : one(f.value);
  return `${fd.label} ${OP_TEXT[f.op]}${val ? ` ${val}` : ''}${fd.unitAware && f.unit ? ` ${f.unit}` : ''}`;
}

export async function runReport(rc: RunContext, def: DatasetDef, cfg: ValidConfig, ro: RunOpts): Promise<ReportResult> {
  const { client } = rc;
  await client.query(`SET LOCAL statement_timeout = '20s'`);
  const provRows: { code: string; name: string }[] = (await client.query('SELECT code::text AS code, name FROM lms.province ORDER BY display_order')).rows;
  const pii = piiScope(rc, provRows.map((p) => p.code));
  const units = await resolveUnits(client, cfg);
  const c = compile(def, cfg, { pii, unit: units.common, filterUnits: units.filters });

  const agg: Row[] = (await client.query(c.aggregate())).rows;
  if (agg.length > MAX_AGG_ROWS) throw new ReportConfigError('groupBy', 'This grouping produces too many groups; choose a coarser grouping or add filters.');
  const n = c.groups.length;
  const usesUnits = agg.length > 0 && '__gu' in agg[0];
  const levelOf = (r: Row) => { let k = 0; while (k < n && r[`__g${k}`] === 0) k++; return k; };
  const keyOf = (level: number, vals: unknown[]) => `${level}|${JSON.stringify(vals.slice(0, level))}`;
  const sub = new Map<string, Row>();
  const subByUnit = new Map<string, Row[]>();
  let grand: Row | undefined;
  const unitRows: Row[] = [];
  for (const r of agg) {
    const k = levelOf(r);
    const perUnit = usesUnits && r.__gu === 0;
    if (k === 0) { if (perUnit) unitRows.push(r); else grand = r; continue; }
    const key = keyOf(k, c.groups.map((_, i) => r[`__gv${i}`]));
    if (perUnit) subByUnit.set(key, [...(subByUnit.get(key) ?? []), r]); else sub.set(key, r);
  }
  const recordCount: number = grand?.__count ?? 0;

  const aggCells = (r: Row, level: number): RowOut['cells'] => {
    const cells: RowOut['cells'] = {};
    for (const col of c.columns) {
      const gi = c.groups.indexOf(col.key);
      cells[col.key] = gi >= 0 ? (gi < level ? r[`__gv${gi}`] : null) : col.key in c.aggregates ? r[col.key] ?? null : null;
    }
    cells._rows = r.__count;
    return cells;
  };
  const aggRow = (r: Row, kind: 'subtotal' | 'total', level: number): RowOut[] => {
    const mixed = usesUnits && r.__units > 1;
    const out: RowOut[] = [{ kind, ...(kind === 'subtotal' ? { level: level - 1 } : {}), cells: aggCells(r, level),
      unit: usesUnits ? (mixed ? null : r.__unit_any ?? null) : undefined, ...(mixed ? { flags: ['mixed_units'] } : {}) }];
    if (mixed && kind === 'subtotal') {
      const key = keyOf(level, c.groups.map((_, i) => r[`__gv${i}`]));
      for (const u of subByUnit.get(key) ?? []) out.push({ kind: 'subtotal', level: level - 1, cells: aggCells(u, level), unit: u.__unit });
    }
    return out;
  };

  const rows: RowOut[] = [];
  let total = recordCount;
  const page = cfg.page;
  const href = (key: unknown) => (def.drillDown && key != null ? def.drillDown.href.replace('{key}', encodeURIComponent(String(key))) : null);
  const showTotals = cfg.totals || cfg.summaryOnly;

  if (cfg.summaryOnly) {
    // One row per group (aggregates only), in group order; per-unit rows only where a group mixes units.
    const summary: RowOut[] = [];
    for (const r of agg) {
      const k = levelOf(r);
      if (k === 0 || (usesUnits && r.__gu === 0)) continue;
      summary.push(...aggRow(r, 'subtotal', k));
    }
    total = summary.length;
    if (ro.maxRows !== undefined && total > ro.maxRows) throw new ReportTooLargeError(total, ro.maxRows, ro.format ?? 'csv');
    const slice = ro.paged ? summary.slice(page.offset, page.offset + page.limit) : summary;
    rows.push(...slice);
    if (grand && (!ro.paged || page.offset + page.limit >= total)) rows.push(...aggRow(grand, 'total', 0));
  } else {
    if (ro.maxRows !== undefined && recordCount > ro.maxRows) throw new ReportTooLargeError(recordCount, ro.maxRows, ro.format ?? 'csv');
    const res: Row[] = (await client.query(c.detail(ro.paged ? page.limit + 1 : null, ro.paged ? page.offset : 0))).rows;
    const pageRows = ro.paged ? res.slice(0, page.limit) : res;
    const peek = ro.paged ? res[page.limit] : undefined;
    const lastPage = !ro.paged || page.offset + pageRows.length >= recordCount;
    const gvals = (r: Row) => c.groups.map((g) => r[g] ?? null);
    pageRows.forEach((r, i) => {
      const cells: RowOut['cells'] = {};
      for (const col of c.columns) cells[col.key] = r[col.key] ?? null;
      rows.push({ kind: 'detail', cells, ...(usesUnits ? { unit: r.__unit ?? null } : {}), ...(r.__flags?.length ? { flags: r.__flags } : {}), href: href(r.__key) });
      if (!showTotals || n === 0) return;
      const next = i + 1 < pageRows.length ? pageRows[i + 1] : peek;
      if (!next && !lastPage) return;
      const a = gvals(r), b = next ? gvals(next) : null;
      // The outermost level whose key changes; close that group and every group inside it.
      let from = n;
      if (!b) from = 0; else for (let l = 0; l < n; l++) if (JSON.stringify(a[l]) !== JSON.stringify(b[l])) { from = l; break; }
      for (let l = n - 1; l >= from; l--) {
        const s = sub.get(keyOf(l + 1, a));
        if (s) rows.push(...aggRow(s, 'subtotal', l + 1));
      }
    });
    if (showTotals && grand && lastPage) rows.push(...aggRow(grand, 'total', 0));
  }

  const flags: Record<string, number> = {};
  for (const k of c.flagKeys) { const v = grand?.[`__f_${k}`] ?? 0; if (v > 0) flags[k] = v; }
  const flagText: Record<string, string> = {};
  for (const k of Object.keys(flags)) flagText[k] = FLAG_TEXT[k] ?? k;
  if (rows.some((r) => r.flags?.includes('mixed_units'))) flagText.mixed_units = FLAG_TEXT.mixed_units;

  // Which provinces the result covers.
  const pf = cfg.filters.find((f) => f.field === def.provinceColumn && (f.op === 'eq' || f.op === 'in'));
  const covered = pf ? (Array.isArray(pf.value) ? pf.value as string[] : [pf.value as string]) : rc.provinces.length ? rc.provinces : provRows.map((p) => p.code);
  const scope = def.provinceColumn
    ? `${covered.length > 1 ? 'Consolidated: ' : ''}${provRows.filter((p) => covered.includes(p.code)).map((p) => `${p.name} (${p.code})`).join(', ') || 'none'}`
    : 'All';
  const provinceUnits = c.unitAware && cfg.uom.mode === 'province'
    ? (await client.query(`SELECT province_code::text AS province, land_class AS "landClass", unit_code AS unit, approved
                           FROM lms.report_unit_default WHERE province_code::text = ANY($1::text[]) ORDER BY province_code, land_class NULLS FIRST`, [covered])).rows
    : undefined;

  const uomText = cfg.uom.mode === 'common' ? `All areas converted to ${units.common}`
    : cfg.uom.mode === 'original' ? 'Areas as recorded (acres where the recorded unit was not kept)'
      : 'Each province in its reporting unit';
  return {
    columns: c.columns,
    rows,
    page: { limit: ro.paged ? page.limit : total, offset: ro.paged ? page.offset : 0, total },
    flags,
    ...(c.unitAware && showTotals && unitRows.length ? {
      unitTotals: unitRows.map((u) => {
        const cells: RowOut['cells'] = {};
        for (const k of Object.keys(c.aggregates)) cells[k] = u[k] ?? null;
        return { unit: u.__unit, rows: u.__count, cells };
      }),
    } : {}),
    meta: {
      dataset: def.key, title: ro.title || def.label, grain: def.grain,
      uom: { mode: cfg.uom.mode, ...(units.common ? { unit: units.common } : {}), ...(provinceUnits ? { provinceUnits } : {}) },
      filtersApplied: cfg.filters.map((f) => filterText(def, f, pii)),
      scope, generatedAt: new Date().toISOString(),
      piiMasked: pii !== 'all' && c.columns.some((x) => x.sensitive),
      definitions: [...(def.definitions ?? []), ...(c.unitAware ? [`Unit mode: ${uomText}.`] : [])],
      flagText,
      mixedUnits: !!grand && usesUnits && grand.__units > 1 && c.unitAware,
    },
  };
}

export type { Compiled };
