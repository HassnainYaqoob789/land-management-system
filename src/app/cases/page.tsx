'use client';

import React, { useState } from 'react';
import Shell, { useLMS } from '@/components/layout/Shell';
import { useList, useListQuery, RefSelect, WorkflowActions } from '@/components/legacy/data';
import { Card, Modal, Field, Stage, Table, Toolbar, SearchBox, Count, Loading, ErrorNote, WorkflowStrip, Pager, fmtNum, fmtDate, rowOpen } from '@/components/legacy/ui';
import CaseForm, { CaseDraft, emptyCase, preview, toBody } from '@/components/cases/CaseForm';
import { LoadError } from '@/components/auth/PageGuard';
import { ApiError, send, useApi, useReference, stagesOf } from '@/lib/client/api';
import { useCan, useCanIn } from '@/lib/client/permissions';
import { printDocument, escapeHtml } from '@/lib/client/print';
import { formatPKR } from '@/lib/domain';

export default function CasesPage() {
  return <Shell><CasesContent /></Shell>;
}

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** A saved case → the editable draft the form works on. */
function draftOf(detail: any): CaseDraft {
  const c = detail.case;
  return {
    project_id: s(c.project_id), land_use_code: s(c.land_use_code), lease_rate: s(c.lease_rate), lease_term_months: s(c.lease_term_months),
    case_remarks: s(c.case_remarks),
    owners: detail.owners.map((o: any) => ({ landowner_id: o.landowner_id, share_pct: s(o.share_pct), owner_status: s(o.owner_status).trim() || 'O', label: `${o.full_name}${o.cnic ? ` (${o.cnic})` : ''}` })),
    lease_lines: detail.lease_lines.map((l: any) => ({ survey_id: l.survey_id, survey_share_pct: s(l.survey_share_pct), lease_area: s(l.lease_area), subsequent_area: s(l.subsequent_area), survey_label: `${l.survey_code} · ${l.survey_no}` })),
    crop_lines: detail.crop_lines.map((l: any) => ({ survey_id: s(l.survey_id), crop_type: s(l.crop_type), rate_per_acre: s(l.rate_per_acre), damage_area: s(l.damage_area), survey_label: l.survey_no ?? undefined })),
    tree_lines: detail.tree_lines.map((l: any) => ({ survey_id: s(l.survey_id), species_code: s(l.species_code), size: s(l.size), rate: s(l.rate), qty: s(l.qty), survey_label: l.survey_no ?? undefined })),
    misc_lines: detail.misc_lines.map((l: any) => ({ survey_id: s(l.survey_id), payment_type: s(l.payment_type), amount: s(l.amount), survey_label: l.survey_no ?? undefined })),
    checked_documents: [],
  };
}

/** What the form can check before the database does. */
function problem(d: CaseDraft, creating: boolean): string | null {
  if (creating && !d.project_id) return 'Choose the project.';
  if (!d.land_use_code) return 'Choose what the land is used for.';
  if (!d.owners.length) return 'Add at least one landowner.';
  if (d.owners.some((o) => !o.landowner_id)) return 'Choose a landowner on every owner line.';
  if (new Set(d.owners.map((o) => o.landowner_id)).size !== d.owners.length) return 'A landowner is listed twice.';
  if (Math.abs(preview(d).shares - 100) > 0.001) return `Owner shares total ${preview(d).shares.toFixed(2)}%; they must total 100%.`;
  if (d.lease_lines.length && (d.lease_rate === '' || d.lease_term_months === '')) return 'Lease lines need a lease rate and term.';
  return null;
}

/**
 * The award sheet as a printable document (UX-03): the case itself, not the
 * screen behind the dialog. Every value is escaped; CNICs are printed exactly as
 * the server returned them (masked unless the user holds pii:read).
 */
function awardSheetHtml(dt: any, stages: string[], lockAt: string | null): string {
  const e = (v: unknown) => escapeHtml(v === null || v === undefined || v === '' ? '—' : String(v));
  const rs = (v: unknown) => e(v === null || v === undefined ? '—' : formatPKR(Number(v)));
  const c = dt.case;
  const table = (head: string[], rows: string[][], right: number[] = []) =>
    `<table><tr>${head.map((h) => `<th>${e(h)}</th>`).join('')}</tr>${rows.length
      ? rows.map((r) => `<tr>${r.map((x, i) => `<td${right.includes(i) ? ' class="r"' : ''}>${x}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${head.length}">—</td></tr>`}</table>`;
  const kv = (pairs: [string, string][]) => `<div class="kv">${pairs.map(([k, v]) => `<span>${e(k)}:</span><b>${v}</b>`).join('')}</div>`;
  const signedAt = (stage: string) => {
    const t = [...(dt.transitions ?? [])].reverse().find((x: any) => x.to_stage === stage);
    return t ? `${e(t.acted_by_name)} · ${e(fmtDate(t.acted_at))}` : '&nbsp;';
  };
  const final = !!lockAt && c.stage_code === lockAt;
  const mark = final ? '' : `<div class="p-watermark">${c.stage_code === 'Cancelled' ? 'CANCELLED' : `DRAFT — ${e(String(c.stage_code ?? '').toUpperCase())}`}</div>`;
  const lines = (title: string, rows: any[], head: string[], cells: (l: any) => string[], right: number[]) =>
    rows?.length ? `<div class="band">${e(title)}</div>${table(head, rows.map(cells), right)}` : '';
  return [
    mark,
    kv([['Case No', e(c.case_code)], ['Case date', e(fmtDate(c.case_date))], ['Project', `${e(c.project_code)} · ${e(c.project_name)}`],
      ['Province', e(c.province_code)], ['Land used for', e(c.land_use_code)], ['Status', e(c.stage_code)],
      ['Waiting on', e(c.waiting_on_group)], ['Prepared by', `${e(c.created_by_name)} · ${e(fmtDate(c.created_at))}`]]),
    `<div class="band">LANDOWNER DETAILS</div>`,
    table(['Code', 'Landowner', 'CNIC', 'Tax status', 'Share %'],
      (dt.owners ?? []).map((o: any) => [e(o.landowner_code), e(o.full_name), e(o.cnic), e(o.tax_status), e(Number(o.share_pct).toFixed(2))]), [4]),
    lines('LEASE DETAILS (areas in acres)', dt.lease_lines, ['#', 'Survey', "Owners' share %", 'Lease area', 'Reduced area'],
      (l) => [e(l.line_no), `${e(l.survey_code)} · ${e(l.survey_no)}`, e(l.survey_share_pct), e(fmtNum(l.lease_area, 4)), l.subsequent_area != null ? e(fmtNum(l.subsequent_area, 4)) : '—'], [2, 3, 4]),
    dt.lease_lines?.length ? kv([['Total lease area', `${e(fmtNum(c.total_lease_area, 4))} ac`], ['Rate / acre / year', rs(c.lease_rate)],
      ['Lease term', `${e(c.lease_term_months)} month(s)`], ['Lease amount', rs(c.total_lease_amount)]]) : '',
    lines('CROP DETAILS', dt.crop_lines, ['Survey', 'Crop', 'Rate / acre (Rs)', 'Damaged area (ac)', 'Amount'],
      (l) => [e(l.survey_no), e(l.crop_type), e(fmtNum(l.rate_per_acre)), e(fmtNum(l.damage_area, 4)), rs(l.amount)], [2, 3, 4]),
    lines('TREE DETAILS', dt.tree_lines, ['Survey', 'Species', 'Size', 'Rate (Rs)', 'Count', 'Amount'],
      (l) => [e(l.survey_no), e(l.species_name), e(l.size), e(fmtNum(l.rate)), e(fmtNum(l.qty)), rs(l.amount)], [3, 4, 5]),
    lines('OTHER COMPENSATION', dt.misc_lines, ['Survey', 'For', 'Amount'], (l) => [e(l.survey_no), e(l.payment_type), rs(l.amount)], [2]),
    `<div class="band">VALUATION</div>`,
    table(['Head', 'Amount'], [['Surface lease', rs(c.total_lease_amount)], ['Crops', rs(c.total_crop_amount)], ['Trees', rs(c.total_tree_amount)],
      ['Other', rs(c.total_misc_amount)], ['<b>Total compensation payable</b>', `<b>${rs(c.total_amount)}</b>`]], [1]),
    `<div class="band">APPROVAL HISTORY</div>`,
    table(['Step', 'By', 'As', 'When', 'Note'], (dt.transitions ?? []).map((t: any) => [
      t.from_stage ? `${e(t.from_stage)} → ${e(t.to_stage)}` : e(t.to_stage), e(t.acted_by_name), e(t.acted_as_group),
      e(new Date(t.acted_at).toLocaleString('en-GB')), e(t.note)])),
    `<div class="sig"><div>PREPARED BY<br>${e(c.created_by_name)} · ${e(fmtDate(c.created_at))}</div>${stages.slice(1)
      .map((st) => `<div>${e(st.toUpperCase())}<br>${signedAt(st)}</div>`).join('')}</div>`,
  ].join('');
}

/** "-1,500.50" → "-1500.50"; null when it is not a non-zero amount with at most 2 decimals. */
function signedAmount(v: string): string | null {
  const t = v.replace(/[,\s]/g, '').replace(/^\+/, '');
  if (!/^-?\d{1,13}(\.\d{1,2})?$/.test(t) || Number(t) === 0) return null;
  return t;
}

function CasesContent() {
  const { currentUser } = useLMS();
  const ref = useReference();
  const can = useCan();
  const canIn = useCanIn();
  // Creating needs the lookups the form searches, not only cases:create.
  const createNeeds = ['cases:create', 'projects:read', 'landowners:read', 'surveys:read'];
  const canCreate = can('cases:create');
  const [stage, setStage] = useState('');
  const lq = useListQuery();
  const list = useList('/api/cases', 'cases', { stage, ...lq.params });
  const { rows: cases, body, page, loading, error } = list;
  const documentItems: any[] = body?.document_items ?? [];
  const species: any[] = body?.tree_species ?? [];
  const projects = useList(can('projects:read') ? '/api/projects' : '', 'projects').rows;

  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useApi<any>(openId ? `/api/cases?id=${openId}` : null);
  const dt = detail.data;
  const [form, setForm] = useState<{ mode: 'create' | 'edit'; draft: CaseDraft } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adjust, setAdjust] = useState<{ amount: string; reason: string; confirming: boolean } | null>(null);
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const firstStage = stagesOf(ref, 'cases')[0];
  const shown = cases;   // searched and paged by the database

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    const p = problem(form.draft, form.mode === 'create');
    if (p) { setFormError(p); return; }
    setBusy(true); setFormError(null);
    try {
      const b = toBody(form.draft);
      if (form.mode === 'create') {
        const r = await send<any>('POST', '/api/cases', b, { also: ['/api/projects'] });
        setForm(null);
        if (r.case?.id) setOpenId(r.case.id);
      } else {
        const { project_id: _p, checked_documents: _c, ...rest } = b; void _p; void _c;
        await send('PUT', '/api/cases', { id: openId, ...rest });
        setForm(null);
      }
    } catch (err: any) { setFormError(err.message); } finally { setBusy(false); }
  };

  const toggleDoc = async (code: string, checked: boolean) => {
    setFormError(null);
    try { await send('PUT', '/api/cases', { id: openId, action: 'toggle_doc', item_code: code, checked }); }
    catch (err: any) { setFormError(err.message); }
  };

  const c = dt?.case;
  const lockAt = ref?.workflows.cases?.lockAt ?? null;
  // Approving and adjusting need cases:approve in the case's province (UI-05); the server
  // also checks the approval position and separation of duties.
  const canApproveHere = !!c && canIn('cases:approve', c.province_code);
  const canUpdateHere = !!c && canIn('cases:update', c.province_code);
  const editable = canUpdateHere && c.stage_code === firstStage;
  const adjustable = canApproveHere && !!lockAt && c.stage_code === lockAt;
  // Separation of duties (api.adjust_case): whoever prepared the case cannot adjust its award.
  const adjustBlocked = adjustable && !!currentUser && c.created_by === currentUser.id
    ? 'You prepared this case; another approver must adjust its award.' : null;

  const openAdjust = () => { setAdjustError(null); setNotice(null); setAdjust({ amount: '', reason: '', confirming: false }); };
  const reviewAdjust = (e: React.FormEvent) => {
    e.preventDefault();
    if (!adjust) return;
    if (!signedAmount(adjust.amount)) { setAdjustError('Enter the change in rupees: a non-zero amount, negative to reduce the award, at most 2 decimals.'); return; }
    if (adjust.reason.trim().length < 10) { setAdjustError('Give the reason for the adjustment (at least 10 characters).'); return; }
    setAdjustError(null); setAdjust({ ...adjust, confirming: true });
  };
  const postAdjust = async () => {
    if (!adjust || !c) return;
    const amount = signedAmount(adjust.amount);
    if (!amount) return;
    setBusy(true); setAdjustError(null);
    try {
      await send('POST', `/api/cases/${encodeURIComponent(c.case_id)}/adjustments`, { amount, reason: adjust.reason.trim() },
        { also: ['/api/payments', '/api/reports', '/api/landowners'] });
      setAdjust(null);
      setNotice(`Adjustment of ${formatPKR(Math.abs(Number(amount)))} (${Number(amount) < 0 ? 'reduction' : 'increase'}) recorded on ${c.case_code}.`);
    } catch (err: any) {
      setAdjustError(err instanceof ApiError && err.status === 409
        ? `This award cannot be adjusted in its current state: ${err.message}`
        : err.message);
      setAdjust((a) => a && { ...a, confirming: false });
    } finally { setBusy(false); }
  };
  const printAward = () => {
    if (!dt?.case) return;
    printDocument({
      title: `Compensation Case — Award Sheet`,
      subtitle: `${dt.case.project_code ?? ''} · ${dt.case.project_name ?? ''}`,
      meta: [['Case No', String(dt.case.case_code ?? '')], ['Province', String(dt.case.province_code ?? '')], ['Stage', String(dt.case.stage_code ?? '')]],
      bodyHtml: awardSheetHtml(dt, stagesOf(ref, 'cases'), lockAt),
      classification: 'Confidential',
    });
  };

  return (
    <>
      <Card icon="doc" title="Compensation Cases"
        sub={`${stagesOf(ref, 'cases').join(' → ') || 'Loading stages…'} · each step by a different approval position · locked once approved`}>
        <LoadError {...list} what="compensation cases" />
        {canCreate && (
          <div className="bar">
            {can(createNeeds)
              ? <button className="btn btn-p" onClick={() => { setFormError(null); setForm({ mode: 'create', draft: emptyCase() }); }}>+ Add Compensation Case</button>
              : <button className="btn btn-p" disabled title="Creating a case also needs read access to projects, landowners and surveys.">+ Add Compensation Case</button>}
          </div>
        )}
        <Toolbar>
          <SearchBox value={lq.q} onChange={lq.setQ} placeholder="Search case, project, owner or position…" />
          <RefSelect label="Stage" source="stages:cases" all="All stages" value={stage} onChange={(v) => { setStage(v); lq.setOffset(0); }} />
          <Count n={page?.total ?? shown.length} />
        </Toolbar>
        {loading ? <Loading what="cases" /> : (
          <Table caption="Compensation cases"
            head={<><th>Case no.</th><th>Prov.</th><th>Project</th><th>Land used for</th><th className="num">Owners</th><th className="num">Total (Rs)</th>
              <th>Stage</th><th>Waiting on</th><th>Settlement</th><th>Actions</th></>}
            empty={shown.length || error ? false : `No cases${lq.q || stage ? ' match the filter' : ' yet'}.`} colSpan={10}>
            {shown.map((r: any) => (
              <tr key={r.case_id} {...rowOpen(() => { setFormError(null); setOpenId(r.case_id); }, `Open case ${r.case_code}`)}>
                <td><span className="code">{r.case_code}</span><br /><small className="note">{fmtDate(r.case_date)}</small></td>
                <td><span className="pill">{r.province_code}</span></td>
                <td>{r.project_name}</td>
                <td>{r.land_use_code}</td>
                <td className="num">{fmtNum(r.owner_count)}</td>
                <td className="num">{fmtNum(r.total_amount)}</td>
                <td><Stage value={r.stage_code} />{Number(r.days_at_stage) > 0 && <><br /><small className="note">{r.days_at_stage} d at stage</small></>}</td>
                <td>{r.waiting_on_group || <span className="note">—</span>}</td>
                <td>{Number(r.released_amount || 0) > 0
                  ? <span className="b b-g">{formatPKR(Number(r.released_amount))} paid</span>
                  : <span className="note">Unreleased</span>}</td>
                <td><div className="acts"><button title={`Open case ${r.case_code}`} onClick={(e) => { e.stopPropagation(); setFormError(null); setOpenId(r.case_id); }}>Open</button></div></td>
              </tr>
            ))}
          </Table>
        )}
        <Pager page={page} onOffset={lq.setOffset} />
      </Card>

      <Modal open={!!openId && !form && !adjust} size="lg" icon="doc" title={<>Compensation case {c && <span className="code">{c.case_code}</span>}</>} onClose={() => { setOpenId(null); setNotice(null); }}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          {editable && <button className="btn btn-s" onClick={() => { setFormError(null); setForm({ mode: 'edit', draft: draftOf(dt) }); }}>Edit valuation</button>}
          {adjustable && <button className="btn btn-s" onClick={openAdjust} disabled={!!adjustBlocked} title={adjustBlocked ?? 'Record an enhancement, decree or correction against the approved award'}>Adjust award</button>}
          {c && <button className="btn btn-s" onClick={printAward}>Print award sheet</button>}
          <span className="u-flex-1" />
          <button className="btn btn-p" onClick={() => { setOpenId(null); setNotice(null); }}>Close</button>
        </>}>
        {detail.error ? <LoadError error={detail.error} status={detail.status} code={detail.code} what="this case" /> : !c ? <Loading what="case" /> : (<>
          {notice && <div className="al i" role="status"><span className="i" /><div className="tx">{notice}</div></div>}
          <div className="dl">
            <div><small>Project</small><span>{c.project_code} · {c.project_name}</span></div>
            <div><small>Province</small><span>{c.province_code}</span></div>
            <div><small>Land used for</small><span>{c.land_use_code}</span></div>
            <div><small>Stage</small><span><Stage value={c.stage_code} /></span></div>
            <div><small>Waiting on</small><span>{c.waiting_on_group || '—'}</span></div>
            <div><small>Prepared by</small><span>{c.created_by_name || '—'} · {fmtDate(c.created_at)}</span></div>
          </div>
          <WorkflowStrip stages={stagesOf(ref, 'cases')} current={c.stage_code} />
          <div className="bar u-mt-12"><div className="acts"><WorkflowActions workflow="cases" resource="/api/cases" record={c} idField="case_id" can={canApproveHere} /></div></div>

          <div className="grid2 u-mt-16">
            <div>
              <div className="sec-t">Valuation</div>
              <div className="tw u-mt-8"><table className="t"><tbody>
                <tr><td>Surface lease ({dt.lease_lines.length} line(s), {fmtNum(c.total_lease_area, 4)} ac{c.lease_rate != null ? ` @ Rs ${fmtNum(c.lease_rate)}/ac/yr × ${c.lease_term_months ?? '—'} mo` : ''})</td><td className="num">{formatPKR(Number(c.total_lease_amount))}</td></tr>
                <tr><td>Crops ({dt.crop_lines.length} line(s))</td><td className="num">{formatPKR(Number(c.total_crop_amount))}</td></tr>
                <tr><td>Trees ({dt.tree_lines.length} line(s))</td><td className="num">{formatPKR(Number(c.total_tree_amount))}</td></tr>
                <tr><td>Other ({dt.misc_lines.length} line(s))</td><td className="num">{formatPKR(Number(c.total_misc_amount))}</td></tr>
              </tbody><tfoot><tr><td>Total payable</td><td className="num">{formatPKR(Number(c.total_amount))}</td></tr></tfoot></table></div>
            </div>
            <div>
              <div className="sec-t">Landowners</div>
              <div className="u-mt-8">
                {dt.owners.length === 0 && <div className="empty">No landowners on this case.</div>}
                {dt.owners.map((o: any) => (
                  <div key={o.id} className="att">
                    <div className="nm">{o.full_name}<small className="mono">{o.landowner_code} · {o.cnic}</small></div>
                    <span className={`b ${o.tax_status === 'Non-Filer' ? 'b-w' : 'b-g'}`}>{o.tax_status || '—'}</span>
                    <span className="pill">{Number(o.share_pct).toFixed(2)}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {dt.lease_lines.length > 0 && (<>
            <div className="sec-t u-mt-16">Lease lines</div>
            <Table caption="Lease lines" head={<><th>#</th><th>Survey</th><th className="num">Owners' share %</th><th className="num">Area (ac)</th><th className="num">Reduced area (ac)</th></>} colSpan={5}>
              {dt.lease_lines.map((l: any) => <tr key={l.id}><td>{l.line_no}</td><td>{l.survey_code} · {l.survey_no}</td><td className="num">{l.survey_share_pct ?? '—'}</td><td className="num">{fmtNum(l.lease_area, 4)}</td><td className="num">{l.subsequent_area != null ? fmtNum(l.subsequent_area, 4) : '—'}</td></tr>)}
            </Table>
          </>)}
          {dt.crop_lines.length > 0 && (<>
            <div className="sec-t u-mt-16">Crop lines</div>
            <Table caption="Crop lines" head={<><th>Survey</th><th>Crop</th><th className="num">Rate (Rs/ac)</th><th className="num">Damaged (ac)</th><th className="num">Amount</th></>} colSpan={5}>
              {dt.crop_lines.map((l: any) => <tr key={l.id}><td>{l.survey_no || '—'}</td><td>{l.crop_type}</td><td className="num">{fmtNum(l.rate_per_acre)}</td><td className="num">{fmtNum(l.damage_area, 4)}</td><td className="num">{l.amount != null ? formatPKR(Number(l.amount)) : '—'}</td></tr>)}
            </Table>
          </>)}
          {dt.tree_lines.length > 0 && (<>
            <div className="sec-t u-mt-16">Tree lines</div>
            <Table caption="Tree lines" head={<><th>Survey</th><th>Species</th><th>Size</th><th className="num">Rate</th><th className="num">Count</th><th className="num">Amount</th></>} colSpan={6}>
              {dt.tree_lines.map((l: any) => <tr key={l.id}><td>{l.survey_no || '—'}</td><td>{l.species_name}</td><td>{l.size}</td><td className="num">{fmtNum(l.rate)}</td><td className="num">{fmtNum(l.qty)}</td><td className="num">{l.amount != null ? formatPKR(Number(l.amount)) : '—'}</td></tr>)}
            </Table>
          </>)}
          {dt.misc_lines.length > 0 && (<>
            <div className="sec-t u-mt-16">Other compensation</div>
            <Table caption="Other compensation" head={<><th>Survey</th><th>For</th><th className="num">Amount</th></>} colSpan={3}>
              {dt.misc_lines.map((l: any) => <tr key={l.id}><td>{l.survey_no || '—'}</td><td>{l.payment_type}</td><td className="num">{formatPKR(Number(l.amount))}</td></tr>)}
            </Table>
          </>)}

          <div className="sec-t u-mt-16">Document checklist</div>
          <div className="grid2 u-mt-8">
            {dt.document_checks.map((d: any) => {
              const checked = !!d.checked_at;
              return (
                <label key={d.code} className="att">
                  <input type="checkbox" checked={checked} disabled={!canUpdateHere} title={canUpdateHere ? undefined : 'Recording documents needs cases:update in this province'}
                    onChange={() => toggleDoc(d.code, !checked)} />
                  <div className="nm">{d.name}<small>{d.required_when === 'always' ? 'Required' : `Required when: ${d.required_when}`}{checked && d.checked_by_name ? ` · seen by ${d.checked_by_name}, ${fmtDate(d.checked_at)}` : ''}</small></div>
                  <span className={`b ${checked ? 'b-g' : 'b-w'}`}>{checked ? 'Seen' : 'Pending'}</span>
                </label>
              );
            })}
          </div>

          <div className="sec-t u-mt-16">History</div>
          <div className="tl u-mt-8">
            {dt.transitions.length === 0 && <div className="empty">No steps recorded yet.</div>}
            {dt.transitions.map((t: any) => (
              <div key={t.id}><b>{t.from_stage ? `${t.from_stage} → ${t.to_stage}` : t.to_stage}</b> by {t.acted_by_name || '—'}{t.acted_as_group ? ` as ${t.acted_as_group}` : ''}
                <br /><small>{new Date(t.acted_at).toLocaleString('en-GB')}{t.note ? ` — ${t.note}` : ''}</small></div>
            ))}
          </div>
        </>)}
      </Modal>

      <Modal open={!!adjust} size="sm" icon="calc" title={`Adjust award — ${c?.case_code ?? ''}`} onClose={() => setAdjust(null)}
        footer={adjust?.confirming ? <>
          <button type="button" className="btn btn-s" onClick={() => setAdjust({ ...adjust, confirming: false })} disabled={busy}>Back</button>
          <button type="button" className="btn btn-p" onClick={postAdjust} disabled={busy}>{busy ? 'Recording…' : 'Confirm adjustment'}</button>
        </> : <>
          <button type="button" className="btn btn-s" onClick={() => setAdjust(null)}>Cancel</button>
          <button type="submit" form="adjForm" className="btn btn-p">Review</button>
        </>}>
        {adjust && c && (
          <form id="adjForm" onSubmit={reviewAdjust} noValidate>
            {adjustError && <ErrorNote>{adjustError}</ErrorNote>}
            {adjust.confirming ? (
              <div className="al w" role="status"><span className="i" /><div className="tx">
                {Number(signedAmount(adjust.amount)) < 0 ? 'Reduce' : 'Increase'} the approved award of <b>{c.case_code}</b> by{' '}
                <b>{formatPKR(Math.abs(Number(signedAmount(adjust.amount))))}</b>.
                <small>Reason: {adjust.reason.trim()}</small>
                <small>The adjustment is added to the case ledger and the audit trail; it cannot be edited afterwards.</small>
              </div></div>
            ) : (<>
              <p className="note u-mb-10">Approved total {formatPKR(Number(c.total_amount))}. An adjustment records an enhancement, court decree or
                correction against the approved award; it does not change the valuation lines.</p>
              <Field label="Change (Rs) — negative to reduce" required htmlFor="adjAmt">
                <input id="adjAmt" inputMode="decimal" required autoComplete="off" value={adjust.amount} placeholder="e.g. 25000 or -12500.50"
                  onChange={(e) => setAdjust({ ...adjust, amount: e.target.value })} />
              </Field>
              <Field label="Reason" required htmlFor="adjWhy" hint="Recorded with your name in the audit trail">
                <textarea id="adjWhy" required minLength={10} maxLength={1000} value={adjust.reason} onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })} />
              </Field>
            </>)}
          </form>
        )}
      </Modal>

      <Modal open={!!form} size="lg" icon="doc" title={form?.mode === 'edit' ? `Edit valuation — ${c?.case_code ?? ''}` : 'New compensation case'} onClose={() => setForm(null)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setForm(null)}>Cancel</button>
          <button type="submit" form="caseForm" className="btn btn-p" disabled={busy}>{busy ? 'Saving…' : form?.mode === 'edit' ? 'Save valuation' : 'Create case'}</button>
        </>}>
        {form && (
          <form id="caseForm" onSubmit={save}>
            <CaseForm draft={form.draft} onChange={(draft) => setForm({ ...form, draft })} creating={form.mode === 'create'}
              projects={projects} species={species} documentItems={documentItems} />
          </form>
        )}
      </Modal>
    </>
  );
}
