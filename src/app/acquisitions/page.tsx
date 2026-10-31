'use client';

import React, { useEffect, useState } from 'react';
import Shell from '@/components/layout/Shell';
import { Card, Modal, Field, Stage, Table, Toolbar, SearchBox, Count, Loading, ErrorNote, Kpi, fmtNum, fmtDate, Pager } from '@/components/legacy/ui';
import { useList, RefSelect, WorkflowActions, useListQuery, RecordPicker } from '@/components/legacy/data';
import { send, useApi } from '@/lib/client/api';
import { LoadError } from '@/components/auth/PageGuard';
import { useCan, useCanIn } from '@/lib/client/permissions';

export default function AcquisitionsPage() {
  return <Shell><AcquisitionsContent /></Shell>;
}

const EMPTY = { project_id: '', mode: '', area_required: '', negotiated_rate: '', target_handover_date: '', remarks: '', survey_ids: [] as string[] };

function AcquisitionsContent() {
  const can = useCan();
  const canIn = useCanIn();
  const lq = useListQuery();
  const list = useList('/api/acquisitions', 'acquisitions', lq.params);
  const { rows, body, page, summary, loading, error } = list;
  const items: any[] = body?.title_items ?? [];
  const projects = useApi(can('projects:read') ? '/api/projects' : null).data?.projects ?? [];
  const [picked, setPicked] = useState<Record<string, string>>({});   // chosen survey id → label
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ...EMPTY });
  const [title, setTitle] = useState<any | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Title checks and workflow steps: acquisitions:update in the record's province.
  const canEdit = (a: any) => canIn('acquisitions:update', a?.province_code);
  const project = projects.find((p: any) => p.project_id === form.project_id);
  // /acquisitions?from_request=<id>: a land request handed over for acquisition opens the form pre-filled
  // with its project, drawn area and the recorded parcels inside its polygon.
  const [fromRequest, setFromRequest] = useState<any | null>(null);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('from_request');
    if (!id) return;
    fetch(`/api/requests?id=${encodeURIComponent(id)}`).then((r) => r.json()).then((d) => {
      if (!d.request) { setFormError(d.error || 'That land request was not found.'); return; }
      const r = d.request;
      const parcels: any[] = (d.parcels ?? []).filter((p: any) => !['Acquired', 'Leased'].includes(p.status));
      setPicked(Object.fromEntries(parcels.map((p: any) => [p.id, `${p.code} · ${p.status}`])));
      setForm({ ...EMPTY, project_id: r.project_id, area_required: String(Number(r.area_acres)), target_handover_date: String(r.required_date ?? '').slice(0, 10),
        remarks: `From land request ${r.code} (${r.purpose}).`, survey_ids: parcels.map((p: any) => p.id) });
      setFromRequest(r); setOpen(true);
    }).catch(() => {});
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setFormError(null);
    try {
      await send('POST', '/api/acquisitions', {
        project_id: form.project_id, mode: form.mode, area_required: Number(form.area_required),
        negotiated_rate: form.negotiated_rate ? Number(form.negotiated_rate) : undefined,
        target_handover_date: form.target_handover_date || undefined, remarks: form.remarks || undefined, survey_ids: form.survey_ids,
        land_request_id: fromRequest?.id,
      });
      setOpen(false); setForm({ ...EMPTY }); setFromRequest(null);
    } catch (err: any) { setFormError(err.message); } finally { setBusy(false); }
  };

  const toggle = async (a: any, code: string, checked: boolean) => {
    setFormError(null);
    try {
      await send('PUT', '/api/acquisitions', { id: a.id, action: 'toggle_check', item_code: code, checked });
      setTitle((t: any) => t && { ...t, checked_items: checked ? [...(t.checked_items ?? []), code] : (t.checked_items ?? []).filter((c: string) => c !== code) });
    } catch (err: any) { setFormError(err.message); }
  };

  const shown = rows;   // searched and paged by the database
  const checked = (a: any): string[] => (Array.isArray(a?.checked_items) ? a.checked_items : []);

  return (
    <>
      {list.body && (
        <div className="kpis">
          <Kpi label="Acquisitions" value={fmtNum(summary.total)} sub="land being acquired or leased" />
          <Kpi label="In negotiation / approval" value={fmtNum(summary.open)} sub="open" tone="w" />
          <Kpi label="Handed over" value={fmtNum(summary.handed_over)} sub="complete" tone="g" />
          <Kpi label="Area required" value={`${fmtNum(summary.area_required, 1)} ac`} sub="all acquisitions" />
        </div>
      )}
      <Card icon="clip" title="Acquisition & Title"
        sub="Identification → Negotiation → Approval → Acquisition / Lease → Handover · title verification checklist per acquisition">
        <LoadError {...list} what="acquisitions" />
        {can('acquisitions:create') && (
          <div className="bar">{can('projects:read')
            ? <button className="btn btn-p" onClick={() => { setFormError(null); setForm({ ...EMPTY }); setOpen(true); }}>+ Add Acquisition</button>
            : <button className="btn btn-p" disabled title="Adding an acquisition also needs read access to projects.">+ Add Acquisition</button>}</div>
        )}
        <Toolbar>
          <SearchBox value={lq.q} onChange={lq.setQ} placeholder="Search code, project, mode or survey…" />
          <Count n={page?.total ?? shown.length} />
        </Toolbar>
        {loading ? <Loading what="acquisitions" /> : (
          <Table caption="Acquisitions"
            head={<><th>Acquisition</th><th>Prov.</th><th>Project</th><th>Mode</th><th className="num">Area (ac)</th><th className="num">Rate (Rs/ac)</th>
              <th>Surveys</th><th>Title checks</th><th>Handover by</th><th>Stage</th><th>Actions</th></>}
            empty={shown.length || error ? false : 'No acquisitions.'} colSpan={11}>
            {shown.map((a: any) => {
              const done = Number(a.title_checks_done || 0), total = Number(a.title_checks_total || items.length || 0);
              return (
                <tr key={a.id}>
                  <td><span className="code">{a.code}</span></td>
                  <td><span className="pill">{a.province_code}</span></td>
                  <td>{a.project_name}</td>
                  <td>{a.mode}</td>
                  <td className="num">{fmtNum(a.area_required, 2)}</td>
                  <td className="num">{a.negotiated_rate != null ? fmtNum(a.negotiated_rate) : '—'}</td>
                  <td>{a.survey_numbers || <span className="note">—</span>}</td>
                  <td><span className={`b ${total && done >= total ? 'b-g' : 'b-w'}`}>{done} / {total}</span></td>
                  <td>{fmtDate(a.target_handover_date)}</td>
                  <td><Stage value={a.stage_code} /></td>
                  <td><div className="acts">
                    <button onClick={() => { setFormError(null); setTitle(a); }}>Title</button>
                    <WorkflowActions workflow="acquisitions" resource="/api/acquisitions" record={a} can={canEdit(a)} />
                  </div></td>
                </tr>
              );
            })}
          </Table>
        )}
        <Pager page={page} onOffset={lq.setOffset} />
      </Card>

      <Modal open={!!title} icon="cbox" title={`Title verification — ${title?.code ?? ''}`} onClose={() => setTitle(null)}
        footer={<button className="btn btn-s" onClick={() => setTitle(null)}>Close</button>}>
        {formError && <ErrorNote>{formError}</ErrorNote>}
        <p className="note u-mb-10">Tick each check when the evidence has been seen. Each tick records who checked it and when.</p>
        <div className="checks">
          {items.map((it) => (
            <label key={it.code}>
              <input type="checkbox" checked={checked(title).includes(it.code)} disabled={!canEdit(title)}
                onChange={(e) => toggle(title, it.code, e.target.checked)} />
              {' '}{it.name}{it.is_mandatory && <span className="req"> *</span>}
            </label>
          ))}
        </div>
        <p className="note u-mt-10">* mandatory before the acquisition can be approved.</p>
      </Modal>

      <Modal open={open} icon="clip" title={fromRequest ? `Add Acquisition — from ${fromRequest.code}` : 'Add Acquisition'} onClose={() => { setOpen(false); setFromRequest(null); }}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setOpen(false)}>Cancel</button>
          <button type="submit" form="acqForm" className="btn btn-p" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </>}>
        <form id="acqForm" onSubmit={create} className="fgrid">
          <Field label="Project" required full htmlFor="aqProj">
            <select id="aqProj" required value={form.project_id} onChange={(e) => setForm((f) => ({ ...f, project_id: e.target.value, survey_ids: [] }))}>
              <option value="">— Select project —</option>
              {projects.map((p: any) => <option key={p.project_id} value={p.project_id}>{p.project_code} — {p.project_name} ({p.province_code})</option>)}
            </select>
          </Field>
          <Field label="Mode" required full htmlFor="aqMode"><RefSelect id="aqMode" required source="enum:acquisition.mode" value={form.mode} onChange={(v) => setForm((f) => ({ ...f, mode: v }))} /></Field>
          <Field label="Area required" required htmlFor="aqArea"><div className="area-in"><input id="aqArea" type="number" min="0.01" step="0.01" required value={form.area_required} onChange={(e) => setForm((f) => ({ ...f, area_required: e.target.value }))} /><span className="u">acres</span></div></Field>
          <Field label="Negotiated rate (Rs / acre)" htmlFor="aqRate"><input id="aqRate" type="number" min="0" step="1" value={form.negotiated_rate} onChange={(e) => setForm((f) => ({ ...f, negotiated_rate: e.target.value }))} /></Field>
          <Field label="Target handover" htmlFor="aqDate"><input id="aqDate" type="date" value={form.target_handover_date} onChange={(e) => setForm((f) => ({ ...f, target_handover_date: e.target.value }))} /></Field>
          <Field label="Surveys" full htmlFor="aqSurv" hint="Search and add each survey">
            <RecordPicker id="aqSurv" resource="/api/surveys" rowsKey="surveys" label="Survey to add" value=""
              filters={{ province: project?.province_code }} idOf={(r) => r.survey_id} optionLabel={(r) => `${r.survey_code} · Survey ${r.survey_no}`}
              onChange={(id, r) => { if (!id || form.survey_ids.includes(id)) return;
                setPicked((p) => ({ ...p, [id]: r ? `${r.survey_code} · Survey ${r.survey_no}` : id }));
                setForm((f) => ({ ...f, survey_ids: [...f.survey_ids, id] })); }} />
            <div className="u-mt-8">
              {form.survey_ids.length === 0 && <span className="note">No surveys chosen.</span>}
              {form.survey_ids.map((id: string) => (
                <span key={id} className="pill u-chip">{picked[id] ?? id}{' '}
                  <button type="button" className="bx" aria-label={`Remove ${picked[id] ?? id}`} onClick={() => setForm((f) => ({ ...f, survey_ids: f.survey_ids.filter((x: string) => x !== id) }))}>&times;</button></span>
              ))}
            </div>
          </Field>
          <Field label="Remarks" full htmlFor="aqRem"><textarea id="aqRem" value={form.remarks} onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))} /></Field>
        </form>
      </Modal>
    </>
  );
}
