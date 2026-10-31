'use client';

import React, { useState } from 'react';
import Shell, { useLMS } from '@/components/layout/Shell';
import { Card, Modal, Field, Stage, Table, Toolbar, SearchBox, Count, Loading, Kpi, fmtNum, fmtDate, Pager } from '@/components/legacy/ui';
import { useList, RefSelect, WorkflowActions, ProvinceSelect, useListQuery } from '@/components/legacy/data';
import { send, useApi } from '@/lib/client/api';
import { LoadError } from '@/components/auth/PageGuard';
import { useCan, useCanIn } from '@/lib/client/permissions';
import { formatCNICInput } from '@/lib/domain';

export default function GrievancesPage() {
  return <Shell><GrievancesContent /></Shell>;
}

const EMPTY = { province_code: '', grievance_type: '', complainant: '', complainant_cnic: '', mobile: '', project_id: '',
  category_code: '', severity: '', channel: '', description: '', due_date: '' };

function GrievancesContent() {
  const { activeProvince } = useLMS();
  const can = useCan();
  const canIn = useCanIn();
  const lq = useListQuery();
  const list = useList('/api/grievances', 'grievances', lq.params);
  const { rows, page, summary, loading, error } = list;
  const projects = useApi(can('projects:read') ? '/api/projects' : null).data?.projects ?? [];
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ...EMPTY });
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof EMPTY) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setFormError(null);
    try {
      await send('POST', '/api/grievances', { ...form, project_id: form.project_id || undefined, due_date: form.due_date || undefined });
      setOpen(false); setForm({ ...EMPTY });
    } catch (err: any) { setFormError(err.message); } finally { setBusy(false); }
  };

  const shown = rows;   // searched and paged by the database

  return (
    <>
      {list.body && (
        <div className="kpis">
          <Kpi label="Grievances" value={fmtNum(summary.total)} sub="landowner and community complaints, IIR" />
          <Kpi label="Open" value={fmtNum(summary.open)} sub="not yet resolved" tone={summary.open ? 'w' : 'g'} />
          <Kpi label="Overdue" value={fmtNum(summary.overdue)} sub="past their due date" tone={summary.overdue ? 'd' : 'g'} />
          <Kpi label="High / critical" value={fmtNum(summary.high)} sub="severity" tone="w" />
        </div>
      )}
      <Card icon="warn" title="Grievances & IIR" sub="Registered → Assigned → In Progress → Resolved → Closed · due dates and escalation tracked">
        <LoadError {...list} what="grievances" />
        {can('grievances:create') && (
          <div className="bar"><button className="btn btn-p" onClick={() => { setFormError(null); setForm({ ...EMPTY, province_code: activeProvince !== 'ALL' ? activeProvince : '' }); setOpen(true); }}>+ Add Grievance</button></div>
        )}
        <Toolbar>
          <SearchBox value={lq.q} onChange={lq.setQ} placeholder="Search code, complainant, category or project…" />
          <Count n={page?.total ?? shown.length} />
        </Toolbar>
        {loading ? <Loading what="grievances" /> : (
          <Table caption="Grievances"
            head={<><th>Grievance</th><th>Prov.</th><th>Complainant</th><th>Category</th><th>Severity</th><th>Received</th><th>Due</th><th>Stage</th><th>Actions</th></>}
            empty={shown.length || error ? false : 'No grievances.'} colSpan={9}>
            {shown.map((g: any) => (
              <tr key={g.grievance_id}>
                <td><span className="code">{g.grievance_code}</span><br /><small className="note">{g.grievance_type}</small></td>
                <td><span className="pill">{g.province_code}</span></td>
                <td>{g.complainant}{g.mobile && <><br /><small className="note mono">{g.mobile}</small></>}</td>
                <td>{g.category_code}{g.project_code && <><br /><small className="note">{g.project_code}</small></>}</td>
                <td><span className={`b ${['High', 'Critical'].includes(g.severity) ? 'b-d' : g.severity === 'Medium' ? 'b-w' : 'b-n'}`}>{g.severity}</span></td>
                <td>{fmtDate(g.received_date)}</td>
                <td>{fmtDate(g.due_date)}{g.is_overdue && <><br /><span className="b b-d">Overdue</span></>}</td>
                <td><Stage value={g.stage_code} /></td>
                <td><div className="acts">
                  <WorkflowActions workflow="grievances" resource="/api/grievances" record={{ ...g, id: g.grievance_id, code: g.grievance_code }}
                    can={canIn('grievances:update', g.province_code)} />
                </div></td>
              </tr>
            ))}
          </Table>
        )}
        <Pager page={page} onOffset={lq.setOffset} />
      </Card>

      <Modal open={open} icon="warn" title="Add Grievance" onClose={() => setOpen(false)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setOpen(false)}>Cancel</button>
          <button type="submit" form="grvForm" className="btn btn-p" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </>}>
        <form id="grvForm" onSubmit={create} className="fgrid">
          <Field label="Province" required htmlFor="gProv"><ProvinceSelect id="gProv" required value={form.province_code} onChange={set('province_code')} /></Field>
          <Field label="Type" required htmlFor="gType"><RefSelect id="gType" required source="enum:grievance.grievance_type" value={form.grievance_type} onChange={set('grievance_type')} /></Field>
          <Field label="Complainant" required htmlFor="gName"><input id="gName" required value={form.complainant} onChange={(e) => set('complainant')(e.target.value)} /></Field>
          <Field label="Complainant CNIC" htmlFor="gCnic" hint="XXXXX-XXXXXXX-X"><input id="gCnic" className="mono" inputMode="numeric" autoComplete="off" maxLength={15} placeholder="12345-1234567-1" pattern="\d{5}-\d{7}-\d" value={form.complainant_cnic} onChange={(e) => set('complainant_cnic')(formatCNICInput(e.target.value))} /></Field>
          <Field label="Mobile" htmlFor="gMob"><input id="gMob" type="tel" value={form.mobile} onChange={(e) => set('mobile')(e.target.value)} /></Field>
          <Field label="Project" htmlFor="gProj">
            <select id="gProj" value={form.project_id} onChange={(e) => set('project_id')(e.target.value)}>
              <option value="">— None —</option>
              {projects.filter((p: any) => !form.province_code || p.province_code === form.province_code)
                .map((p: any) => <option key={p.project_id} value={p.project_id}>{p.project_code} — {p.project_name}</option>)}
            </select>
          </Field>
          <Field label="Category" required htmlFor="gCat"><RefSelect id="gCat" required source="lookup:grievance_category" value={form.category_code} onChange={set('category_code')} /></Field>
          <Field label="Severity" required htmlFor="gSev"><RefSelect id="gSev" required source="enum:grievance.severity" value={form.severity} onChange={set('severity')} /></Field>
          <Field label="Channel" htmlFor="gCh"><input id="gCh" value={form.channel} onChange={(e) => set('channel')(e.target.value)} placeholder="e.g. walk-in, phone, letter" /></Field>
          <Field label="Due date" htmlFor="gDue" hint="Leave empty for the standard 14 days"><input id="gDue" type="date" value={form.due_date} onChange={(e) => set('due_date')(e.target.value)} /></Field>
          <Field label="Description" required full htmlFor="gDesc"><textarea id="gDesc" required value={form.description} onChange={(e) => set('description')(e.target.value)} /></Field>
        </form>
      </Modal>
    </>
  );
}
