'use client';

import React, { useState } from 'react';
import Shell from '@/components/layout/Shell';
import { Card, Modal, Field, Stage, Table, Toolbar, SearchBox, Count, Loading, Kpi, fmtNum, fmtDate, Pager } from '@/components/legacy/ui';
import { useList, RefSelect, WorkflowActions, useListQuery } from '@/components/legacy/data';
import { send, useApi } from '@/lib/client/api';
import { LoadError } from '@/components/auth/PageGuard';
import { useCan, useCanIn } from '@/lib/client/permissions';

export default function RowsPage() {
  return <Shell><RowsContent /></Shell>;
}

const EMPTY = { project_id: '', name: '', row_type: '', from_point: '', to_point: '', length_m: '', width_m: '',
  agreement_date: '', tenure_years: '', annual_rent: '', obligations: '' };

function RowsContent() {
  const can = useCan();
  const canIn = useCanIn();
  const lq = useListQuery();
  const list = useList('/api/rows', 'rows', lq.params);
  const { rows, body, page, summary, loading, error } = list;
  const projects = useApi(can('projects:read') ? '/api/projects' : null).data?.projects ?? [];
  const renewals: any[] = body?.renewal_schedule ?? [];
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ...EMPTY });
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof EMPTY) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const num = (v: string) => (v === '' ? undefined : Number(v));

  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setFormError(null);
    try {
      await send('POST', '/api/rows', {
        ...form, length_m: num(form.length_m), width_m: num(form.width_m), tenure_years: num(form.tenure_years),
        annual_rent: num(form.annual_rent), agreement_date: form.agreement_date || undefined,
        from_point: form.from_point || undefined, to_point: form.to_point || undefined, obligations: form.obligations || undefined,
      });
      setOpen(false); setForm({ ...EMPTY });
    } catch (err: any) { setFormError(err.message); } finally { setBusy(false); }
  };

  const shown = rows;   // searched and paged by the database
  const km = summary.length_m / 1000, acres = summary.area_acres;
  const due = renewals.filter((r) => r.days_to_expiry != null && r.days_to_expiry <= 180);
  const lengthAcres = Number(form.length_m) * Number(form.width_m) / 4046.8564224;

  return (
    <>
      {list.body && (
        <div className="kpis">
          <Kpi label="Corridors" value={fmtNum(summary.total)} sub="pipelines, flowlines, roads and power lines" />
          <Kpi label="Length" value={`${fmtNum(km, 1)} km`} sub="total corridor length" tone="g" />
          <Kpi label="Area" value={`${fmtNum(acres, 1)} ac`} sub="length × width" />
          <Kpi label="Renewal due ≤ 180 days" value={fmtNum(due.length)} sub="tenure ending" tone={due.length ? 'w' : 'g'} />
        </div>
      )}
      <Card icon="route" title="ROW & Pipelines" sub="Draft → Under Review → Approved · width restrictions, tenure and recurring annual rent">
        <LoadError {...list} what="ROW corridors" />
        {can('rows:create') && (
          <div className="bar">{can('projects:read')
            ? <button className="btn btn-p" onClick={() => { setFormError(null); setForm({ ...EMPTY }); setOpen(true); }}>+ Add ROW Corridor</button>
            : <button className="btn btn-p" disabled title="Adding a corridor also needs read access to projects.">+ Add ROW Corridor</button>}</div>
        )}
        <Toolbar>
          <SearchBox value={lq.q} onChange={lq.setQ} placeholder="Search corridor, project or type…" />
          <Count n={page?.total ?? shown.length} />
        </Toolbar>
        {loading ? <Loading what="corridors" /> : (
          <Table caption="Right-of-way corridors"
            head={<><th>Corridor</th><th>Name</th><th>Prov.</th><th>Project</th><th>Type</th><th className="num">Length (m)</th>
              <th className="num">Width (m)</th><th className="num">Area (ac)</th><th className="num">Annual rent (Rs)</th><th>Expiry</th><th>Stage</th><th>Actions</th></>}
            empty={shown.length || error ? false : 'No corridors in this province.'} colSpan={12}>
            {shown.map((r: any) => (
              <tr key={r.id}>
                <td><span className="code">{r.code}</span></td>
                <td>{r.name}{(r.from_point || r.to_point) && <><br /><small className="note">{r.from_point} → {r.to_point}</small></>}</td>
                <td><span className="pill">{r.province_code}</span></td>
                <td>{r.project_name}</td>
                <td>{r.row_type}</td>
                <td className="num">{fmtNum(r.length_m)}</td>
                <td className="num">{fmtNum(r.width_m, 1)}</td>
                <td className="num">{fmtNum(r.area_acres, 2)}</td>
                <td className="num">{fmtNum(r.annual_rent)}</td>
                <td>{fmtDate(r.expiry_date)}{r.days_to_expiry != null && r.days_to_expiry <= 180 && <><br /><span className="b b-w">{r.days_to_expiry} days</span></>}</td>
                <td><Stage value={r.stage_code} /></td>
                <td><div className="acts"><WorkflowActions workflow="rows" resource="/api/rows" record={r} can={canIn('rows:update', r.province_code)} /></div></td>
              </tr>
            ))}
          </Table>
        )}
        <Pager page={page} onOffset={lq.setOffset} />
      </Card>

      <Modal open={open} icon="route" title="Add ROW Corridor" onClose={() => setOpen(false)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setOpen(false)}>Cancel</button>
          <button type="submit" form="rowForm" className="btn btn-p" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </>}>
        <form id="rowForm" onSubmit={create} className="fgrid">
          <Field label="Project" required full htmlFor="rwProj">
            <select id="rwProj" required value={form.project_id} onChange={(e) => set('project_id')(e.target.value)}>
              <option value="">— Select project —</option>
              {projects.map((p: any) => <option key={p.project_id} value={p.project_id}>{p.project_code} — {p.project_name} ({p.province_code})</option>)}
            </select>
          </Field>
          <Field label="Corridor name" required full htmlFor="rwName"><input id="rwName" required value={form.name} onChange={(e) => set('name')(e.target.value)} /></Field>
          <Field label="Type" required htmlFor="rwType"><RefSelect id="rwType" required source="enum:row_corridor.row_type" value={form.row_type} onChange={set('row_type')} /></Field>
          <Field label="Agreement date" required htmlFor="rwDate"><input id="rwDate" type="date" required value={form.agreement_date} onChange={(e) => set('agreement_date')(e.target.value)} /></Field>
          <Field label="From" htmlFor="rwFrom"><input id="rwFrom" value={form.from_point} onChange={(e) => set('from_point')(e.target.value)} /></Field>
          <Field label="To" htmlFor="rwTo"><input id="rwTo" value={form.to_point} onChange={(e) => set('to_point')(e.target.value)} /></Field>
          <Field label="Length (m)" required htmlFor="rwLen"><input id="rwLen" type="number" min="1" step="1" required value={form.length_m} onChange={(e) => set('length_m')(e.target.value)} /></Field>
          <Field label="Width (m)" required htmlFor="rwW" hint={lengthAcres > 0 ? `≈ ${lengthAcres.toFixed(2)} acres` : undefined}>
            <input id="rwW" type="number" min="0.1" step="0.1" required value={form.width_m} onChange={(e) => set('width_m')(e.target.value)} />
          </Field>
          <Field label="Tenure (years)" required htmlFor="rwTen"><input id="rwTen" type="number" min="1" max="99" required value={form.tenure_years} onChange={(e) => set('tenure_years')(e.target.value)} /></Field>
          <Field label="Annual rent (Rs)" htmlFor="rwRent"><input id="rwRent" type="number" min="0" step="0.01" value={form.annual_rent} onChange={(e) => set('annual_rent')(e.target.value)} /></Field>
          <Field label="Obligations" full htmlFor="rwObl"><textarea id="rwObl" value={form.obligations} onChange={(e) => set('obligations')(e.target.value)} placeholder="Crossing permissions, restrictions on cultivation or construction" /></Field>
        </form>
      </Modal>
    </>
  );
}
