'use client';

// One row per filter: field, operator (only those the catalogue allows for the
// field) and a value input that fits the field's type — a select for enums, a
// date input for dates, two inputs for "between", a unit for area values and
// a record picker for project codes.

import React from 'react';
import { RecordPicker } from '@/components/legacy/data';
import type { DatasetInfo, FieldInfo, FilterOp, FilterSpec } from '@/lib/reporting/types';
import { OP_LABEL, blankValue, isNumeric, opNeedsValue, valueComplete } from './format';

/** Fields whose values are record codes worth picking from the register (code → the register to search). */
const PICKERS: Record<string, { resource: string; rowsKey: string; idOf: (r: any) => string; label: (r: any) => string; noun: string }> = {
  project_code: { resource: '/api/projects', rowsKey: 'projects', idOf: (r) => r.project_code, label: (r) => `${r.project_code} — ${r.project_name ?? ''}`, noun: 'project' },
};

export type DraftFilter = FilterSpec & { id: string };

let nextId = 0;
export const newFilterId = () => `f${++nextId}`;

export function newFilter(field: FieldInfo): DraftFilter {
  const op = field.ops[0];
  return { id: newFilterId(), field: field.key, op, value: blankValue(field, op) };
}

function ScalarInput({ field, value, onChange, id, label, canPick }: {
  field: FieldInfo; value: unknown; onChange: (v: unknown) => void; id: string; label: string; canPick: (resource: string) => boolean;
}) {
  const v = value === undefined || value === null ? '' : String(value);
  if (field.type === 'enum' && field.options?.length) {
    return (
      <select id={id} className="sel" aria-label={label} value={v} onChange={(e) => onChange(e.target.value)}>
        <option value="">— Select —</option>
        {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  if (field.type === 'boolean') {
    return (
      <select id={id} className="sel" aria-label={label} value={value === false ? 'false' : 'true'} onChange={(e) => onChange(e.target.value === 'true')}>
        <option value="true">Yes</option><option value="false">No</option>
      </select>
    );
  }
  if (field.type === 'date') return <input id={id} type="date" aria-label={label} value={v} onChange={(e) => onChange(e.target.value)} />;
  if (isNumeric(field.type)) {
    // Text with a decimal keypad: the engine takes exact decimal strings, never floats.
    return <input id={id} type="text" inputMode="decimal" pattern="-?[0-9]+(\.[0-9]+)?" aria-label={label} value={v}
      placeholder={field.type === 'money' ? 'e.g. 250000' : 'e.g. 12.5'} onChange={(e) => onChange(e.target.value.trim())} />;
  }
  const picker = PICKERS[field.key];
  if (picker && canPick(picker.resource)) {
    return <RecordPicker id={id} resource={picker.resource} rowsKey={picker.rowsKey} label={label} value={v}
      idOf={picker.idOf} optionLabel={picker.label} current={v || undefined} onChange={(code) => onChange(code)} />;
  }
  return <input id={id} type="text" aria-label={label} value={v} maxLength={200}
    placeholder={field.type === 'cnic' ? '12345-1234567-1' : undefined} onChange={(e) => onChange(e.target.value)} />;
}

function ValueInput({ field, filter, onChange, canPick }: {
  field: FieldInfo; filter: DraftFilter; onChange: (f: DraftFilter) => void; canPick: (resource: string) => boolean;
}) {
  const id = `rf-${filter.id}`;
  const set = (value: unknown) => onChange({ ...filter, value });
  if (!opNeedsValue(filter.op)) return <span className="note">no value needed</span>;
  if (filter.op === 'between') {
    const [a, b] = Array.isArray(filter.value) ? filter.value as unknown[] : ['', ''];
    return (
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <ScalarInput field={field} value={a} onChange={(v) => set([v, b])} id={`${id}-a`} label={`${field.label} from`} canPick={canPick} />
        <span className="note">and</span>
        <ScalarInput field={field} value={b} onChange={(v) => set([a, v])} id={`${id}-b`} label={`${field.label} to`} canPick={canPick} />
      </span>
    );
  }
  if (filter.op === 'in') {
    const vals = Array.isArray(filter.value) ? (filter.value as unknown[]).map(String) : [];
    if (field.options?.length) {
      return (
        <select id={id} multiple aria-label={`${field.label}: choose one or more`} value={vals} size={Math.min(5, field.options.length)}
          onChange={(e) => set([...e.target.selectedOptions].map((o) => o.value))}>
          {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    }
    return <input id={id} type="text" aria-label={`${field.label}: values separated by commas`} placeholder="value, value, …"
      value={vals.join(', ')} onChange={(e) => set(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />;
  }
  return <ScalarInput field={field} value={filter.value} onChange={set} id={id} label={`${field.label} value`} canPick={canPick} />;
}

export default function FilterEditor({ dataset, filters, onChange, units, commonUnit, canPick }: {
  dataset: DatasetInfo; filters: DraftFilter[]; onChange: (f: DraftFilter[]) => void;
  units: { code: string; name: string }[]; commonUnit?: string;
  /** May the viewer search this register (e.g. projects:read for /api/projects)? Otherwise a plain input. */
  canPick: (resource: string) => boolean;
}) {
  const fieldOf = (k: string) => dataset.fields.find((f) => f.key === k);
  const filterable = dataset.fields.filter((f) => f.ops.length > 0);
  const update = (i: number, f: DraftFilter) => onChange(filters.map((x, j) => (j === i ? f : x)));
  const remove = (i: number) => onChange(filters.filter((_, j) => j !== i));

  return (
    <fieldset className="u-mb-10" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="sec-t">Filters</legend>
      {filters.length === 0 && <p className="note">No filters: the report covers every record in your scope.</p>}
      {filters.map((flt, i) => {
        const fd = fieldOf(flt.field);
        if (!fd) return null;
        const incomplete = !valueComplete(flt.op, flt.value);
        return (
          <div key={flt.id} className="bar" role="group" aria-label={`Filter ${i + 1}: ${fd.label}`}
            style={{ alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
            <select className="sel" aria-label={`Filter ${i + 1} field`} value={flt.field}
              onChange={(e) => { const nf = fieldOf(e.target.value); if (nf) update(i, { ...newFilter(nf), id: flt.id }); }}>
              {filterable.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
            <select className="sel" aria-label={`Filter ${i + 1} operator`} value={flt.op}
              onChange={(e) => { const op = e.target.value as FilterOp; update(i, { ...flt, op, value: blankValue(fd, op) }); }}>
              {fd.ops.map((op) => <option key={op} value={op}>{OP_LABEL[op]}</option>)}
            </select>
            <ValueInput field={fd} filter={flt} onChange={(f) => update(i, f)} canPick={canPick} />
            {fd.unitAware && opNeedsValue(flt.op) && (
              <select className="sel" aria-label={`Filter ${i + 1} unit`} value={flt.unit ?? commonUnit ?? 'Acre'}
                onChange={(e) => update(i, { ...flt, unit: e.target.value })}>
                {units.map((u) => <option key={u.code} value={u.code}>{u.name}</option>)}
              </select>
            )}
            {incomplete && <span className="b b-w">incomplete — not applied</span>}
            <button type="button" className="btn btn-s btn-sm" onClick={() => remove(i)} aria-label={`Remove filter ${i + 1} (${fd.label})`}>Remove</button>
          </div>
        );
      })}
      {filterable.length > 0 && (
        <select className="sel" aria-label="Add a filter" value=""
          onChange={(e) => { const f = fieldOf(e.target.value); if (f) onChange([...filters, newFilter(f)]); }}>
          <option value="">+ Add a filter…</option>
          {filterable.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
      )}
    </fieldset>
  );
}
