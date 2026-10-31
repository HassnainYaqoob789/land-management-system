'use client';

import React, { useState } from 'react';
import Shell from '@/components/layout/Shell';
import { Card, Modal, Field, Stage, Table, Toolbar, SearchBox, Count, Loading, Kpi, fmtNum, fmtDate, Pager } from '@/components/legacy/ui';
import { useList, RefSelect, WorkflowActions, useListQuery, RecordPicker } from '@/components/legacy/data';
import { send } from '@/lib/client/api';
import { LoadError } from '@/components/auth/PageGuard';
import { useCan, useCanIn } from '@/lib/client/permissions';

export default function MutationsPage() {
  return <Shell><MutationsContent /></Shell>;
}

type Heir = { landowner_id: string; relation: string; share_pct: string };
const EMPTY = { mutation_type: '', transferor_id: '', death_date: '', remarks: '' };
const REVENUE = { revenue_mutation_no: '', mutation_date: '', revenue_office: '', certificate_no: '' };
/** A landowner in a picker: name and CNIC exactly as the server sent it (masked without pii:read). */
const ownerLabel = (l: { full_name?: string; cnic?: string | null }) => `${l.full_name ?? ''}${l.cnic ? ` (${l.cnic})` : ''}`;

function MutationsContent() {
  const can = useCan();
  const canIn = useCanIn();
  const lq = useListQuery();
  const list = useList('/api/mutations', 'mutations', lq.params);
  const { rows, page, summary, loading, error } = list;
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ...EMPTY });
  const [heirs, setHeirs] = useState<Heir[]>([]);
  const [rev, setRev] = useState<any | null>(null);
  const [revForm, setRevForm] = useState({ ...REVENUE });
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canEdit = (m: any) => canIn('mutations:update', m?.province_code);
  const [transferor, setTransferor] = useState<any | null>(null);   // the chosen landowner record
  const total = heirs.reduce((n, h) => n + Number(h.share_pct || 0), 0);
  const inheritance = /Inheritance/.test(form.mutation_type);

  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setFormError(null);
    if (heirs.length && Math.abs(total - 100) > 0.01) { setFormError(`Heir shares total ${total.toFixed(2)}%; they must total 100%.`); return; }
    setBusy(true);
    try {
      await send('POST', '/api/mutations', {
        mutation_type: form.mutation_type, transferor_id: form.transferor_id, death_date: form.death_date || undefined,
        remarks: form.remarks || undefined,
        heirs: heirs.filter((h) => h.landowner_id).map((h) => ({ landowner_id: h.landowner_id, relation: h.relation || undefined, share_pct: Number(h.share_pct) })),
      });
      setOpen(false); setForm({ ...EMPTY }); setHeirs([]);
    } catch (err: any) { setFormError(err.message); } finally { setBusy(false); }
  };

  const saveRevenue = async (e: React.FormEvent) => {
    e.preventDefault(); if (!rev) return; setBusy(true); setFormError(null);
    try {
      await send('PUT', '/api/mutations', { id: rev.id, ...Object.fromEntries(Object.entries(revForm).filter(([, v]) => v !== '')) });
      setRev(null);
    } catch (err: any) { setFormError(err.message); } finally { setBusy(false); }
  };

  const shown = rows;   // searched and paged by the database

  return (
    <>
      {list.body && (
        <div className="kpis">
          <Kpi label="Mutations" value={fmtNum(summary.total)} sub="succession, sale, gift, partition" />
          <Kpi label="Pending" value={fmtNum(summary.pending)} sub="not yet applied" tone={summary.pending ? 'w' : 'g'} />
          <Kpi label="Applied" value={fmtNum(summary.applied)} sub="shares transferred" tone="g" />
        </div>
      )}
      <Card icon="repeat" title="Mutation & Succession"
        sub="Initiated → Revenue Verified → Legal Cleared → Approved & Applied · on approval the owner shares move to the heirs or transferees">
        <LoadError {...list} what="mutations" />
        {can('mutations:create') && (
          <div className="bar"><button className="btn btn-p" onClick={() => { setFormError(null); setForm({ ...EMPTY }); setHeirs([]); setOpen(true); }}>+ Add Mutation</button></div>
        )}
        <Toolbar>
          <SearchBox value={lq.q} onChange={lq.setQ} placeholder="Search code, transferor, CNIC, type or revenue no.…" />
          <Count n={page?.total ?? shown.length} />
        </Toolbar>
        {loading ? <Loading what="mutations" /> : (
          <Table caption="Mutations"
            head={<><th>Mutation</th><th>Prov.</th><th>Type</th><th>Transferor</th><th>Surveys</th><th className="num">Heirs</th>
              <th>Revenue mutation</th><th>Certificate</th><th>Stage</th><th>Actions</th></>}
            empty={shown.length || error ? false : 'No mutations.'} colSpan={10}>
            {shown.map((m: any) => (
              <tr key={m.id}>
                <td><span className="code">{m.code}</span></td>
                <td><span className="pill">{m.province_code}</span></td>
                <td>{m.mutation_type}</td>
                <td>{m.transferor_name}<br /><small className="note mono">{m.transferor_cnic}</small>{m.death_date && <><br /><small className="note">d. {fmtDate(m.death_date)}</small></>}</td>
                <td>{m.survey_numbers || <span className="note">—</span>}</td>
                <td className="num">{fmtNum(m.heir_count)}{Number(m.heir_count) > 0 && <><br /><span className={`b ${Math.abs(Number(m.heir_share_total) - 100) < 0.01 ? 'b-g' : 'b-w'}`}>{Number(m.heir_share_total)}%</span></>}</td>
                <td>{m.revenue_mutation_no || <span className="note">—</span>}{m.mutation_date && <><br /><small className="note">{fmtDate(m.mutation_date)}</small></>}</td>
                <td>{m.certificate_no || <span className="note">—</span>}</td>
                <td><Stage value={m.stage_code} /></td>
                <td><div className="acts">
                  {canEdit(m) && !['Approved & Applied', 'Cancelled'].includes(m.stage_code) && (
                    <button onClick={() => { setFormError(null); setRev(m); setRevForm({ revenue_mutation_no: m.revenue_mutation_no ?? '', mutation_date: m.mutation_date?.slice(0, 10) ?? '', revenue_office: m.revenue_office ?? '', certificate_no: m.certificate_no ?? '' }); }}>Revenue record</button>
                  )}
                  <WorkflowActions workflow="mutations" resource="/api/mutations" record={m} can={canEdit(m)} />
                </div></td>
              </tr>
            ))}
          </Table>
        )}
        <Pager page={page} onOffset={lq.setOffset} />
      </Card>

      <Modal open={!!rev} size="sm" icon="file" title={`Revenue record — ${rev?.code ?? ''}`} onClose={() => setRev(null)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setRev(null)}>Cancel</button>
          <button type="submit" form="revForm" className="btn btn-p" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </>}>
        <form id="revForm" onSubmit={saveRevenue}>
          <p className="note u-mb-10">The revenue mutation number is needed before verification; an inheritance also needs the succession certificate before legal clearance.</p>
          <Field label="Revenue mutation no." htmlFor="rvNo"><input id="rvNo" value={revForm.revenue_mutation_no} onChange={(e) => setRevForm((f) => ({ ...f, revenue_mutation_no: e.target.value }))} /></Field>
          <Field label="Mutation date" htmlFor="rvDate"><input id="rvDate" type="date" value={revForm.mutation_date} onChange={(e) => setRevForm((f) => ({ ...f, mutation_date: e.target.value }))} /></Field>
          <Field label="Revenue office" htmlFor="rvOff"><input id="rvOff" value={revForm.revenue_office} onChange={(e) => setRevForm((f) => ({ ...f, revenue_office: e.target.value }))} /></Field>
          <Field label="Succession certificate no." htmlFor="rvCert"><input id="rvCert" value={revForm.certificate_no} onChange={(e) => setRevForm((f) => ({ ...f, certificate_no: e.target.value }))} /></Field>
        </form>
      </Modal>

      <Modal open={open} size="lg" icon="repeat" title="Add Mutation" onClose={() => setOpen(false)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setOpen(false)}>Cancel</button>
          <button type="submit" form="mutForm" className="btn btn-p" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </>}>
        <form id="mutForm" onSubmit={create} className="fgrid">
          <Field label="Type" required htmlFor="mtType"><RefSelect id="mtType" required source="enum:mutation.mutation_type" value={form.mutation_type} onChange={(v) => setForm((f) => ({ ...f, mutation_type: v }))} /></Field>
          <Field label="Transferor (current owner)" required htmlFor="mtFrom">
            <RecordPicker id="mtFrom" resource="/api/landowners" rowsKey="landowners" label="Transferor" required value={form.transferor_id}
              idOf={(l) => l.id} optionLabel={(l) => `${ownerLabel(l)}${l.is_deceased ? ' — deceased' : ''}`}
              allowDeceased onChange={(id, l) => { setForm((f) => ({ ...f, transferor_id: id })); setTransferor(l ?? null); }} />
          </Field>
          {inheritance && (
            <Field label="Date of death" required htmlFor="mtDeath"><input id="mtDeath" type="date" required value={form.death_date} onChange={(e) => setForm((f) => ({ ...f, death_date: e.target.value }))} /></Field>
          )}
          <div className="sec-t">{inheritance ? 'Legal heirs' : 'Transferees'} — shares must total 100%</div>
          <div className="fg full">
            <div className="sub">
              <table>
                <thead><tr><th>Landowner</th><th>Relation</th><th>Share %</th><th aria-label="Remove" /></tr></thead>
                <tbody>
                  {heirs.length === 0 && <tr><td colSpan={4} className="empty">None yet. Shares are taken from all surveys the transferor holds.</td></tr>}
                  {heirs.map((h, i) => (
                    <tr key={i}>
                      <td><RecordPicker resource="/api/landowners" rowsKey="landowners" label="Heir" value={h.landowner_id}
                        filters={{ province: transferor?.province_code }} idOf={(l) => l.id} optionLabel={ownerLabel}
                        onChange={(id) => setHeirs((hs) => hs.map((x, j) => (j === i ? { ...x, landowner_id: id } : x)))} /></td>
                      <td><input aria-label="Relation" value={h.relation} placeholder={inheritance ? 'e.g. son, widow' : 'e.g. buyer'} onChange={(e) => setHeirs((hs) => hs.map((x, j) => (j === i ? { ...x, relation: e.target.value } : x)))} /></td>
                      <td><input aria-label="Share" type="number" min="0.01" max="100" step="0.01" value={h.share_pct} onChange={(e) => setHeirs((hs) => hs.map((x, j) => (j === i ? { ...x, share_pct: e.target.value } : x)))} /></td>
                      <td><button type="button" className="bx" aria-label="Remove" onClick={() => setHeirs((hs) => hs.filter((_, j) => j !== i))}>&times;</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="foot">
                <button type="button" className="btn btn-s btn-sm" onClick={() => setHeirs((hs) => [...hs, { landowner_id: '', relation: '', share_pct: '' }])}>+ Add {inheritance ? 'heir' : 'transferee'}</button>
                <span>Total <span className={`b ${heirs.length && Math.abs(total - 100) < 0.01 ? 'b-g' : 'b-w'}`}>{total.toFixed(2)}%</span></span>
              </div>
            </div>
          </div>
          <Field label="Remarks" full htmlFor="mtRem"><textarea id="mtRem" value={form.remarks} onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))} /></Field>
        </form>
      </Modal>
    </>
  );
}
