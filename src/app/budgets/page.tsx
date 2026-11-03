'use client';

import React, { useMemo, useState } from 'react';
import Shell from '@/components/layout/Shell';
import { Card, Modal, Field, Stage, Table, Toolbar, SearchBox, Count, Loading, Kpi, fmtNum, fmtRsM, Pager, rowOpen, DetailsModal } from '@/components/legacy/ui';
import { useList, useListQuery } from '@/components/legacy/data';
import { send, useApi } from '@/lib/client/api';
import { LoadError } from '@/components/auth/PageGuard';
import { useCan, useCanIn } from '@/lib/client/permissions';

export default function BudgetsPage() {
  return <Shell><BudgetsContent /></Shell>;
}

const thisYear = new Date().getFullYear();
const EMPTY = { project_id: '', fiscal_year: String(thisYear), approved_amount: '', approval_ref: '', remarks: '' };

function BudgetsContent() {
  const can = useCan();
  const canIn = useCanIn();
  const [fy, setFy] = useState('');
  const lq = useListQuery();
  const list = useList('/api/budgets', 'budgets', { fiscal_year: fy || undefined, ...lq.params });
  const { rows, body, page, summary, loading, error } = list;
  const projects = useApi(can('projects:read') ? '/api/projects' : null).data?.projects ?? [];
  const years: string[] = useMemo(() => (body?.fiscal_years ?? []).map(String), [body]);   // every year with a budget, from the database
  const [edit, setEdit] = useState<any | null>(null);   // {} = new, row = revise
  const [form, setForm] = useState({ ...EMPTY });
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<any | null>(null);
  const canCreate = can('budgets:create');
  const canEdit = (b: any) => canIn('budgets:update', b?.province_code);

  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setFormError(null);
    try {
      if (edit?.budget_id) {
        await send('PUT', '/api/budgets', { id: edit.budget_id, approved_amount: Number(form.approved_amount), approval_ref: form.approval_ref || undefined, remarks: form.remarks || undefined });
      } else {
        await send('POST', '/api/budgets', { project_id: form.project_id, fiscal_year: Number(form.fiscal_year), approved_amount: Number(form.approved_amount),
          approval_ref: form.approval_ref || undefined, remarks: form.remarks || undefined });
      }
      setEdit(null);
    } catch (err: any) { setFormError(err.message); } finally { setBusy(false); }
  };

  const openRevise = (b: any) => { setFormError(null); setForm({ ...EMPTY, approved_amount: b.approved_amount, remarks: b.remarks ?? '' }); setEdit(b); };

  const shown = rows;   // searched and paged by the database
  const sum = (k: string) => summary[k] ?? 0;

  return (
    <>
      {list.body && (
        <div className="kpis">
          <Kpi label="Approved" value={fmtRsM(sum('approved_amount'))} sub={fy ? `fiscal year ${fy}` : 'all fiscal years'} />
          <Kpi label="Released" value={fmtRsM(sum('released_amount'))} sub="cheques released" tone="g" />
          <Kpi label="Committed" value={fmtRsM(sum('committed_amount'))} sub="approved, not yet released" tone="w" />
          <Kpi label="Over budget" value={fmtNum(summary.over_budget)} sub="projects with a negative balance" tone={summary.over_budget ? 'd' : 'g'} />
        </div>
      )}
      <Card icon="trend" title="Budgets" sub="Approved, committed and released by project and fiscal year · utilisation from the payment ledger">
        <LoadError {...list} what="budgets" />
        {canCreate && <div className="bar">{can('projects:read')
          ? <button className="btn btn-p" onClick={() => { setFormError(null); setForm({ ...EMPTY }); setEdit({}); }}>+ Add Budget</button>
          : <button className="btn btn-p" disabled title="Adding a budget also needs read access to projects.">+ Add Budget</button>}</div>}
        <Toolbar>
          <SearchBox value={lq.q} onChange={lq.setQ} placeholder="Search budget, project or province…" />
          <select className="sel" aria-label="Fiscal year" value={fy} onChange={(e) => setFy(e.target.value)}>
            <option value="">All fiscal years</option>
            {years.map((y) => <option key={y}>{y}</option>)}
          </select>
          <Count n={page?.total ?? shown.length} />
        </Toolbar>
        {loading ? <Loading what="budgets" /> : (
          <Table caption="Budgets"
            head={<><th>Budget</th><th>Prov.</th><th>Project</th><th className="num">FY</th><th className="num">Approved (Rs)</th><th className="num">Committed (Rs)</th>
              <th className="num">Released (Rs)</th><th className="num">Balance (Rs)</th><th className="num">Used</th><th>Status</th><th>Actions</th></>}
            empty={shown.length || error ? false : 'No budgets.'} colSpan={11}>
            {shown.map((b: any) => (
              <tr key={b.budget_id} {...rowOpen(() => setView(b), `Show budget ${b.budget_code}`)}>
                <td><span className="code">{b.budget_code}</span></td>
                <td><span className="pill">{b.province_code}</span></td>
                <td>{b.project_name}<br /><small className="note mono">{b.project_code}</small></td>
                <td className="num">{b.fiscal_year}</td>
                <td className="num">{fmtNum(b.approved_amount)}</td>
                <td className="num">{fmtNum(b.committed_amount)}</td>
                <td className="num">{fmtNum(b.released_amount)}</td>
                <td className={`num${Number(b.balance_amount) < 0 ? ' u-danger' : ''}`}>{fmtNum(b.balance_amount)}</td>
                <td className="num">{fmtNum(b.utilisation_pct, 1)}%</td>
                <td><Stage value={b.budget_status} /></td>
                <td><div className="acts">{canEdit(b) && (
                  <button onClick={() => openRevise(b)}>Revise</button>
                )}</div></td>
              </tr>
            ))}
          </Table>
        )}
        <Pager page={page} onOffset={lq.setOffset} />
      </Card>

      {view && (
        <DetailsModal open icon="trend" onClose={() => setView(null)}
          title={<>Budget <span className="code">{view.budget_code}</span></>}
          sections={[
            { title: 'Budget', items: [
              ['Project', <>{view.project_name} <span className="code">{view.project_code}</span></>],
              ['Province', view.province_code],
              ['Fiscal year', view.fiscal_year],
              ['Status', <Stage value={view.budget_status} />],
              ['Remarks', view.remarks, true],
            ] },
            { title: 'Utilisation', items: [
              ['Approved (Rs)', fmtNum(view.approved_amount)],
              ['Committed (Rs)', fmtNum(view.committed_amount)],
              ['Released (Rs)', fmtNum(view.released_amount)],
              ['Balance (Rs)', <span className={Number(view.balance_amount) < 0 ? 'u-danger' : undefined}>{fmtNum(view.balance_amount)}</span>],
              ['Used', `${fmtNum(view.utilisation_pct, 1)}%`],
            ] },
          ]}
          actions={canEdit(view) && <button type="button" className="btn btn-s" onClick={() => { const b = view; setView(null); openRevise(b); }}>Revise</button>} />
      )}

      <Modal open={!!edit} size="sm" icon="trend" title={edit?.budget_id ? `Revise budget — ${edit.budget_code}` : 'Add Budget'} onClose={() => setEdit(null)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setEdit(null)}>Cancel</button>
          <button type="submit" form="bgForm" className="btn btn-p" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </>}>
        <form id="bgForm" onSubmit={save}>
          {!edit?.budget_id && (<>
            <Field label="Project" required htmlFor="bgProj">
              <select id="bgProj" required value={form.project_id} onChange={(e) => setForm((f) => ({ ...f, project_id: e.target.value }))}>
                <option value="">— Select project —</option>
                {projects.map((p: any) => <option key={p.project_id} value={p.project_id}>{p.project_code} — {p.project_name} ({p.province_code})</option>)}
              </select>
            </Field>
            <Field label="Fiscal year" required htmlFor="bgFy"><input id="bgFy" type="number" min="2000" max="2100" step="1" required value={form.fiscal_year} onChange={(e) => setForm((f) => ({ ...f, fiscal_year: e.target.value }))} /></Field>
          </>)}
          <Field label="Approved amount (Rs)" required htmlFor="bgAmt"><input id="bgAmt" type="number" min="0" step="1" required value={form.approved_amount} onChange={(e) => setForm((f) => ({ ...f, approved_amount: e.target.value }))} /></Field>
          <Field label="Approval reference" htmlFor="bgRef"><input id="bgRef" value={form.approval_ref} onChange={(e) => setForm((f) => ({ ...f, approval_ref: e.target.value }))} /></Field>
          <Field label="Remarks" htmlFor="bgRem"><textarea id="bgRem" value={form.remarks} onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))} /></Field>
        </form>
      </Modal>
    </>
  );
}
