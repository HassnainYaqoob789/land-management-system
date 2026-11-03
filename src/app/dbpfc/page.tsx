'use client';

import React, { useState } from 'react';
import Shell from '@/components/layout/Shell';
import { Card, Modal, Field, Stage, Table, Toolbar, SearchBox, Count, Loading, Kpi, fmtNum, fmtDate, Pager, rowOpen, DetailsModal } from '@/components/legacy/ui';
import { useList, WorkflowActions, useListQuery } from '@/components/legacy/data';
import { send, useApi } from '@/lib/client/api';
import { LoadError } from '@/components/auth/PageGuard';
import { useCan, useCanIn } from '@/lib/client/permissions';

export default function DbpfcPage() {
  return <Shell><DbpfcContent /></Shell>;
}

const EMPTY = { project_id: '', district_id: '', area_acres: '', estimated_rate: '', committee_ref: '', meeting_date: '', remarks: '' };

function DbpfcContent() {
  const can = useCan();
  const canIn = useCanIn();
  const lq = useListQuery();
  const list = useList('/api/dbpfc', 'dbpfc', lq.params);
  const { rows, body, page, summary, loading, error } = list;
  const history: any[] = body?.rate_history ?? [];
  const sindhProjects = (useApi(can('projects:read') ? '/api/projects' : null).data?.projects ?? []).filter((p: any) => p.province_code === 'SND');
  const districts = (useApi('/api/units').data?.admin_units ?? []).filter((u: any) => u.province_code === 'SND' && Number(u.level_no) === 0);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ...EMPTY });
  const [fix, setFix] = useState<any | null>(null);
  const [fixForm, setFixForm] = useState({ fixed_rate: '', committee_ref: '', meeting_date: '' });
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewId, setViewId] = useState<string | null>(null);
  const set = (k: keyof typeof EMPTY) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  // DBPFC estimates are Sindh records.
  const canEdit = (r: any) => canIn('dbpfc:update', r?.province_code ?? 'SND');

  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setFormError(null);
    try {
      await send('POST', '/api/dbpfc', {
        project_id: form.project_id, district_id: form.district_id || undefined, area_acres: Number(form.area_acres),
        estimated_rate: Number(form.estimated_rate), committee_ref: form.committee_ref || undefined,
        meeting_date: form.meeting_date || undefined, remarks: form.remarks || undefined,
      });
      setOpen(false); setForm({ ...EMPTY });
    } catch (err: any) { setFormError(err.message); } finally { setBusy(false); }
  };

  // Recording the committee's rate is an edit; the stage move is separate (WorkflowActions).
  const saveRate = async (e: React.FormEvent) => {
    e.preventDefault(); if (!fix) return; setBusy(true); setFormError(null);
    try {
      await send('PUT', '/api/dbpfc', { id: fix.dbpfc_id, fixed_rate: Number(fixForm.fixed_rate), committee_ref: fixForm.committee_ref || undefined, meeting_date: fixForm.meeting_date || undefined });
      setFix(null);
    } catch (err: any) { setFormError(err.message); } finally { setBusy(false); }
  };

  const shown = rows;   // searched and paged by the database

  return (
    <>
      {list.body && (
        <div className="kpis">
          <Kpi label="Estimates" value={fmtNum(summary.total)} sub="Sindh government land" />
          <Kpi label="Awaiting rate fixation" value={fmtNum(summary.pending)} sub="estimated or referred" tone={summary.pending ? 'w' : 'g'} />
          <Kpi label="Yearly amount" value={`Rs ${fmtNum(summary.annual_amount)}`} sub="at the applied rate (fixed, else estimated)" />
          <Kpi label="Paid" value={`Rs ${fmtNum(summary.paid_amount)}`} sub="released against estimates" tone="g" />
        </div>
      )}
      <Card icon="bldg" title="DBPFC — Sindh Govt Land"
        sub="Estimated → Referred to DBPFC → Rate Fixed · yearly lease on government land, pending the District Base Price Fixation Committee rate">
        <LoadError {...list} what="DBPFC estimates" />
        {can('dbpfc:create') && (
          <div className="bar">{can('projects:read')
            ? <button className="btn btn-p" onClick={() => { setFormError(null); setForm({ ...EMPTY }); setOpen(true); }}>+ Add Estimate</button>
            : <button className="btn btn-p" disabled title="Adding an estimate also needs read access to projects.">+ Add Estimate</button>}</div>
        )}
        <Toolbar>
          <SearchBox value={lq.q} onChange={lq.setQ} placeholder="Search code, district, project or committee ref…" />
          <Count n={page?.total ?? shown.length} />
        </Toolbar>
        {loading ? <Loading what="estimates" /> : (
          <Table caption="DBPFC estimates"
            head={<><th>DBPFC no.</th><th>District</th><th>Project</th><th className="num">Area (ac)</th><th className="num">Estimated / ac</th>
              <th className="num">Fixed / ac</th><th className="num">Yearly (Rs)</th><th>Committee</th><th>Stage</th><th>Actions</th></>}
            empty={shown.length || error ? false : 'No estimates.'} colSpan={10}>
            {shown.map((r: any) => (
              <tr key={r.dbpfc_id} {...rowOpen(() => setViewId(r.dbpfc_id), `Show details of ${r.dbpfc_code}`)}>
                <td><span className="code">{r.dbpfc_code}</span></td>
                <td>{r.district_name}</td>
                <td><span className="mono">{r.project_code}</span></td>
                <td className="num">{fmtNum(r.area_acres, 2)}</td>
                <td className="num">{fmtNum(r.estimated_rate)}</td>
                <td className="num">{r.fixed_rate != null ? fmtNum(r.fixed_rate) : <span className="note">—</span>}</td>
                <td className="num">{fmtNum(r.annual_amount)}</td>
                <td>{r.committee_ref || <span className="note">—</span>}{r.meeting_date && <><br /><small className="note">{fmtDate(r.meeting_date)}</small></>}</td>
                <td><Stage value={r.stage_code} /></td>
                <td><div className="acts">
                  {canEdit(r) && r.stage_code !== 'Stopped' && (
                    <button onClick={() => { setFormError(null); setFix(r); setFixForm({ fixed_rate: r.fixed_rate ?? '', committee_ref: r.committee_ref ?? '', meeting_date: r.meeting_date?.slice(0, 10) ?? '' }); }}>Record rate</button>
                  )}
                  <WorkflowActions workflow="dbpfc" resource="/api/dbpfc" record={{ ...r, id: r.dbpfc_id, code: r.dbpfc_code }} can={canEdit(r)} />
                </div></td>
              </tr>
            ))}
          </Table>
        )}
        <Pager page={page} onOffset={lq.setOffset} />
      </Card>

      {(() => {
        const v = viewId ? rows.find((r: any) => r.dbpfc_id === viewId) : null;
        if (!v) return null;
        const changes = history.filter((h) => h.dbpfc_id === v.dbpfc_id);
        return (
          <DetailsModal open icon="receipt" onClose={() => setViewId(null)}
            title={<>DBPFC estimate <span className="code">{v.dbpfc_code}</span></>}
            sections={[
              { items: [
                ['Project', v.project_code],
                ['District', v.district_name],
                ['Province', v.province_code],
                ['Stage', <Stage value={v.stage_code} />],
              ] },
              { title: 'Rates', items: [
                ['Area (ac)', fmtNum(v.area_acres, 2)],
                ['Estimated rate (Rs/ac)', v.estimated_rate != null ? fmtNum(v.estimated_rate) : null],
                ['Fixed rate (Rs/ac)', v.fixed_rate != null ? fmtNum(v.fixed_rate) : <span className="note">not fixed yet</span>],
                ['Applied rate (Rs/ac)', v.applied_rate != null ? fmtNum(v.applied_rate) : null],
                ['Yearly amount (Rs)', v.annual_amount != null ? fmtNum(v.annual_amount) : null],
                ['Paid so far (Rs)', v.paid_amount != null ? fmtNum(v.paid_amount) : null],
                ['Rate revisions', v.rate_revisions],
                ['Parcels', v.parcels],
              ] },
              { title: 'Committee', items: [
                ['Committee reference', v.committee_ref],
                ['Meeting date', v.meeting_date ? fmtDate(v.meeting_date) : null],
                ['Remarks', v.remarks, true],
              ] },
            ]}
            actions={<div className="acts">
              {canEdit(v) && v.stage_code !== 'Stopped' && (
                <button onClick={() => { setFormError(null); setFix(v); setFixForm({ fixed_rate: v.fixed_rate ?? '', committee_ref: v.committee_ref ?? '', meeting_date: v.meeting_date?.slice(0, 10) ?? '' }); setViewId(null); }}>Record rate</button>
              )}
              <WorkflowActions workflow="dbpfc" resource="/api/dbpfc" record={{ ...v, id: v.dbpfc_id, code: v.dbpfc_code }} can={canEdit(v)} />
            </div>}>
            {changes.length > 0 && (<>
              <div className="sec-t">Rate changes</div>
              <Table caption="Rate changes for this estimate" head={<><th className="num">Estimated</th><th className="num">Fixed</th><th>Changed</th><th>By</th><th>Note</th></>}>
                {changes.map((h) => (
                  <tr key={h.id}>
                    <td className="num">{h.estimated_rate != null ? fmtNum(h.estimated_rate) : '—'}</td>
                    <td className="num">{h.fixed_rate != null ? fmtNum(h.fixed_rate) : '—'}</td>
                    <td>{new Date(h.changed_at).toLocaleString('en-GB')}</td>
                    <td>{h.changed_by_name || '—'}</td>
                    <td>{h.note || '—'}</td>
                  </tr>
                ))}
              </Table>
            </>)}
          </DetailsModal>
        );
      })()}

      <Card icon="receipt" title="Rate history" sub="Every change to an estimated or fixed rate, and who made it">
        <Table caption="DBPFC rate history" head={<><th>Estimate</th><th className="num">Estimated</th><th className="num">Fixed</th><th>Changed</th><th>By</th><th>Note</th></>}
          empty={history.length ? false : 'No rate changes recorded.'} colSpan={6}>
          {history.map((h) => (
            <tr key={h.id} {...(rows.some((r: any) => r.dbpfc_id === h.dbpfc_id) ? rowOpen(() => setViewId(h.dbpfc_id), `Show estimate ${h.dbpfc_code}`) : {})}>
              <td><span className="code">{h.dbpfc_code}</span></td>
              <td className="num">{h.estimated_rate != null ? fmtNum(h.estimated_rate) : '—'}</td>
              <td className="num">{h.fixed_rate != null ? fmtNum(h.fixed_rate) : '—'}</td>
              <td>{new Date(h.changed_at).toLocaleString('en-GB')}</td>
              <td>{h.changed_by_name || <span className="note">—</span>}</td>
              <td>{h.note || <span className="note">—</span>}</td>
            </tr>
          ))}
        </Table>
      </Card>

      <Modal open={open} icon="bldg" title="Add DBPFC Estimate" onClose={() => setOpen(false)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setOpen(false)}>Cancel</button>
          <button type="submit" form="dbpForm" className="btn btn-p" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </>}>
        <form id="dbpForm" onSubmit={create} className="fgrid">
          <Field label="Sindh project" required full htmlFor="dbProj">
            <select id="dbProj" required value={form.project_id} onChange={(e) => set('project_id')(e.target.value)}>
              <option value="">— Select project —</option>
              {sindhProjects.map((p: any) => <option key={p.project_id} value={p.project_id}>{p.project_code} — {p.project_name}</option>)}
            </select>
          </Field>
          <Field label="District" htmlFor="dbDist" hint="Leave empty to use the project's district">
            <select id="dbDist" value={form.district_id} onChange={(e) => set('district_id')(e.target.value)}>
              <option value="">— Project's district —</option>
              {districts.map((d: any) => <option key={d.admin_unit_id} value={d.admin_unit_id}>{d.name}</option>)}
            </select>
          </Field>
          <Field label="Area" required htmlFor="dbArea"><div className="area-in"><input id="dbArea" type="number" min="0.01" step="0.01" required value={form.area_acres} onChange={(e) => set('area_acres')(e.target.value)} /><span className="u">acres</span></div></Field>
          <Field label="Estimated rate (Rs / acre / year)" required htmlFor="dbRate"><input id="dbRate" type="number" min="1" step="1" required value={form.estimated_rate} onChange={(e) => set('estimated_rate')(e.target.value)} /></Field>
          <Field label="Committee reference" htmlFor="dbRef"><input id="dbRef" value={form.committee_ref} onChange={(e) => set('committee_ref')(e.target.value)} /></Field>
          <Field label="Meeting date" htmlFor="dbMeet"><input id="dbMeet" type="date" value={form.meeting_date} onChange={(e) => set('meeting_date')(e.target.value)} /></Field>
          <Field label="Remarks" full htmlFor="dbRem"><textarea id="dbRem" value={form.remarks} onChange={(e) => set('remarks')(e.target.value)} /></Field>
        </form>
      </Modal>

      <Modal open={!!fix} size="sm" icon="calc" title={`Record committee rate — ${fix?.dbpfc_code ?? ''}`} onClose={() => setFix(null)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setFix(null)}>Cancel</button>
          <button type="submit" form="fixForm" className="btn btn-p" disabled={busy}>{busy ? 'Saving…' : 'Save rate'}</button>
        </>}>
        <form id="fixForm" onSubmit={saveRate}>
          <p className="note u-mb-10">Estimated: Rs {fmtNum(fix?.estimated_rate)} / acre. Move the estimate to “Rate Fixed” separately once the notification is issued.</p>
          <Field label="Fixed rate (Rs / acre / year)" required htmlFor="fxRate"><input id="fxRate" type="number" min="1" step="1" required value={fixForm.fixed_rate} onChange={(e) => setFixForm((f) => ({ ...f, fixed_rate: e.target.value }))} /></Field>
          <Field label="Committee reference" htmlFor="fxRef"><input id="fxRef" value={fixForm.committee_ref} onChange={(e) => setFixForm((f) => ({ ...f, committee_ref: e.target.value }))} /></Field>
          <Field label="Meeting date" htmlFor="fxMeet"><input id="fxMeet" type="date" value={fixForm.meeting_date} onChange={(e) => setFixForm((f) => ({ ...f, meeting_date: e.target.value }))} /></Field>
        </form>
      </Modal>
    </>
  );
}
