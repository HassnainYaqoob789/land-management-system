'use client';

// A compensation case's valuation, as the reference case form records it:
// owners with their shares, and lease, crop, tree and other lines per survey.
// The database computes every amount and total from these lines
// (api.case_totals); the figures shown here are only a preview.

import React from 'react';
import { Field } from '@/components/legacy/ui';
import { RefSelect, RecordPicker } from '@/components/legacy/data';
import { useReference, enumOf } from '@/lib/client/api';
import { formatPKR } from '@/lib/domain';

// `label` / `survey_label` only name an already-chosen record on screen; they are not sent.
export type Owner = { landowner_id: string; share_pct: string; owner_status: string; label?: string };
export type LeaseLine = { survey_id: string; survey_share_pct: string; lease_area: string; subsequent_area: string; survey_label?: string };
export type CropLine = { survey_id: string; crop_type: string; rate_per_acre: string; damage_area: string; survey_label?: string };
export type TreeLine = { survey_id: string; species_code: string; size: string; rate: string; qty: string; survey_label?: string };
export type MiscLine = { survey_id: string; payment_type: string; amount: string; survey_label?: string };
export type CaseDraft = {
  project_id: string; land_use_code: string; lease_rate: string; lease_term_months: string;
  case_remarks: string; owners: Owner[]; lease_lines: LeaseLine[]; crop_lines: CropLine[]; tree_lines: TreeLine[]; misc_lines: MiscLine[];
  checked_documents: string[];
};
export const emptyCase = (): CaseDraft => ({ project_id: '', land_use_code: '', lease_rate: '', lease_term_months: '', case_remarks: '',
  owners: [], lease_lines: [], crop_lines: [], tree_lines: [], misc_lines: [], checked_documents: [] });

const n = (v: string) => (v === '' || v == null ? 0 : Number(v));

/** A landowner as a picker shows them: name and CNIC exactly as the server sent it (masked without pii:read). */
const ownerLabel = (l: { full_name?: string; cnic?: string | null }) => `${l.full_name ?? ''}${l.cnic ? ` (${l.cnic})` : ''}`;
export function preview(d: CaseDraft) {
  const area = d.lease_lines.reduce((s, l) => s + (l.subsequent_area !== '' ? n(l.subsequent_area) : n(l.lease_area)), 0);
  const lease = (n(d.lease_rate) * area * n(d.lease_term_months)) / 12;
  const crop = d.crop_lines.reduce((s, l) => s + n(l.rate_per_acre) * n(l.damage_area), 0);
  const tree = d.tree_lines.reduce((s, l) => s + n(l.rate) * n(l.qty), 0);
  const misc = d.misc_lines.reduce((s, l) => s + n(l.amount), 0);
  return { area, lease, crop, tree, misc, total: lease + crop + tree + misc, shares: d.owners.reduce((s, o) => s + n(o.share_pct), 0) };
}

/** The request body the cases API takes for this draft. */
export function toBody(d: CaseDraft) {
  return {
    project_id: d.project_id || undefined, land_use_code: d.land_use_code, case_remarks: d.case_remarks || undefined,
    lease_rate: d.lease_rate === '' ? undefined : n(d.lease_rate), lease_term_months: d.lease_term_months === '' ? undefined : n(d.lease_term_months),
    owners: d.owners.map(({ label: _l, ...o }) => o),
    lease_lines: d.lease_lines.map(({ survey_label: _s, ...l }) => l), crop_lines: d.crop_lines.map(({ survey_label: _s, ...l }) => l),
    tree_lines: d.tree_lines.map(({ survey_label: _s, ...l }) => l), misc_lines: d.misc_lines.map(({ survey_label: _s, ...l }) => l),
    checked_documents: d.checked_documents,
  };
}

function Sub<T>({ title, rows, cols, blank, onChange, total }: {
  title: string; rows: T[]; blank: T; onChange: (rows: T[]) => void; total?: React.ReactNode;
  cols: { label: string; cell: (r: T, set: (patch: Partial<T>) => void) => React.ReactNode }[];
}) {
  return (
    <div className="fg full">
      <label>{title}</label>
      <div className="sub">
        <table>
          <thead><tr>{cols.map((c) => <th key={c.label}>{c.label}</th>)}<th aria-label="Remove" /></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={cols.length + 1} className="empty">None.</td></tr>}
            {rows.map((r, i) => (
              <tr key={i}>
                {cols.map((c) => <td key={c.label}>{c.cell(r, (patch) => onChange(rows.map((x, j) => (j === i ? { ...x, ...patch } : x))))}</td>)}
                <td><button type="button" className="bx" aria-label="Remove line" onClick={() => onChange(rows.filter((_, j) => j !== i))}>&times;</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="foot">
          <button type="button" className="btn btn-s btn-sm" onClick={() => onChange([...rows, { ...blank }])}>+ Add line</button>
          {total}
        </div>
      </div>
    </div>
  );
}

export default function CaseForm({ draft, onChange, projects, species, documentItems, creating }: {
  draft: CaseDraft; onChange: (d: CaseDraft) => void; projects: any[]; species: any[];
  documentItems: any[]; creating: boolean;
}) {
  const ref = useReference();
  const set = (patch: Partial<CaseDraft>) => onChange({ ...draft, ...patch });
  const project = projects.find((p) => p.project_id === draft.project_id);
  const prov = project?.province_code;
  // Surveys and landowners are searched in the database, within the project's province.
  const surveySel = (v: string, label: string | undefined, onSet: (id: string, label: string) => void, required = false) => (
    <RecordPicker resource="/api/surveys" rowsKey="surveys" label="Survey" required={required} value={v} current={label}
      filters={{ province: prov }} idOf={(r) => r.survey_id} optionLabel={(r) => `${r.survey_code} · ${r.survey_no}`}
      onChange={(id, r) => onSet(id, r ? `${r.survey_code} · ${r.survey_no}` : '')} />
  );
  const num = (v: string, onSet: (v: string) => void, label: string, step = '0.01') =>
    <input aria-label={label} type="number" min="0" step={step} value={v} onChange={(e) => onSet(e.target.value)} />;
  const p = preview(draft);

  return (
    <div className="fgrid">
      {creating && (
        <Field label="Project / well location" required full htmlFor="cfProj">
          <select id="cfProj" required value={draft.project_id} onChange={(e) => set({ project_id: e.target.value, owners: [], lease_lines: [] })}>
            <option value="">— Select project —</option>
            {projects.map((x) => <option key={x.project_id} value={x.project_id}>{x.project_code} · {x.project_name} ({x.province_code})</option>)}
          </select>
        </Field>
      )}
      <Field label="Land used for" required htmlFor="cfUse"><RefSelect id="cfUse" required source="lookup:land_use" value={draft.land_use_code} onChange={(v) => set({ land_use_code: v })} /></Field>
      <Field label="Lease rate (Rs / acre / year)" htmlFor="cfRate"><input id="cfRate" type="number" min="0" step="1" value={draft.lease_rate} onChange={(e) => set({ lease_rate: e.target.value })} /></Field>
      <Field label="Lease term (months)" htmlFor="cfTerm"><input id="cfTerm" type="number" min="0" step="1" value={draft.lease_term_months} onChange={(e) => set({ lease_term_months: e.target.value })} /></Field>

      <Sub title="Landowners — shares must total 100%" rows={draft.owners} blank={{ landowner_id: '', share_pct: '', owner_status: 'O' }} onChange={(owners) => set({ owners })}
        total={<span>Total <span className={`b ${Math.abs(p.shares - 100) < 0.01 ? 'b-g' : 'b-w'}`}>{p.shares.toFixed(2)}%</span></span>}
        cols={[
          { label: 'Landowner', cell: (r, s) => (
            <RecordPicker resource="/api/landowners" rowsKey="landowners" label="Landowner" required value={r.landowner_id} current={r.label}
              filters={{ province: prov }} idOf={(l) => l.id}
              optionLabel={(l) => `${ownerLabel(l)}${l.is_deceased ? ' — deceased, locked' : ''}`}
              onChange={(id, l) => s({ landowner_id: id, label: l ? ownerLabel(l) : undefined })} />) },
          { label: 'Share %', cell: (r, s) => num(r.share_pct, (v) => s({ share_pct: v }), 'Share') },
          { label: 'As', cell: (r, s) => (
            <select aria-label="Owner or attorney" value={r.owner_status} onChange={(e) => s({ owner_status: e.target.value })}>
              {enumOf(ref, 'case_owner.owner_status').map((v) => <option key={v} value={v}>{({ O: 'Owner', A: 'Attorney', B: 'Both' } as Record<string, string>)[v] ?? v}</option>)}
            </select>) },
        ]} />

      <Sub title="Lease lines" rows={draft.lease_lines} blank={{ survey_id: '', survey_share_pct: '', lease_area: '', subsequent_area: '' }} onChange={(lease_lines) => set({ lease_lines })}
        total={<span>{p.area.toFixed(4)} ac · {formatPKR(p.lease)}</span>}
        cols={[
          { label: 'Survey', cell: (r, s) => surveySel(r.survey_id, r.survey_label, (v, l) => s({ survey_id: v, survey_label: l }), true) },
          { label: 'Owners\' share %', cell: (r, s) => num(r.survey_share_pct, (v) => s({ survey_share_pct: v }), 'Survey share') },
          { label: 'Area (ac)', cell: (r, s) => num(r.lease_area, (v) => s({ lease_area: v }), 'Lease area', '0.0001') },
          { label: 'Reduced area (ac)', cell: (r, s) => num(r.subsequent_area, (v) => s({ subsequent_area: v }), 'Reduced area', '0.0001') },
        ]} />

      <Sub title="Crop compensation" rows={draft.crop_lines} blank={{ survey_id: '', crop_type: '', rate_per_acre: '', damage_area: '' }} onChange={(crop_lines) => set({ crop_lines })}
        total={<span>{formatPKR(p.crop)}</span>}
        cols={[
          { label: 'Survey', cell: (r, s) => surveySel(r.survey_id, r.survey_label, (v, l) => s({ survey_id: v, survey_label: l })) },
          { label: 'Crop', cell: (r, s) => <input aria-label="Crop" required value={r.crop_type} onChange={(e) => s({ crop_type: e.target.value })} placeholder="e.g. wheat" /> },
          { label: 'Rate (Rs/ac)', cell: (r, s) => num(r.rate_per_acre, (v) => s({ rate_per_acre: v }), 'Crop rate', '1') },
          { label: 'Damaged (ac)', cell: (r, s) => num(r.damage_area, (v) => s({ damage_area: v }), 'Damaged area', '0.0001') },
        ]} />

      <Sub title="Tree compensation" rows={draft.tree_lines} blank={{ survey_id: '', species_code: '', size: '', rate: '', qty: '' }} onChange={(tree_lines) => set({ tree_lines })}
        total={<span>{formatPKR(p.tree)}</span>}
        cols={[
          { label: 'Survey', cell: (r, s) => surveySel(r.survey_id, r.survey_label, (v, l) => s({ survey_id: v, survey_label: l })) },
          { label: 'Species', cell: (r, s) => (
            <select aria-label="Species" required value={r.species_code} onChange={(e) => s({ species_code: e.target.value })}>
              <option value="">— Select —</option>{species.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
            </select>) },
          { label: 'Size', cell: (r, s) => (
            <select aria-label="Size" required value={r.size} onChange={(e) => s({ size: e.target.value })}>
              <option value="">—</option>{enumOf(ref, 'case_tree_line.size').map((v) => <option key={v}>{v}</option>)}
            </select>) },
          { label: 'Rate (Rs)', cell: (r, s) => num(r.rate, (v) => s({ rate: v }), 'Tree rate', '1') },
          { label: 'Count', cell: (r, s) => num(r.qty, (v) => s({ qty: v }), 'Tree count', '1') },
        ]} />

      <Sub title="Other compensation" rows={draft.misc_lines} blank={{ survey_id: '', payment_type: '', amount: '' }} onChange={(misc_lines) => set({ misc_lines })}
        total={<span>{formatPKR(p.misc)}</span>}
        cols={[
          { label: 'Survey', cell: (r, s) => surveySel(r.survey_id, r.survey_label, (v, l) => s({ survey_id: v, survey_label: l })) },
          { label: 'For', cell: (r, s) => <input aria-label="Description" required value={r.payment_type} onChange={(e) => s({ payment_type: e.target.value })} placeholder="e.g. disturbance, structure" /> },
          { label: 'Amount (Rs)', cell: (r, s) => num(r.amount, (v) => s({ amount: v }), 'Amount', '1') },
        ]} />

      {creating && documentItems.length > 0 && (
        <div className="fg full checks">
          <label>Documents seen</label>
          {documentItems.map((it) => (
            <label key={it.code}><input type="checkbox" checked={draft.checked_documents.includes(it.code)}
              onChange={(e) => set({ checked_documents: e.target.checked ? [...draft.checked_documents, it.code] : draft.checked_documents.filter((c) => c !== it.code) })} />
              {' '}{it.name}{it.required_when === 'always' && <span className="req"> *</span>}</label>
          ))}
        </div>
      )}
      <Field label="Remarks" full htmlFor="cfRem"><textarea id="cfRem" value={draft.case_remarks} onChange={(e) => set({ case_remarks: e.target.value })} /></Field>
      <div className="calc fg full">Preview: lease {formatPKR(p.lease)} + crop {formatPKR(p.crop)} + trees {formatPKR(p.tree)} + other {formatPKR(p.misc)} = <b>{formatPKR(p.total)}</b>. The database computes the final amounts.</div>
    </div>
  );
}
