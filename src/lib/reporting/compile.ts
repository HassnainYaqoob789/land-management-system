// Compiles a validated configuration into parameterised SQL. User input
// reaches the database only as bind parameters; identifiers (view, columns)
// come only from the catalogue entry. Two statements per report:
//   detail    — the page of records, ordered by group keys then sort keys;
//   aggregate — GROUPING SETS over the whole filtered set: subtotals per group
//               level (and per unit within a group that mixes units), the
//               grand total, totals per unit, the record count and the count
//               of every data-quality flag.
// Units are handled in SQL with exact numeric factors from lms.unit_conversion
// (lms.report_unit_default for the province mode). Areas are summed only
// within one unit: a group or grand total whose rows are in different units
// has no area total (its per-unit rows carry them).
import { field, type DatasetDef, type FieldDef } from './catalog';
import type { Aggregate, ColumnOut } from './types';
import type { ValidConfig } from './validate';

export type PiiScope = 'all' | 'none' | string[];
export interface CompileOpts {
  /** Where CNICs may be shown in full: everywhere, nowhere, or in these provinces. */
  pii: PiiScope;
  /** Canonical unit code for the common mode (resolved against lms.unit_conversion first). */
  unit?: string;
  /** Canonical unit code for each area filter, by filter index. */
  filterUnits?: Record<number, string>;
}
export interface Sql { text: string; values: unknown[] }
export interface Compiled {
  detail(limit: number | null, offset: number): Sql;
  aggregate(): Sql;
  columns: ColumnOut[];
  groups: string[];
  /** Area columns are shown, so rows carry a unit. */
  unitAware: boolean;
  flagKeys: string[];
  aggregates: Record<string, Aggregate>;
}

const q = (id: string) => `"${id}"`;
const CNIC_MASK = (x: string) =>
  `CASE WHEN ${x} IS NULL THEN NULL WHEN ${x} ~ '^[0-9]{5}-[0-9]{7}-[0-9]$' THEN '•••••-••••' || substr(${x}, 11, 3) || '-' || right(${x}, 1) ` +
  `ELSE regexp_replace(left(${x}, greatest(length(${x}) - 4, 0)), '[A-Za-z0-9]', '•', 'g') || right(${x}, 4) END`;
const ESC = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

class Params {
  values: unknown[] = [];
  add(v: unknown): string { this.values.push(v); return `$${this.values.length}`; }
}

export function compile(def: DatasetDef, cfg: ValidConfig, o: CompileOpts): Compiled {
  const fd = (k: string) => field(def, k)!;
  const cols = cfg.columns.map(fd);
  const groups = cfg.groupBy;
  const mode = cfg.uom.mode;
  const unitCols = cols.filter((c) => c.unitAware);
  const unitAware = unitCols.length > 0;
  const ruc = def.recordedUnitColumn;
  const allRecorded = unitCols.every((c) => !!c.recordedColumn);
  const usesUnits = unitAware && (mode === 'common' || !!def.provinceColumn || mode === 'original');

  // A column's value in the base CTE "b".
  const colRef = (f: FieldDef) => (f.tz ? `(b.${q(f.column)} AT TIME ZONE 'Asia/Karachi')::date` : `b.${q(f.column)}`);
  const vRef = (f: FieldDef) => (f.tz ? `(v.${q(f.column)} AT TIME ZONE 'Asia/Karachi')::date` : `v.${q(f.column)}`);

  // What one output cell is, for detail rows and for group keys.
  const outExpr = (f: FieldDef, pii: (x: string) => string): string => {
    if (f.unitAware) return `round(b.${q(`__u_${f.key}`)}, 4)`;
    const r = colRef(f);
    switch (f.type) {
      case 'cnic': return pii(`(${r})::text`);
      case 'date': return `to_char(${r}, 'YYYY-MM-DD')`;
      case 'integer': return `(${r})::int`;
      case 'money': return `(${r})::numeric(18,2)`;
      case 'boolean': return `(${r})::boolean`;
      case 'number': case 'percent': return `(${r})::numeric`;
      default: return `(${r})::text`;
    }
  };

  const base = (p: Params): string => {
    const select: string[] = ['v.*'];
    const joins: string[] = ['CROSS JOIN ua'];
    if (usesUnits) {
      let unitExpr = `'Acre'::text`;
      let approved = 'true';
      if (mode === 'common') unitExpr = `${p.add(o.unit ?? 'Acre')}::text`;
      else if (mode === 'province' && def.provinceColumn) {
        joins.push(`LEFT JOIN lms.report_unit_default rp ON rp.province_code = v.${q(def.provinceColumn)} AND rp.land_class IS NULL`);
        if (def.landClassColumn) {
          joins.push(`LEFT JOIN lms.report_unit_default rl ON rl.province_code = v.${q(def.provinceColumn)} AND rl.land_class = v.${q(def.landClassColumn)}`);
          unitExpr = `coalesce(rl.unit_code, rp.unit_code, 'Acre')`;
          approved = `CASE WHEN rl.unit_code IS NOT NULL THEN rl.approved WHEN rp.unit_code IS NOT NULL THEN rp.approved ELSE true END`;
        } else {
          unitExpr = `coalesce(rp.unit_code, 'Acre')`;
          approved = `coalesce(rp.approved, true)`;
        }
      } else if (mode === 'original' && ruc) unitExpr = `coalesce(v.${q(ruc)}, 'Acre')`;
      joins.push(`LEFT JOIN lms.unit_conversion ru ON ru.unit_code = ${unitExpr} AND ru.valid_range @> CURRENT_DATE`);
      select.push(`${unitExpr} AS __unit`, 'ru.sqm_per_unit AS __unit_sqm', 'ru.is_confirmed AS __unit_confirmed', `${approved} AS __unit_approved`);
      for (const c of unitCols) {
        const conv = `v.${q(c.column)} * ua.acre_sqm / ru.sqm_per_unit`;
        const e = mode === 'original' && c.recordedColumn && ruc
          ? `CASE WHEN v.${q(ruc)} IS NOT NULL AND v.${q(c.recordedColumn)} IS NOT NULL THEN v.${q(c.recordedColumn)} ELSE ${conv} END`
          : conv;
        select.push(`${e} AS ${q(`__u_${c.key}`)}`);
      }
    } else {
      for (const c of unitCols) select.push(`v.${q(c.column)} AS ${q(`__u_${c.key}`)}`);
    }

    const where: string[] = [];
    cfg.filters.forEach((flt, i) => {
      const f = fd(flt.field);
      const lhs = ['text', 'code', 'enum', 'cnic'].includes(f.type) ? `(${vRef(f)})::text` : vRef(f);
      const cast = f.type === 'date' ? '::date' : f.type === 'boolean' ? '::boolean' : ['text', 'code', 'enum', 'cnic'].includes(f.type) ? '::text' : '::numeric';
      const fu = o.filterUnits?.[i];
      // An area value in another unit is compared in acres, exactly.
      const val = (x: unknown) => (f.unitAware && fu && fu !== 'Acre'
        ? `(${p.add(x)}::numeric * (SELECT c.sqm_per_unit FROM lms.unit_conversion c WHERE c.unit_code = ${p.add(fu)} AND c.valid_range @> CURRENT_DATE) / ua.acre_sqm)`
        : `${p.add(x)}${cast}`);
      switch (flt.op) {
        case 'is_null': where.push(`${vRef(f)} IS NULL`); break;
        case 'not_null': where.push(`${vRef(f)} IS NOT NULL`); break;
        case 'eq': where.push(`${lhs} = ${val(flt.value)}`); break;
        case 'neq': where.push(`${lhs} IS DISTINCT FROM ${val(flt.value)}`); break;
        case 'gte': where.push(`${lhs} >= ${val(flt.value)}`); break;
        case 'lte': where.push(`${lhs} <= ${val(flt.value)}`); break;
        case 'between': { const [a, b] = flt.value as unknown[]; where.push(`${lhs} BETWEEN ${val(a)} AND ${val(b)}`); break; }
        case 'in': where.push(`${lhs} = ANY(${p.add(flt.value)}${cast}[])`); break;
        case 'contains': where.push(`${lhs} ILIKE '%' || ${p.add(ESC(String(flt.value)))} || '%' ESCAPE '\\'`); break;
        case 'starts': where.push(`${lhs} ILIKE ${p.add(ESC(String(flt.value)))} || '%' ESCAPE '\\'`); break;
      }
    });
    return `ua AS (SELECT c.sqm_per_unit AS acre_sqm FROM lms.unit_conversion c WHERE c.unit_code = 'Acre' AND c.valid_range @> CURRENT_DATE),
b AS (SELECT ${select.join(', ')} FROM ${def.view} v ${joins.join(' ')}${where.length ? ` WHERE ${where.join(' AND ')}` : ''})`;
  };

  const piiFn = (p: Params) => (x: string): string => {
    if (o.pii === 'all') return x;
    if (o.pii === 'none' || o.pii.length === 0 || !def.provinceColumn) return CNIC_MASK(x);
    return `CASE WHEN (b.${q(def.provinceColumn)})::text = ANY(${p.add(o.pii)}::text[]) THEN ${x} ELSE ${CNIC_MASK(x)} END`;
  };

  // Data-quality flags: [key, condition over b].
  const flagConds: [string, string][] = [];
  if (unitAware && usesUnits) {
    flagConds.push(['unsupported_unit', 'b.__unit_sqm IS NULL']);
    flagConds.push(['provisional_factor', `b.__unit_confirmed IS FALSE AND b.__unit <> 'Acre'${mode === 'original' && allRecorded && ruc ? ` AND b.${q(ruc)} IS NULL` : ''}`]);
    if (mode === 'original') flagConds.push(['recorded_unit_unknown', ruc ? `b.${q(ruc)} IS NULL` : 'true']);
    if (mode === 'province') flagConds.push(['province_unit_unapproved', 'b.__unit_approved IS FALSE']);
  }
  if (unitAware && def.primaryArea && cfg.columns.includes(def.primaryArea)) flagConds.push(['missing_area', `b.${q(fd(def.primaryArea).column)} IS NULL`]);
  for (const [k, c] of Object.entries(def.flags ?? {})) {
    const at = flagConds.findIndex(([x]) => x === k);
    if (at >= 0) flagConds[at] = [k, `(${flagConds[at][1]}) OR b.${q(c)} IS TRUE`];
    else flagConds.push([k, `b.${q(c)} IS TRUE`]);
  }
  const flagArray = flagConds.length
    ? `array_remove(ARRAY[${flagConds.map(([k, c]) => `CASE WHEN ${c} THEN '${k}' END`).join(', ')}]::text[], NULL)`
    : `ARRAY[]::text[]`;

  // Order: group keys, then the sort, then the row key for a stable page.
  const dirOf = (k: string) => cfg.sort.find((s) => s.field === k)?.dir ?? 'asc';
  const sortRef = (f: FieldDef) => (f.unitAware ? `b.${q(f.column)}` : colRef(f));
  const orderBy = [
    ...groups.map((g) => `${sortRef(fd(g))} ${dirOf(g) === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`),
    ...cfg.sort.filter((s) => !groups.includes(s.field)).map((s) => `${sortRef(fd(s.field))} ${s.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`),
    ...def.rowKey.map((k) => `(b.${q(k)})::text ASC NULLS LAST`),
  ].join(', ');

  // Aggregates of the shown columns.
  const aggregates: Record<string, Aggregate> = {};
  for (const c of cols) {
    if (groups.includes(c.key) || !c.aggregates.length) continue;
    aggregates[c.key] = cfg.aggregates?.[c.key] ?? c.aggregates[0];
  }
  const aggExpr = (c: FieldDef, a: Aggregate): string => {
    if (c.unitAware) {
      const v = `round(${a}(b.${q(`__u_${c.key}`)}), 4)`;
      // Never add areas in different units: no total when the group mixes them.
      return usesUnits ? `CASE WHEN count(DISTINCT b.__unit) <= 1 THEN ${v} END` : v;
    }
    const r = colRef(c);
    if (c.type === 'money') return a === 'avg' ? `round(avg(${r}), 2)` : `(${a}(${r}))::numeric(18,2)`;
    if (c.type === 'integer') return a === 'avg' ? `round(avg(${r}), 2)` : `(${a}(${r}))::bigint::text`;
    return a === 'avg' ? `round(avg(${r}), 4)` : `${a}(${r})`;
  };

  const columns: ColumnOut[] = cols.map((c) => ({
    key: c.key, label: c.label, type: c.type,
    ...(c.unitAware && mode === 'common' && o.unit ? { unit: o.unit } : c.unitAware && !usesUnits ? { unit: 'Acre' } : {}),
    ...(aggregates[c.key] ? { aggregate: aggregates[c.key] } : {}),
    ...(c.sensitive ? { sensitive: true } : {}),
  }));

  return {
    columns, groups, unitAware, flagKeys: flagConds.map(([k]) => k), aggregates,
    detail(limit, offset) {
      const p = new Params();
      const b = base(p);
      const pii = piiFn(p);
      const outs = cols.map((c) => `${outExpr(c, pii)} AS ${q(c.key)}`);
      outs.push(`(b.${q(def.rowKey[0])})::text AS __key`, `${flagArray} AS __flags`);
      if (usesUnits) outs.push('b.__unit AS __unit');
      const lim = limit === null ? '' : ` LIMIT ${p.add(limit)} OFFSET ${p.add(offset)}`;
      return { text: `WITH ${b} SELECT ${outs.join(', ')} FROM b ORDER BY ${orderBy}${lim}`, values: p.values };
    },
    aggregate() {
      const p = new Params();
      const b = base(p);
      const gExpr = groups.map((g) => outExpr(fd(g), (x) => x));
      const sel: string[] = [];
      gExpr.forEach((e, i) => sel.push(`GROUPING(${e}) AS __g${i}`, `${e} AS __gv${i}`));
      if (usesUnits) sel.push('GROUPING(b.__unit) AS __gu', 'b.__unit AS __unit', 'count(DISTINCT b.__unit)::int AS __units', 'min(b.__unit) AS __unit_any');
      sel.push('count(*)::int AS __count');
      for (const [k, a] of Object.entries(aggregates)) sel.push(`${aggExpr(fd(k), a)} AS ${q(k)}`);
      flagConds.forEach(([k, c]) => sel.push(`count(*) FILTER (WHERE ${c})::int AS ${q(`__f_${k}`)}`));
      const sets: string[] = [];
      if (cfg.totals || cfg.summaryOnly) {
        for (let k = groups.length; k >= 1; k--) {
          const prefix = gExpr.slice(0, k).join(', ');
          sets.push(`(${prefix})`);
          if (usesUnits) sets.push(`(${prefix}, b.__unit)`);
        }
      }
      sets.push('()');
      if (usesUnits) sets.push('(b.__unit)');
      const order = [
        ...gExpr.map((e, i) => `GROUPING(${e}), ${e} ${dirOf(groups[i]) === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`),
        ...(usesUnits ? ['GROUPING(b.__unit) DESC', 'b.__unit'] : []),
      ];
      return {
        text: `WITH ${b} SELECT ${sel.join(', ')} FROM b GROUP BY GROUPING SETS (${sets.join(', ')})${order.length ? ` ORDER BY ${order.join(', ')}` : ''}`,
        values: p.values,
      };
    },
  };
}
