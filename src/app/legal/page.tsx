'use client';

import React, { useState } from 'react';
import Shell, { useLMS } from '@/components/layout/Shell';
import { Card, Modal, Field, Stage, Table, Toolbar, SearchBox, Count, Loading, Kpi, fmtNum, fmtDate, Pager } from '@/components/legacy/ui';
import { useList, RefSelect, ProvinceSelect, useListQuery } from '@/components/legacy/data';
import { send, useApi } from '@/lib/client/api';
import { LoadError } from '@/components/auth/PageGuard';
import { useCan, useCanIn } from '@/lib/client/permissions';

export default function LegalPage() {
  return <Shell><LegalContent /></Shell>;
}

const EMPTY = { province_code: '', court_case_no: '', court: '', case_type: '', company_role: '', parties: '', project_id: '',
  filing_date: '', next_hearing: '', counsel: '', financial_exposure: '', stay_order: false, status: '', remarks: '' };

function LegalContent() {
  const { activeProvince } = useLMS();
  const can = useCan();
  const canIn = useCanIn();
  const lq = useListQuery();
  const list = useList('/api/legal', 'legal_cases', lq.params);
  const { rows, body, page, summary, loading, error } = list;
  const hearings: any[] = body?.hearings ?? [];
  const projects = useApi(can('projects:read') ? '/api/projects' : null).data?.projects ?? [];
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ...EMPTY });
  const [hearing, setHearing] = useState<any | null>(null);
  const [hForm, setHForm] = useState({ hearing_date: '', proceedings: '', next_date: '' });
  const [upd, setUpd] = useState<any | null>(null);
  const [uForm, setUForm] = useState({ status: '', stay_order: false, counsel: '', financial_exposure: '', lift_reason: '' });
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canEdit = (c: any) => canIn('legal:update', c?.province_code);
  const run = async (fn: () => Promise<unknown>, done: () => void) => {
    setBusy(true); setFormError(null);
    try { await fn(); done(); } catch (err: any) { setFormError(err.message); } finally { setBusy(false); }
  };

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    run(() => send('POST', '/api/legal', {
      ...form, project_id: form.project_id || undefined, filing_date: form.filing_date, next_hearing: form.next_hearing || undefined,
      financial_exposure: form.financial_exposure ? Number(form.financial_exposure) : undefined, case_type: form.case_type,
      counsel: form.counsel || undefined, remarks: form.remarks || undefined,
    }), () => { setOpen(false); setForm({ ...EMPTY }); });
  };
  const addHearing = (e: React.FormEvent) => {
    e.preventDefault();
    run(() => send('PUT', '/api/legal', { id: hearing.id, action: 'add_hearing', ...hForm, next_date: hForm.next_date || undefined }), () => setHearing(null));
  };
  const update = (e: React.FormEvent) => {
    e.preventDefault();
    run(() => send('PUT', '/api/legal', { id: upd.id, status: uForm.status || undefined, stay_order: uForm.stay_order,
      counsel: uForm.counsel, financial_exposure: uForm.financial_exposure, lift_reason: lifting ? uForm.lift_reason : undefined },
      { also: ['/api/payments'] }), () => setUpd(null));
  };
  // Lifting a stay in force (unticking it, or closing the case) needs the court's order; the server
  // records it and lifts the payment holds the stay placed.
  const CLOSED_STATUS = ['Decided — In Favour', 'Decided — Against', 'Settled', 'Withdrawn'];
  const inForce = (stay: boolean, status: string) => stay && !CLOSED_STATUS.includes(status);
  const lifting = !!upd && inForce(!!upd.stay_order, upd.status) && !inForce(uForm.stay_order, uForm.status);

  const shown = rows;   // searched and paged by the database

  return (
    <>
      {list.body && (
        <div className="kpis">
          <Kpi label="Cases" value={fmtNum(summary.total)} sub="court cases and petitions" />
          <Kpi label="Stay orders" value={fmtNum(summary.stay_orders)} sub="payments on hold" tone={summary.stay_orders ? 'd' : 'g'} />
          <Kpi label="Hearings in 14 days" value={fmtNum(summary.hearings_14d)} sub="next hearing date" tone={summary.hearings_14d ? 'w' : 'g'} />
          <Kpi label="Financial exposure" value={`Rs ${fmtNum(summary.exposure)}`} sub="claimed against the company" />
        </div>
      )}
      <Card icon="scale" title="Legal & Litigation" sub="Cases, hearings and stay orders · a stay order places a payment hold on the linked parcels and landowners">
        <LoadError {...list} what="legal cases" />
        {can('legal:create') && (
          <div className="bar"><button className="btn btn-p" onClick={() => { setFormError(null); setForm({ ...EMPTY, province_code: activeProvince !== 'ALL' ? activeProvince : '' }); setOpen(true); }}>+ Add Legal Case</button></div>
        )}
        <Toolbar>
          <SearchBox value={lq.q} onChange={lq.setQ} placeholder="Search code, case no., court, parties or project…" />
          <Count n={page?.total ?? shown.length} />
        </Toolbar>
        {loading ? <Loading what="legal cases" /> : (
          <Table caption="Legal cases"
            head={<><th>Case</th><th>Prov.</th><th>Court</th><th>Parties</th><th>Company is</th><th>Project</th><th>Next hearing</th>
              <th className="num">Exposure (Rs)</th><th>Stay</th><th>Status</th><th>Actions</th></>}
            empty={shown.length || error ? false : 'No legal cases.'} colSpan={11}>
            {shown.map((c: any) => (
              <tr key={c.id}>
                <td><span className="code">{c.code}</span><br /><small className="note mono">{c.court_case_no}</small></td>
                <td><span className="pill">{c.province_code}</span></td>
                <td>{c.court}{c.case_type && <><br /><small className="note">{c.case_type}</small></>}</td>
                <td>{c.parties}</td>
                <td>{c.company_role}</td>
                <td>{c.project_name || <span className="note">—</span>}</td>
                <td>{fmtDate(c.next_hearing)}<br /><small className="note">{fmtNum(c.hearing_count)} hearing(s)</small></td>
                <td className="num">{c.financial_exposure != null ? fmtNum(c.financial_exposure) : '—'}</td>
                <td>{c.stay_order ? <span className="b b-d">Stay order</span> : <span className="note">—</span>}</td>
                <td><Stage value={c.status} /></td>
                <td><div className="acts">
                  {canEdit(c) && <button onClick={() => { setFormError(null); setHearing(c); setHForm({ hearing_date: '', proceedings: '', next_date: '' }); }}>Hearing</button>}
                  {canEdit(c) && <button onClick={() => { setFormError(null); setUpd(c); setUForm({ status: c.status, stay_order: !!c.stay_order, counsel: c.counsel ?? '', financial_exposure: c.financial_exposure ?? '', lift_reason: '' }); }}>Update</button>}
                </div></td>
              </tr>
            ))}
          </Table>
        )}
        <Pager page={page} onOffset={lq.setOffset} />
      </Card>

      <Card icon="cal" title="Hearings" sub="Proceedings recorded per hearing">
        <Table caption="Hearings" head={<><th>Date</th><th>Case</th><th>Court</th><th>Proceedings</th><th>Next date</th></>}
          empty={hearings.length ? false : 'No hearings recorded.'} colSpan={5}>
          {hearings.map((h) => (
            <tr key={h.id}>
              <td>{fmtDate(h.hearing_date)}</td>
              <td><span className="code">{h.legal_code}</span><br /><small className="note mono">{h.court_case_no}</small></td>
              <td>{h.court}</td>
              <td>{h.proceedings || <span className="note">—</span>}</td>
              <td>{fmtDate(h.next_date)}</td>
            </tr>
          ))}
        </Table>
      </Card>

      <Modal open={!!hearing} size="sm" icon="cal" title={`Record hearing — ${hearing?.code ?? ''}`} onClose={() => setHearing(null)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setHearing(null)}>Cancel</button>
          <button type="submit" form="hrForm" className="btn btn-p" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </>}>
        <form id="hrForm" onSubmit={addHearing}>
          <Field label="Hearing date" required htmlFor="hrDate"><input id="hrDate" type="date" required value={hForm.hearing_date} onChange={(e) => setHForm((f) => ({ ...f, hearing_date: e.target.value }))} /></Field>
          <Field label="Proceedings" htmlFor="hrProc"><textarea id="hrProc" value={hForm.proceedings} onChange={(e) => setHForm((f) => ({ ...f, proceedings: e.target.value }))} /></Field>
          <Field label="Next date" htmlFor="hrNext" hint="Becomes the case's next hearing"><input id="hrNext" type="date" value={hForm.next_date} onChange={(e) => setHForm((f) => ({ ...f, next_date: e.target.value }))} /></Field>
        </form>
      </Modal>

      <Modal open={!!upd} size="sm" icon="scale" title={`Update case — ${upd?.code ?? ''}`} onClose={() => setUpd(null)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setUpd(null)}>Cancel</button>
          <button type="submit" form="updForm" className="btn btn-p" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </>}>
        <form id="updForm" onSubmit={update}>
          <Field label="Status" required htmlFor="upStatus"><RefSelect id="upStatus" required source="enum:legal_case.status" value={uForm.status} onChange={(v) => setUForm((f) => ({ ...f, status: v }))} /></Field>
          <div className="fg checks"><label htmlFor="upStay"><input id="upStay" type="checkbox" checked={uForm.stay_order} onChange={(e) => setUForm((f) => ({ ...f, stay_order: e.target.checked }))} /> Stay order in force (holds payments)</label></div>
          {lifting && (
            <Field label="Court order lifting the stay" required full htmlFor="upLift"
              hint="The order's reference and date, e.g. “Order of 12 Nov 2026 in C.P. 1234/2026, stay vacated”. Recorded in the audit trail; the payment holds from this stay are lifted. You may be asked to confirm your identity.">
              <textarea id="upLift" required minLength={10} value={uForm.lift_reason} onChange={(e) => setUForm((f) => ({ ...f, lift_reason: e.target.value }))} />
            </Field>
          )}
          <Field label="Counsel" htmlFor="upCounsel"><input id="upCounsel" value={uForm.counsel} onChange={(e) => setUForm((f) => ({ ...f, counsel: e.target.value }))} /></Field>
          <Field label="Financial exposure (Rs)" htmlFor="upExp"><input id="upExp" type="number" min="0" step="1" value={uForm.financial_exposure} onChange={(e) => setUForm((f) => ({ ...f, financial_exposure: e.target.value }))} /></Field>
        </form>
      </Modal>

      <Modal open={open} icon="scale" title="Add Legal Case" onClose={() => setOpen(false)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setOpen(false)}>Cancel</button>
          <button type="submit" form="lgForm" className="btn btn-p" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </>}>
        <form id="lgForm" onSubmit={create} className="fgrid">
          <Field label="Province" required htmlFor="lgProv"><ProvinceSelect id="lgProv" required value={form.province_code} onChange={(v) => setForm((f) => ({ ...f, province_code: v, project_id: '' }))} /></Field>
          <Field label="Court case no." required htmlFor="lgNo"><input id="lgNo" required value={form.court_case_no} onChange={(e) => setForm((f) => ({ ...f, court_case_no: e.target.value }))} /></Field>
          <Field label="Court" required htmlFor="lgCourt"><input id="lgCourt" required value={form.court} onChange={(e) => setForm((f) => ({ ...f, court: e.target.value }))} placeholder="e.g. Senior Civil Judge, Ghotki" /></Field>
          <Field label="Case type" required htmlFor="lgType"><input id="lgType" required value={form.case_type} onChange={(e) => setForm((f) => ({ ...f, case_type: e.target.value }))} placeholder="e.g. civil suit, constitutional petition" /></Field>
          <Field label="Company is" required htmlFor="lgRole"><RefSelect id="lgRole" required source="enum:legal_case.company_role" value={form.company_role} onChange={(v) => setForm((f) => ({ ...f, company_role: v }))} /></Field>
          <Field label="Status" required htmlFor="lgStatus"><RefSelect id="lgStatus" required source="enum:legal_case.status" value={form.status} onChange={(v) => setForm((f) => ({ ...f, status: v }))} /></Field>
          <Field label="Parties" required full htmlFor="lgParties"><input id="lgParties" required value={form.parties} onChange={(e) => setForm((f) => ({ ...f, parties: e.target.value }))} placeholder="e.g. Ghulam Qadir v. Mari Energies Ltd" /></Field>
          <Field label="Project" htmlFor="lgProj">
            <select id="lgProj" value={form.project_id} onChange={(e) => setForm((f) => ({ ...f, project_id: e.target.value }))}>
              <option value="">— None —</option>
              {projects.filter((p: any) => !form.province_code || p.province_code === form.province_code)
                .map((p: any) => <option key={p.project_id} value={p.project_id}>{p.project_code} — {p.project_name}</option>)}
            </select>
          </Field>
          <Field label="Filed on" required htmlFor="lgFiled"><input id="lgFiled" type="date" required value={form.filing_date} onChange={(e) => setForm((f) => ({ ...f, filing_date: e.target.value }))} /></Field>
          <Field label="Next hearing" htmlFor="lgNext"><input id="lgNext" type="date" value={form.next_hearing} onChange={(e) => setForm((f) => ({ ...f, next_hearing: e.target.value }))} /></Field>
          <Field label="Counsel" htmlFor="lgCounsel"><input id="lgCounsel" value={form.counsel} onChange={(e) => setForm((f) => ({ ...f, counsel: e.target.value }))} /></Field>
          <Field label="Financial exposure (Rs)" htmlFor="lgExp"><input id="lgExp" type="number" min="0" step="1" value={form.financial_exposure} onChange={(e) => setForm((f) => ({ ...f, financial_exposure: e.target.value }))} /></Field>
          <div className="fg full checks"><label htmlFor="lgStay"><input id="lgStay" type="checkbox" checked={form.stay_order} onChange={(e) => setForm((f) => ({ ...f, stay_order: e.target.checked }))} /> Stay order in force (holds payments)</label></div>
          <Field label="Remarks" full htmlFor="lgRem"><textarea id="lgRem" value={form.remarks} onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))} /></Field>
        </form>
      </Modal>
    </>
  );
}
