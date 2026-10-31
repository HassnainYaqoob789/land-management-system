'use client';

import React, { useState } from 'react';
import Shell from '@/components/layout/Shell';
import { Card, Modal, Field, Stage, Table, Toolbar, SearchBox, Count, Loading, Kpi, fmtNum, fmtDate, Pager } from '@/components/legacy/ui';
import { useList, RefSelect, WorkflowActions, useListQuery, RecordPicker } from '@/components/legacy/data';
import { send, useApi } from '@/lib/client/api';
import { LoadError } from '@/components/auth/PageGuard';
import { useCan, useCanIn } from '@/lib/client/permissions';

export default function EncroachmentsPage() {
  return <Shell><EncroachmentsContent /></Shell>;
}

const EMPTY = { project_id: '', anchor: '', category_code: '', risk: '', detected_on: '', encroacher: '', area_affected: '',
  lat: '', lng: '', description: '', impact: '', corrective_action: '' };

function EncroachmentsContent() {
  const can = useCan();
  const canIn = useCanIn();
  const lq = useListQuery();
  const list = useList('/api/encroachments', 'encroachments', lq.params);
  const { rows, page, summary, loading, error } = list;
  const projects = useApi(can('projects:read') ? '/api/projects' : null).data?.projects ?? [];
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ...EMPTY });
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The chosen project's corridors only (filtered in the database).
  const corridors = useApi(form.project_id && can('rows:read') ? `/api/rows?project_id=${form.project_id}&limit=500` : null).data?.rows ?? [];
  const set = (k: keyof typeof EMPTY) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const project = projects.find((p: any) => p.project_id === form.project_id);

  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setFormError(null);
    const [kind, id] = form.anchor.split(':');
    try {
      await send('POST', '/api/encroachments', {
        project_id: form.project_id, survey_id: kind === 's' ? id : undefined, row_id: kind === 'r' ? id : undefined,
        category_code: form.category_code, risk: form.risk, detected_on: form.detected_on || undefined, encroacher: form.encroacher || undefined,
        area_affected: form.area_affected ? Number(form.area_affected) : undefined,
        lat: form.lat ? Number(form.lat) : undefined, lng: form.lng ? Number(form.lng) : undefined,
        description: form.description, impact: form.impact || undefined, corrective_action: form.corrective_action || undefined,
      });
      setOpen(false); setForm({ ...EMPTY });
    } catch (err: any) { setFormError(err.message); } finally { setBusy(false); }
  };

  const shown = rows;   // searched and paged by the database

  return (
    <>
      {list.body && (
        <div className="kpis">
          <Kpi label="Open encroachments" value={fmtNum(summary.open)} sub="not yet resolved" tone={summary.open ? 'w' : 'g'} />
          <Kpi label="High / critical risk" value={fmtNum(summary.open_high)} sub="open, by risk" tone="d" />
          <Kpi label="Resolved" value={fmtNum(summary.total - summary.open)} sub="closed out" tone="g" />
        </div>
      )}
      <Card icon="shield" title="Encroachments" sub="Reported → Assessed → Action Approved → Legal Follow-up → Resolved · on a survey parcel or a ROW corridor">
        <LoadError {...list} what="encroachments" />
        {can('encroachments:create') && (
          <div className="bar">{can('projects:read')
            ? <button className="btn btn-p" onClick={() => { setFormError(null); setForm({ ...EMPTY }); setOpen(true); }}>+ Report Encroachment</button>
            : <button className="btn btn-p" disabled title="Reporting an encroachment also needs read access to projects.">+ Report Encroachment</button>}</div>
        )}
        <Toolbar>
          <SearchBox value={lq.q} onChange={lq.setQ} placeholder="Search code, encroacher, project, survey or corridor…" />
          <Count n={page?.total ?? shown.length} />
        </Toolbar>
        {loading ? <Loading what="encroachments" /> : (
          <Table caption="Encroachments"
            head={<><th>Code</th><th>Prov.</th><th>On</th><th>Category</th><th>Encroacher</th><th className="num">Area (ac)</th><th>Risk</th><th>Detected</th><th>Stage</th><th>Actions</th></>}
            empty={shown.length || error ? false : 'No encroachments reported.'} colSpan={10}>
            {shown.map((r: any) => (
              <tr key={r.encroachment_id}>
                <td><span className="code">{r.encroachment_code}</span></td>
                <td><span className="pill">{r.province_code}</span></td>
                <td>{r.project_code}<br /><small className="note">{r.survey_code || r.row_code || '—'}</small></td>
                <td>{r.category_code}</td>
                <td>{r.encroacher || <span className="note">—</span>}</td>
                <td className="num">{r.area_affected != null ? fmtNum(r.area_affected, 2) : '—'}</td>
                <td><span className={`b ${['High', 'Critical'].includes(r.risk) ? 'b-d' : r.risk === 'Medium' ? 'b-w' : 'b-n'}`}>{r.risk}</span></td>
                <td>{fmtDate(r.detected_on)}<br /><small className="note">{fmtNum(r.age_days)} days</small></td>
                <td><Stage value={r.stage_code} /></td>
                <td><div className="acts">
                  <WorkflowActions workflow="encroachments" resource="/api/encroachments" record={{ ...r, id: r.encroachment_id, code: r.encroachment_code }}
                    can={canIn('encroachments:update', r.province_code)} />
                </div></td>
              </tr>
            ))}
          </Table>
        )}
        <Pager page={page} onOffset={lq.setOffset} />
      </Card>

      <Modal open={open} icon="shield" title="Report Encroachment" onClose={() => setOpen(false)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setOpen(false)}>Cancel</button>
          <button type="submit" form="encForm" className="btn btn-p" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </>}>
        <form id="encForm" onSubmit={create} className="fgrid">
          <Field label="Project" required htmlFor="eProj">
            <select id="eProj" required value={form.project_id} onChange={(e) => setForm((f) => ({ ...f, project_id: e.target.value, anchor: '' }))}>
              <option value="">— Select project —</option>
              {projects.map((p: any) => <option key={p.project_id} value={p.project_id}>{p.project_code} — {p.project_name}</option>)}
            </select>
          </Field>
          <Field label="On survey or corridor" required htmlFor="eAnchor">
            <div className="picker">
              <RecordPicker id="eAnchor" resource="/api/surveys" rowsKey="surveys" label="Survey parcel" value={form.anchor.startsWith('s:') ? form.anchor.slice(2) : ''}
                filters={{ province: project?.province_code }} idOf={(r) => r.survey_id} optionLabel={(r) => `${r.survey_code} · Survey ${r.survey_no}`}
                onChange={(id) => set('anchor')(id ? `s:${id}` : '')} />
              <select aria-label="Or a ROW corridor" value={form.anchor.startsWith('r:') ? form.anchor : ''} disabled={!project} onChange={(e) => set('anchor')(e.target.value)}>
                <option value="">— or a ROW corridor of this project —</option>
                {corridors.map((r: any) => <option key={r.id} value={`r:${r.id}`}>{r.code} · {r.name}</option>)}
              </select>
            </div>
          </Field>
          <Field label="Category" required htmlFor="eCat"><RefSelect id="eCat" required source="lookup:encroachment_category" value={form.category_code} onChange={set('category_code')} /></Field>
          <Field label="Risk" required htmlFor="eRisk"><RefSelect id="eRisk" required source="enum:encroachment.risk" value={form.risk} onChange={set('risk')} /></Field>
          <Field label="Detected on" required htmlFor="eDet"><input id="eDet" type="date" required value={form.detected_on} onChange={(e) => set('detected_on')(e.target.value)} /></Field>
          <Field label="Encroacher" htmlFor="eWho"><input id="eWho" value={form.encroacher} onChange={(e) => set('encroacher')(e.target.value)} /></Field>
          <Field label="Area affected" htmlFor="eArea"><div className="area-in"><input id="eArea" type="number" min="0" step="0.01" value={form.area_affected} onChange={(e) => set('area_affected')(e.target.value)} /><span className="u">acres</span></div></Field>
          <Field label="Latitude" htmlFor="eLat" hint="Leave empty to use the survey parcel's recorded location"><input id="eLat" type="number" step="0.000001" min="23" max="37.5" value={form.lat} onChange={(e) => set('lat')(e.target.value)} /></Field>
          <Field label="Longitude" htmlFor="eLng"><input id="eLng" type="number" step="0.000001" min="60" max="78" value={form.lng} onChange={(e) => set('lng')(e.target.value)} /></Field>
          <Field label="Description" required full htmlFor="eDesc"><textarea id="eDesc" required value={form.description} onChange={(e) => set('description')(e.target.value)} /></Field>
          <Field label="Impact" full htmlFor="eImp"><textarea id="eImp" value={form.impact} onChange={(e) => set('impact')(e.target.value)} /></Field>
          <Field label="Corrective action" full htmlFor="eAct"><textarea id="eAct" value={form.corrective_action} onChange={(e) => set('corrective_action')(e.target.value)} /></Field>
        </form>
      </Modal>
    </>
  );
}
