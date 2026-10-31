// Validates a report configuration against the catalogue. Anything not in
// the catalogue — a dataset, column, filter field, operator, group or sort
// key — is refused with a message naming it (HTTP 400). Nothing here reaches
// SQL except through compile.ts, which re-reads every identifier from the
// catalogue entry this returns.
import { dataset, field, SCREEN_MAX_PAGE, type DatasetDef, type FieldDef } from './catalog';
import { toDecimal } from './decimal';
import type { Aggregate, FilterOp, FilterSpec, ReportConfig, SortSpec, UomMode } from './types';

export class ReportConfigError extends Error {
  constructor(public field: string, message: string) { super(message); this.name = 'ReportConfigError'; }
}

export interface ValidConfig extends ReportConfig { page: { limit: number; offset: number } }
export interface ValidateOpts { /** Caller holds pii:read (partial CNIC search, sorting by CNIC). */ canSeePii: boolean }

const KEYS = ['dataset', 'columns', 'filters', 'groupBy', 'sort', 'totals', 'summaryOnly', 'uom', 'page', 'aggregates'];
const UNIT_RE = /^[A-Za-z][A-Za-z ²]{0,30}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CNIC_FULL = /^\d{5}-\d{7}-\d$/;
const CNIC_PART = /^[\d-]{1,15}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MODES: UomMode[] = ['province', 'common', 'original'];
const show = (v: unknown) => String(v).slice(0, 60);
const fail = (where: string, msg: string): never => { throw new ReportConfigError(where, msg); };

function validDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function scalar(fd: FieldDef, op: FilterOp, v: unknown, where: string): string | boolean {
  switch (fd.type) {
    case 'boolean':
      if (typeof v !== 'boolean') fail(where, `${fd.label} takes true or false`);
      return v as boolean;
    case 'integer': case 'number': case 'money': case 'area': case 'percent': {
      const d = toDecimal(v, fd.type === 'money' ? 2 : 6);
      if (d === null) fail(where, `${fd.label} needs a number${fd.type === 'money' ? ' (up to 2 decimal places)' : ''}, not "${show(v)}"`);
      return d as string;
    }
    case 'date':
      if (typeof v !== 'string' || !validDate(v)) fail(where, `${fd.label} needs a date as YYYY-MM-DD, not "${show(v)}"`);
      return v as string;
    case 'cnic':
      if (typeof v !== 'string') fail(where, `${fd.label} needs text`);
      if ((op === 'eq' || op === 'in') ? !CNIC_FULL.test(v as string) : !CNIC_PART.test(v as string))
        fail(where, op === 'eq' || op === 'in' ? 'A CNIC is written 12345-1234567-1' : 'A partial CNIC may contain only digits and dashes');
      return v as string;
    default:
      if (typeof v !== 'string' || v.trim() === '' || v.length > 200 || CONTROL.test(v)) fail(where, `${fd.label} needs text of 1 to 200 characters`);
      return (v as string).trim();
  }
}

function validFilter(def: DatasetDef, raw: unknown, i: number, o: ValidateOpts, uomUnit: string | undefined): FilterSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(`filters[${i}]`, 'a filter needs a field, an operator and a value');
  const f = raw as Record<string, unknown>;
  for (const k of Object.keys(f)) if (!['field', 'op', 'value', 'unit'].includes(k)) fail(`filters[${i}].${k}`, `unknown filter setting "${show(k)}"`);
  if (typeof f.field !== 'string') return fail(`filters[${i}].field`, 'a filter needs a field');
  const fd = field(def, f.field) ?? fail(`filters.${show(f.field)}`, `"${show(f.field)}" is not a field of ${def.label}`);
  const where = `filters.${fd.key}`;
  const op = f.op as FilterOp;
  if (typeof op !== 'string' || !fd.ops.includes(op)) fail(where, `${fd.label} cannot be filtered with "${show(op)}"`);
  if (fd.sensitive && !o.canSeePii && (op === 'contains' || op === 'starts'))
    fail(where, `Searching part of a ${fd.label} needs permission to see personal data; search with the full ${fd.label} instead`);
  let unit: string | undefined;
  if (f.unit !== undefined) {
    if (!fd.unitAware) fail(`${where}.unit`, `${fd.label} is not an area`);
    if (typeof f.unit !== 'string' || !UNIT_RE.test(f.unit)) fail(`${where}.unit`, `"${show(f.unit)}" is not a unit`);
    unit = f.unit as string;
  } else if (fd.unitAware) unit = uomUnit ?? 'Acre';

  const out: FilterSpec = { field: fd.key, op, ...(unit ? { unit } : {}) };
  if (op === 'is_null' || op === 'not_null') {
    if (f.value !== undefined && f.value !== null) fail(where, `"${op}" takes no value`);
    return out;
  }
  if (op === 'in') {
    if (!Array.isArray(f.value) || f.value.length === 0 || f.value.length > 100) fail(where, `${fd.label}: choose 1 to 100 values`);
    out.value = [...new Set((f.value as unknown[]).map((v) => scalar(fd, op, v, where)))];
    return out;
  }
  if (op === 'between') {
    if (!Array.isArray(f.value) || f.value.length !== 2) fail(where, `${fd.label}: "between" needs a lowest and a highest value`);
    out.value = (f.value as unknown[]).map((v) => scalar(fd, op, v, where));
    return out;
  }
  if (f.value === undefined || f.value === null || Array.isArray(f.value)) fail(where, `${fd.label}: a value is required`);
  out.value = scalar(fd, op, f.value, where);
  return out;
}

/** Validate and normalise a config. Throws ReportConfigError naming the bad setting. */
export function validateConfig(input: unknown, o: ValidateOpts): { def: DatasetDef; config: ValidConfig } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('config', 'config must be an object');
  const c = input as Record<string, unknown>;
  for (const k of Object.keys(c)) if (!KEYS.includes(k)) fail(k, `unknown report setting "${show(k)}"`);

  if (typeof c.dataset !== 'string') fail('dataset', 'choose a dataset');
  const def = dataset(c.dataset as string) ?? fail('dataset', `unknown dataset "${show(c.dataset)}"`);

  // uom first: area filters default to its unit.
  const u = (c.uom ?? { mode: 'province' }) as Record<string, unknown>;
  if (!u || typeof u !== 'object' || Array.isArray(u)) fail('uom', 'uom must be { mode, unit? }');
  for (const k of Object.keys(u)) if (!['mode', 'unit'].includes(k)) fail(`uom.${k}`, `unknown unit setting "${show(k)}"`);
  const mode = (u.mode ?? 'province') as UomMode;
  if (!MODES.includes(mode)) fail('uom.mode', `unit mode must be province, common or original, not "${show(u.mode)}"`);
  let unit: string | undefined;
  if (mode === 'common') {
    if (typeof u.unit !== 'string' || !UNIT_RE.test(u.unit)) fail('uom.unit', 'choose the unit to convert to');
    unit = (u.unit as string).trim();
  } else if (u.unit !== undefined && u.unit !== null && u.unit !== '') fail('uom.unit', `a unit applies only to the "common" mode`);

  const cols = c.columns === undefined ? def.defaultColumns : c.columns;
  if (!Array.isArray(cols) || cols.length === 0) fail('columns', 'choose at least one column');
  if ((cols as unknown[]).length > 40) fail('columns', 'choose at most 40 columns');
  const columns: string[] = [];
  for (const k of cols as unknown[]) {
    if (typeof k !== 'string' || !field(def, k)) fail('columns', `"${show(k)}" is not a column of ${def.label}`);
    if (!columns.includes(k as string)) columns.push(k as string);
  }

  const gb = c.groupBy ?? [];
  if (!Array.isArray(gb) || gb.length > 3) fail('groupBy', 'group by up to three fields');
  const groupBy: string[] = [];
  for (const k of gb as unknown[]) {
    const fd = typeof k === 'string' ? field(def, k) : undefined;
    if (!fd) fail('groupBy', `"${show(k)}" is not a field of ${def.label}`);
    if (!fd!.groupable || fd!.sensitive) fail(`groupBy.${fd!.key}`, `${fd!.label} cannot be used for grouping`);
    if (!groupBy.includes(fd!.key)) groupBy.push(fd!.key);
  }
  // A group's values label its subtotal, so its column is always shown, first.
  for (const g of [...groupBy].reverse()) { const at = columns.indexOf(g); if (at >= 0) columns.splice(at, 1); columns.unshift(g); }
  if (columns.length > 40) fail('columns', 'choose at most 40 columns');

  const fl = c.filters ?? [];
  if (!Array.isArray(fl) || fl.length > 30) fail('filters', 'use at most 30 filters');
  const filters = (fl as unknown[]).map((x, i) => validFilter(def, x, i, o, mode === 'common' ? unit : undefined));

  const so = c.sort ?? def.defaultSort;
  if (!Array.isArray(so) || so.length > 5) fail('sort', 'sort by at most five fields');
  const sort: SortSpec[] = [];
  for (const [i, s] of (so as unknown[]).entries()) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) fail(`sort[${i}]`, 'a sort needs a field and a direction');
    const sx = s as Record<string, unknown>;
    const fd = typeof sx.field === 'string' ? field(def, sx.field) : undefined;
    if (!fd) fail(`sort.${show(sx.field)}`, `"${show(sx.field)}" is not a field of ${def.label}`);
    if (!fd!.sortable || fd!.sensitive) fail(`sort.${fd!.key}`, `${fd!.label} cannot be used for sorting`);
    const dir = sx.dir ?? 'asc';
    if (dir !== 'asc' && dir !== 'desc') fail(`sort.${fd!.key}`, 'sort direction must be asc or desc');
    if (!sort.some((x) => x.field === fd!.key)) sort.push({ field: fd!.key, dir: dir as 'asc' | 'desc' });
  }

  if (c.totals !== undefined && typeof c.totals !== 'boolean') fail('totals', 'totals must be true or false');
  if (c.summaryOnly !== undefined && typeof c.summaryOnly !== 'boolean') fail('summaryOnly', 'summaryOnly must be true or false');
  const summaryOnly = c.summaryOnly === true;
  if (summaryOnly && groupBy.length === 0) fail('summaryOnly', 'a summary needs at least one group');

  const ag = c.aggregates ?? {};
  if (!ag || typeof ag !== 'object' || Array.isArray(ag)) fail('aggregates', 'aggregates must map a column to sum, avg, min or max');
  const aggregates: Record<string, Aggregate> = {};
  for (const [k, a] of Object.entries(ag as Record<string, unknown>)) {
    const fd = field(def, k);
    if (!fd || !columns.includes(k)) fail(`aggregates.${show(k)}`, `"${show(k)}" is not a shown column`);
    if (typeof a !== 'string' || !fd!.aggregates.includes(a as Aggregate)) fail(`aggregates.${k}`, `${fd!.label} cannot be totalled with "${show(a)}"`);
    aggregates[k] = a as Aggregate;
  }

  const pg = (c.page ?? {}) as Record<string, unknown>;
  if (typeof pg !== 'object' || Array.isArray(pg)) fail('page', 'page must be { limit, offset }');
  const limit = pg.limit === undefined ? 100 : pg.limit;
  const offset = pg.offset === undefined ? 0 : pg.offset;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > SCREEN_MAX_PAGE) fail('page.limit', `show 1 to ${SCREEN_MAX_PAGE} rows per page`);
  if (!Number.isInteger(offset) || (offset as number) < 0 || (offset as number) > 10_000_000) fail('page.offset', 'page offset is out of range');

  return {
    def,
    config: {
      dataset: def.key, columns, filters, groupBy, sort, totals: c.totals !== false, summaryOnly,
      uom: unit ? { mode, unit } : { mode }, aggregates, page: { limit: limit as number, offset: offset as number },
    },
  };
}
