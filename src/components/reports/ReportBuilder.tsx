'use client';

// The report builder. Everything it offers — datasets, columns, operators,
// grouping, sorting, aggregates and units — comes from GET /api/reports/catalog;
// the server validates the result again (src/lib/reporting/validate.ts).

import React from 'react';
import type { Aggregate, CatalogResult, DatasetInfo, FieldInfo, ReportConfig, SortSpec, UomMode } from '@/lib/reporting/types';
import FilterEditor, { newFilterId, type DraftFilter } from './FilterEditor';
import { AGG_LABEL, valueComplete } from './format';

export type Draft = Omit<ReportConfig, 'filters'> & { filters: DraftFilter[] };

export const MAX_GROUPS = 3;
export const MAX_SORTS = 5;

/** A draft from a config (quick report, template or blank). */
export function draftOf(c: ReportConfig): Draft {
  return {
    ...c,
    columns: [...c.columns], groupBy: [...(c.groupBy ?? [])], sort: [...(c.sort ?? [])],
    filters: (c.filters ?? []).map((f) => ({ ...f, id: newFilterId() })),
    uom: { ...(c.uom ?? { mode: 'province' }) },
    totals: c.totals !== false,
    ...(c.aggregates ? { aggregates: { ...c.aggregates } } : {}),
  };
}

export function blankDraft(d: DatasetInfo): Draft {
  return draftOf({ dataset: d.key, columns: [...d.defaultColumns], filters: [], groupBy: [], sort: [...d.defaultSort], totals: true, uom: { mode: 'province' } });
}

/** The config to run, or the list of reasons it cannot run yet. Incomplete filters are never dropped silently. */
export function configOf(d: Draft, ds: DatasetInfo | undefined): { config: ReportConfig | null; problems: string[] } {
  const problems: string[] = [];
  if (!ds) return { config: null, problems: ['Choose a dataset.'] };
  if (d.columns.length === 0) problems.push('Choose at least one column.');
  d.filters.forEach((f, i) => {
    if (!valueComplete(f.op, f.value)) problems.push(`Filter ${i + 1} (${ds.fields.find((x) => x.key === f.field)?.label ?? f.field}) needs a value.`);
  });
  if (d.uom.mode === 'common' && !d.uom.unit) problems.push('Choose the unit to convert to.');
  if (d.summaryOnly && d.groupBy.length === 0) problems.push('A summary needs at least one group.');
  if (problems.length) return { config: null, problems };
  const shown = new Set(d.columns);
  const aggregates = Object.fromEntries(Object.entries(d.aggregates ?? {}).filter(([k]) => shown.has(k)));
  const config: ReportConfig = {
    dataset: d.dataset, columns: d.columns, groupBy: d.groupBy, sort: d.sort, totals: d.totals,
    ...(d.summaryOnly ? { summaryOnly: true } : {}),
    filters: d.filters.map(({ id: _id, ...f }) => f),
    uom: d.uom.mode === 'common' ? { mode: 'common', unit: d.uom.unit } : { mode: d.uom.mode },
    ...(Object.keys(aggregates).length ? { aggregates } : {}),
    ...(d.page ? { page: d.page } : {}),
  };
  return { config, problems };
}

const byCategory = (ds: DatasetInfo[]) => {
  const m = new Map<string, DatasetInfo[]>();
  for (const d of ds) m.set(d.category, [...(m.get(d.category) ?? []), d]);
  return [...m.entries()];
};

function ColumnList({ ds, draft, set }: { ds: DatasetInfo; draft: Draft; set: (p: Partial<Draft>) => void }) {
  const fieldOf = (k: string) => ds.fields.find((f) => f.key === k);
  const move = (i: number, by: number) => {
    const cols = [...draft.columns]; const j = i + by;
    if (j < 0 || j >= cols.length) return;
    [cols[i], cols[j]] = [cols[j], cols[i]];
    set({ columns: cols });
  };
  const remove = (k: string) => set({ columns: draft.columns.filter((c) => c !== k), groupBy: draft.groupBy.filter((g) => g !== k) });
  const setAgg = (k: string, a: string) => {
    const next = { ...(draft.aggregates ?? {}) };
    if (a) next[k] = a as Aggregate; else delete next[k];
    set({ aggregates: next });
  };
  const unused = ds.fields.filter((f) => !draft.columns.includes(f.key));
  return (
    <fieldset className="u-mb-10" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="sec-t">Columns ({draft.columns.length})</legend>
      <ol className="u-list" style={{ listStyle: 'none', padding: 0, margin: '0 0 6px' }} aria-label="Columns in display order">
        {draft.columns.map((k, i) => {
          const f = fieldOf(k);
          if (!f) return null;
          const grouped = draft.groupBy.includes(k);
          return (
            <li key={k} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '3px 0', borderBottom: '1px solid var(--border)' }}>
              <span className="u-flex-1" style={{ minWidth: 140 }}>
                {i + 1}. {f.label}{f.sensitive && <span className="b b-w" title="Personal data: masked unless you may see it"> personal</span>}
                {grouped && <span className="note"> · grouped (shown first)</span>}
              </span>
              {draft.totals && f.aggregates.length > 0 && (
                <select className="sel" aria-label={`${f.label}: total as`} value={draft.aggregates?.[k] ?? ''} onChange={(e) => setAgg(k, e.target.value)}>
                  <option value="">Total: {AGG_LABEL[f.aggregates[0]].toLowerCase()} (default)</option>
                  {f.aggregates.map((a) => <option key={a} value={a}>Total: {AGG_LABEL[a].toLowerCase()}</option>)}
                </select>
              )}
              <button type="button" className="btn btn-s btn-sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${f.label} up`}>↑</button>
              <button type="button" className="btn btn-s btn-sm" disabled={i === draft.columns.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${f.label} down`}>↓</button>
              <button type="button" className="btn btn-s btn-sm" disabled={draft.columns.length === 1} onClick={() => remove(k)} aria-label={`Remove column ${f.label}`}>Remove</button>
            </li>
          );
        })}
      </ol>
      {unused.length > 0 && (
        <select className="sel" aria-label="Add a column" value="" onChange={(e) => e.target.value && set({ columns: [...draft.columns, e.target.value] })}>
          <option value="">+ Add a column…</option>
          {unused.map((f) => <option key={f.key} value={f.key} title={f.description}>{f.label}</option>)}
        </select>
      )}
    </fieldset>
  );
}

function Grouping({ ds, draft, set }: { ds: DatasetInfo; draft: Draft; set: (p: Partial<Draft>) => void }) {
  const groupable = ds.fields.filter((f) => f.groupable && !f.sensitive);
  const setLevel = (i: number, key: string) => {
    const g = draft.groupBy.slice(0, i);
    if (key) g.push(key, ...draft.groupBy.slice(i + 1).filter((x) => x !== key));
    const groupBy = [...new Set(g)].slice(0, MAX_GROUPS);
    // A grouped field is always shown (the server puts it first); add it to the columns if missing.
    const columns = [...draft.columns]; for (const k of groupBy) if (!columns.includes(k)) columns.push(k);
    set({ groupBy, columns, ...(groupBy.length === 0 ? { summaryOnly: false } : {}) });
  };
  if (groupable.length === 0) return null;
  return (
    <fieldset className="u-mb-10" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="sec-t">Group by (up to {MAX_GROUPS} levels)</legend>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {Array.from({ length: MAX_GROUPS }, (_, i) => (
          <select key={i} className="sel" aria-label={`Group level ${i + 1}`} value={draft.groupBy[i] ?? ''}
            disabled={i > draft.groupBy.length} onChange={(e) => setLevel(i, e.target.value)}>
            <option value="">{i === 0 ? 'No grouping' : `— Level ${i + 1} —`}</option>
            {groupable.filter((f) => f.key === draft.groupBy[i] || !draft.groupBy.includes(f.key)).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        ))}
      </div>
      <div className="checks u-mt-8">
        <label><input type="checkbox" checked={draft.totals} onChange={(e) => set({ totals: e.target.checked })} /> Subtotals and grand total</label>
        <label title={draft.groupBy.length ? undefined : 'Choose a group first'}>
          <input type="checkbox" checked={!!draft.summaryOnly} disabled={draft.groupBy.length === 0}
            onChange={(e) => set({ summaryOnly: e.target.checked })} /> Summary only (one row per group)
        </label>
      </div>
    </fieldset>
  );
}

function Sorting({ ds, draft, set }: { ds: DatasetInfo; draft: Draft; set: (p: Partial<Draft>) => void }) {
  const sortable = ds.fields.filter((f) => f.sortable && !f.sensitive);
  const update = (i: number, s: SortSpec) => set({ sort: draft.sort.map((x, j) => (j === i ? s : x)) });
  const label = (k: string) => ds.fields.find((f) => f.key === k)?.label ?? k;
  return (
    <fieldset className="u-mb-10" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="sec-t">Sort</legend>
      {draft.sort.map((s, i) => (
        <div key={`${s.field}-${i}`} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }} role="group" aria-label={`Sort ${i + 1}: ${label(s.field)}`}>
          <select className="sel" aria-label={`Sort ${i + 1} field`} value={s.field} onChange={(e) => update(i, { ...s, field: e.target.value })}>
            {sortable.filter((f) => f.key === s.field || !draft.sort.some((x) => x.field === f.key)).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
          <select className="sel" aria-label={`Sort ${i + 1} direction`} value={s.dir} onChange={(e) => update(i, { ...s, dir: e.target.value as 'asc' | 'desc' })}>
            <option value="asc">Ascending</option><option value="desc">Descending</option>
          </select>
          <button type="button" className="btn btn-s btn-sm" onClick={() => set({ sort: draft.sort.filter((_, j) => j !== i) })} aria-label={`Remove sort by ${label(s.field)}`}>Remove</button>
        </div>
      ))}
      {draft.sort.length < MAX_SORTS && (
        <select className="sel" aria-label="Add a sort" value="" onChange={(e) => e.target.value && set({ sort: [...draft.sort, { field: e.target.value, dir: 'asc' }] })}>
          <option value="">+ Sort by…</option>
          {sortable.filter((f) => !draft.sort.some((x) => x.field === f.key)).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
      )}
    </fieldset>
  );
}

export function UnitMode({ catalog, ds, draft, set }: { catalog: CatalogResult; ds: DatasetInfo; draft: Draft; set: (p: Partial<Draft>) => void }) {
  if (!ds.fields.some((f: FieldInfo) => f.unitAware)) return null;
  const mode = draft.uom.mode;
  const setMode = (m: UomMode) => set({ uom: m === 'common' ? { mode: m, unit: draft.uom.unit ?? catalog.units.find((u) => u.code === 'Acre')?.code ?? catalog.units[0]?.code } : { mode: m } });
  const unapproved = catalog.provinceUnits.filter((p) => !p.approved);
  const chosen = catalog.units.find((u) => u.code === draft.uom.unit);
  return (
    <fieldset className="u-mb-10" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="sec-t">Unit of measure for land</legend>
      <div className="checks" role="radiogroup" aria-label="Unit mode">
        <label><input type="radio" name="rpt-uom" value="province" checked={mode === 'province'} onChange={() => setMode('province')} /> Each province in its reporting unit</label>
        <label><input type="radio" name="rpt-uom" value="common" checked={mode === 'common'} onChange={() => setMode('common')} /> Convert everything to one unit</label>
        <label><input type="radio" name="rpt-uom" value="original" checked={mode === 'original'} onChange={() => setMode('original')} /> As originally recorded</label>
      </div>
      {mode === 'common' && (
        <div className="u-mt-8">
          <label htmlFor="rpt-unit" className="note">Convert to </label>
          <select id="rpt-unit" className="sel" value={draft.uom.unit ?? ''} onChange={(e) => set({ uom: { mode: 'common', unit: e.target.value } })}>
            {catalog.units.map((u) => <option key={u.code} value={u.code}>{u.name}{u.confirmed ? '' : ' (provisional factor)'}</option>)}
          </select>
          {chosen && !chosen.confirmed && (
            <div className="al w u-mt-8"><span className="i" /><div className="tx">The {chosen.name} conversion factor is provisional, awaiting Land Department confirmation. Converted figures are flagged.</div></div>
          )}
        </div>
      )}
      {mode === 'province' && catalog.provinceUnits.length > 0 && (
        <div className="u-mt-8">
          <ul className="u-list" style={{ margin: 0, paddingLeft: 18 }} aria-label="Province reporting units">
            {catalog.provinceUnits.map((p) => (
              <li key={`${p.province}-${p.landClass ?? ''}`}>
                {p.province}{p.landClass ? ` (${p.landClass})` : ''}: <b>{p.unit}</b>
                {!p.approved && <span className="b b-w" title="A proposed default awaiting Land Department approval"> proposed</span>}
              </li>
            ))}
          </ul>
          {unapproved.length > 0 && (
            <div className="al w u-mt-8"><span className="i" /><div className="tx">
              {unapproved.length === catalog.provinceUnits.length ? 'These province reporting units are' : `${unapproved.length} of these province reporting units are`} proposed
              defaults, not yet approved by the Land Department. Rows shown in a proposed unit are flagged.
            </div></div>
          )}
        </div>
      )}
      {mode === 'original' && <p className="note u-mt-8">Areas are shown in the unit the surveyor recorded; where that unit was not kept, in acres, and flagged.</p>}
    </fieldset>
  );
}

export default function ReportBuilder({ catalog, draft, onChange, canPick }: {
  catalog: CatalogResult; draft: Draft; onChange: (d: Draft) => void; canPick: (resource: string) => boolean;
}) {
  const ds = catalog.datasets.find((d) => d.key === draft.dataset);
  const set = (p: Partial<Draft>) => onChange({ ...draft, ...p, page: draft.page ? { ...draft.page, offset: 0 } : undefined });
  const chooseDataset = (key: string) => {
    const next = catalog.datasets.find((d) => d.key === key);
    if (next) onChange(blankDraft(next));
  };
  return (
    <div>
      <div className="fg">
        <label htmlFor="rpt-ds">Dataset</label>
        <select id="rpt-ds" className="sel" value={draft.dataset} onChange={(e) => chooseDataset(e.target.value)}>
          {!ds && <option value="">— Choose a dataset —</option>}
          {byCategory(catalog.datasets).map(([cat, list]) => (
            <optgroup key={cat} label={cat}>
              {list.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </optgroup>
          ))}
        </select>
        {ds && <small>{ds.description} One row per {ds.grain.replace(/^one row per /, '')}.</small>}
      </div>
      {ds && (
        <div className="grid2">
          <div>
            <ColumnList ds={ds} draft={draft} set={set} />
            <Sorting ds={ds} draft={draft} set={set} />
          </div>
          <div>
            <FilterEditor dataset={ds} filters={draft.filters} onChange={(filters) => set({ filters })}
              units={catalog.units} commonUnit={draft.uom.mode === 'common' ? draft.uom.unit : undefined} canPick={canPick} />
            <Grouping ds={ds} draft={draft} set={set} />
            <UnitMode catalog={catalog} ds={ds} draft={draft} set={set} />
          </div>
        </div>
      )}
    </div>
  );
}
