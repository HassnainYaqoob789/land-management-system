'use client';

import React, { useEffect, useState } from 'react';
import Shell from '@/components/layout/Shell';
import { RefSelect, WorkflowActions, RecordPicker, useList, useListQuery } from '@/components/legacy/data';
import { send, useApi, useReference, stagesOf } from '@/lib/client/api';
import { useCan, useCanIn } from '@/lib/client/permissions';
import { printDocument, escapeHtml } from '@/lib/client/print';
import { LoadError } from '@/components/auth/PageGuard';
import { Card, Modal, Field, Stage, Table, Toolbar, SearchBox, Count, Loading, ErrorNote, Kpi, fmtNum, fmtDate, Pager, rowOpen } from '@/components/legacy/ui';
import { formatPKR } from '@/lib/domain';

const COMPANY = 'Mari Energies Limited';
const HEAD_OFFICE = 'Islamabad';

/**
 * The lease agreement as a printable document (UX-03), in the reference's
 * wording (legacy-demo printAgreement). Every value is escaped; a lease that
 * is not yet approved prints with a DRAFT watermark.
 */
function leaseDeedHtml(l: any, renewals: any[], final: boolean): string {
  const e = (v: unknown) => escapeHtml(v === null || v === undefined || v === '' ? '—' : String(v));
  const rs = (v: unknown) => e(v === null || v === undefined ? '—' : formatPKR(Number(v)));
  const area = l.current_area || l.initial_area;
  const parcels = String(l.parcels ?? '').split(/,\s*/).filter(Boolean);
  return [
    final ? '' : `<div class="p-watermark">DRAFT — ${e(String(l.stage_code ?? 'Draft').toUpperCase())}</div>`,
    `<h3>LEASE AGREEMENT<br>${e(l.registration_no || l.lease_code)}</h3>`,
    `<p class="p-just">THIS LEASE AGREEMENT ("<b>Agreement</b>") is made this ____ day of ______________ 20__, between <b>${e(l.lessors)}</b>
      (hereinafter referred to as the "<b>Lessor</b>", which expression where the context so admits shall include his legal heirs and permitted assigns);</p>`,
    `<p class="p-tc">AND</p>`,
    `<p class="p-just"><b>${e(COMPANY)}</b>, having its head office at ${e(HEAD_OFFICE)} (hereinafter referred to as the "<b>Lessee</b>",
      which expression where the context so admits shall include its successors and permitted assigns).</p>`,
    `<p><b>WHEREAS:</b></p><ol class="p-lh-16" type="A">
      <li>The Lessor confirms that he is the true and lawful owner / co-owner / attorney and authorised to lease the Land bearing survey number(s)
        <b>${e(parcels.join(', '))}</b>, more particularly described in the Schedule below (the "<b>Land</b>").</li>
      <li>The Lessor further confirms that he has the legal capacity to lease the Land and has completed all legal, regulatory and statutory formalities in this regard.</li>
      <li>The Lessor has agreed to lease the Land to the Lessee for the purposes of the Lessee's operations (${e(l.project_code)} — ${e(l.project_name)}) on the terms set out hereunder.</li></ol>`,
    `<p><b>NOW THEREFORE, the Parties hereto have agreed as follows:</b></p>`,
    `<p><b>1. TERM</b><br>Lessor hereby leases the Land to Lessee for a term of ${e(l.term_years)} year(s) beginning ${e(fmtDate(l.start_date))}
      and ending ${e(fmtDate(l.end_date))}.${l.auto_extend ? ' The Term shall automatically be extended for a further period of equal length unless terminated by the Lessee in accordance with the provisions hereof.' : ''}
      ${l.renewal_clause ? e(l.renewal_clause) : ''}</p>`,
    `<p><b>2. RENT</b><br>2.1 Lessee shall pay to Lessor annually in advance rent of ${rs(l.rate_per_acre)} per acre per annum for a net lease area of
      ${e(fmtNum(area, 4))} acres, i.e. ${rs(l.annual_rent)} per annum${Number(l.escalation_pct) ? `, subject to escalation of ${e(Number(l.escalation_pct))}% on each renewal` : ''}.<br>
      2.2 Payment will be made through crossed cheque and/or direct funds transfer into the bank account nominated by the Lessor. The debit advice from the Lessee's banker shall be considered confirmation of payment of Rent.<br>
      2.3 If any amount paid to Lessor is found in excess of or less than Lessor's actual entitlement, the same shall be rectified accordingly.</p>`,
    `<p><b>3. OBLIGATIONS</b><br>${l.obligations ? e(l.obligations) : 'As per standard terms of the Lessee.'}</p>`,
    `<div class="band">SCHEDULE OF LAND</div><table><tr><th>Survey / parcel</th><th>Province</th><th>Lease kind</th><th>Lease area (acres)</th></tr>${
      (parcels.length ? parcels : ['—']).map((p, i) => `<tr><td>${e(p)}</td><td>${e(l.province_code)}</td><td>${e(l.kind)}</td><td class="r">${i === 0 ? e(fmtNum(area, 4)) : ''}</td></tr>`).join('')}</table>`,
    renewals.length ? `<div class="band">RENEWALS</div><table><tr><th>No.</th><th>Recorded</th><th>By</th><th>Note</th></tr>${renewals.map((r) =>
      `<tr><td>${e(r.renewal_no)}</td><td>${e(fmtDate(r.recorded_at ?? r.created_at))}</td><td>${e(r.recorded_by_name)}</td><td>${e(r.note)}</td></tr>`).join('')}</table>` : '',
    `<div class="sig"><div>LESSOR<br>${e(l.lessors)}</div><div>LESSEE<br>for ${e(COMPANY)}</div><div>WITNESS 1</div><div>WITNESS 2</div></div>`,
  ].join('');
}


export default function LeasesPage() {
  return (
    <Shell>
      <LeasesContent />
    </Shell>
  );
}

function LeasesContent() {
  const ref = useReference();
  const can = useCan();
  const canIn = useCanIn();
  const lq = useListQuery();
  const list = useList('/api/leases', 'leases', lq.params);
  const { rows: leases, body, page, summary, loading, error: listError } = list;
  const alerts: any[] = body?.alerts ?? [];
  const [error, setError] = useState<string | null>(null);
  // Adding a lease needs leases:create and the lookups its form searches (projects, landowners).
  const canCreate = can('leases:create');
  const canCreateFully = can(['leases:create', 'projects:read', 'landowners:read']);
  // Hold, release, renew and workflow steps are leases:update in the lease's province (UI-06).
  const canUpdateIn = (province: string | null | undefined) => canIn('leases:update', province);

  // New Lease Modal state
  const [isNewModalOpen, setIsNewModalOpen] = useState(false);
  const [newLeaseData, setNewLeaseData] = useState({
    project_id: '',
    kind: '',
    registration_no: '',
    start_date: new Date().toISOString().split('T')[0],
    term_years: 3,
    initial_area: '',
    annual_rent: '',
    rate_per_acre: '',
    escalation_pct: 10.0,
    auto_extend: true,
    lessor_id: '',
    survey_id: '',
  });

  // /leases?from_request=<id>: a land request handed over for a lease opens the form pre-filled with its
  // project, drawn area and the first recorded parcel inside its polygon; saving links the request to the lease.
  const [fromRequest, setFromRequest] = useState<any | null>(null);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('from_request');
    if (!id) return;
    fetch(`/api/requests?id=${encodeURIComponent(id)}`).then((r) => r.json()).then((d) => {
      if (!d.request) { setError(d.error || 'That land request was not found.'); return; }
      const r = d.request;
      const parcel = (d.parcels ?? []).find((p: any) => !['Acquired', 'Leased'].includes(p.status));
      setNewLeaseData((x) => ({ ...x, project_id: r.project_id, initial_area: String(Number(r.area_acres)), survey_id: parcel?.id ?? '' }));
      setFromRequest(r); setIsNewModalOpen(true);
    }).catch(() => {});
  }, []);

  // Reason-based Hold Modal state
  const [holdTarget, setHoldTarget] = useState<any | null>(null);
  const [holdReason, setHoldReason] = useState('Disputed Title / Ownership Conflict');
  const [customHoldNote, setCustomHoldNote] = useState('');
  const [isSubmittingHold, setIsSubmittingHold] = useState(false);

  // Renewal Modal state
  const [renewTarget, setRenewTarget] = useState<any | null>(null);
  const [renewYears, setRenewYears] = useState(1);
  const [renewEscalation, setRenewEscalation] = useState(10.0);
  const [renewNote, setRenewNote] = useState('');
  const [isSubmittingRenew, setIsSubmittingRenew] = useState(false);

  // Lease Detail / Printable Agreement Modal
  const [detailLease, setDetailLease] = useState<any | null>(null);
  const deed = useApi<any>(detailLease ? `/api/leases?id=${encodeURIComponent(detailLease.lease_id)}` : null);
  const leaseStages = stagesOf(ref, 'leases');

  // Projects are only needed by the Add Lease form.
  const projects: any[] = useApi<any>(canCreateFully ? '/api/projects' : null).data?.projects ?? [];

  const printDeed = () => {
    const l = { ...detailLease, ...(deed.data?.lease ?? {}) };
    printDocument({
      title: 'Lease Agreement',
      subtitle: `${l.project_code ?? ''} · ${l.project_name ?? ''}`,
      meta: [['Lease No', String(l.lease_code ?? '')], ['Registration', String(l.registration_no || '—')], ['Province', String(l.province_code ?? '')]],
      bodyHtml: leaseDeedHtml(l, deed.data?.renewals ?? [], !!leaseStages.length && l.stage_code === leaseStages[leaseStages.length - 1]),
      classification: 'Confidential',
    });
  };

  const handleCreateLease = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const areaNum = parseFloat(newLeaseData.initial_area);
      const rentNum = parseFloat(newLeaseData.annual_rent || '0');
      const rateNum = newLeaseData.rate_per_acre
        ? parseFloat(newLeaseData.rate_per_acre)
        : areaNum > 0
          ? rentNum / areaNum
          : rentNum;

      await send('POST', '/api/leases', {
        ...newLeaseData,
        initial_area: areaNum,
        annual_rent: rentNum,
        rate_per_acre: rateNum,
        lessor_ids: newLeaseData.lessor_id ? [newLeaseData.lessor_id] : [],
        survey_ids: newLeaseData.survey_id ? [newLeaseData.survey_id] : [],
        land_request_id: fromRequest?.id,
      }, { also: ['/api/requests'] });
      setFromRequest(null);
      setError(null);

      setIsNewModalOpen(false);
    } catch (err: any) {
      setError(err.message);
    }
  };


  const handleToggleHold = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!holdTarget) return;
    setIsSubmittingHold(true);

    try {
      const action = holdTarget.is_on_hold ? 'RELEASE' : 'HOLD';
      const reasonText = holdTarget.is_on_hold
        ? customHoldNote
        : `${holdReason}: ${customHoldNote}`;

      await send('POST', `/api/leases/${holdTarget.lease_id}/hold`, { action, reason: reasonText }, { also: ['/api/payments'] });
      setError(null);

      setHoldTarget(null);
      setCustomHoldNote('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSubmittingHold(false);
    }
  };

  const handleRenewLease = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renewTarget) return;
    setIsSubmittingRenew(true);

    try {
      await send('POST', `/api/leases/${renewTarget.lease_id}/renew`, {
        additional_years: renewYears,
        escalation_pct: renewEscalation,
        note: renewNote,
      });
      setError(null);

      setRenewTarget(null);
      setRenewNote('Annual contract renewal and escalation per standard terms');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSubmittingRenew(false);
    }
  };

  const filtered = leases;   // searched and paged by the database

  const HOLD_REASONS = ['Disputed Title / Ownership Conflict', 'Non-Traceable / Absentee Owner', 'Pending Cadastral Demarcation',
    'Succession / Warasat Dispute', 'Court Stay / Legal Injunction', 'National Tax Number / CNIC Deficiency', 'Other Operational Justification'];
  const setL = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setNewLeaseData({ ...newLeaseData, [k]: e.target.value });
  const onHold = summary.on_hold;

  return (
    <>
      {body && (
        <div className="kpis">
          <Kpi label="Leases" value={fmtNum(summary.total)} sub="registered agreements" />
          <Kpi label="Expiring ≤ 90 days" value={fmtNum(body?.alerts_total ?? alerts.length)} sub="renewal alerts" tone={alerts.length ? 'w' : 'g'} />
          <Kpi label="On hold" value={fmtNum(onHold)} sub="payments and renewals blocked" tone={onHold ? 'd' : 'g'} />
        </div>
      )}

      {alerts.length > 0 && (
        <Card icon="warn" title={`Renewal alerts (${fmtNum(body?.alerts_total ?? alerts.length)})`} sub="Leases expiring within 90 days">
          {alerts.slice(0, 6).map((al) => (
            <div key={al.lease_id} className={`al ${al.days_to_expiry <= 30 ? 'd' : 'w'}`}>
              <span className="i" />
              <div className="tx">
                <span className="code">{al.lease_code}</span> ({al.project_code}) — {al.lessors || 'direct landowner'}
                <small>Expires in {al.days_to_expiry} days · {fmtDate(al.end_date)}</small>
              </div>
              {canUpdateIn(al.province_code) && (() => {
                const match = leases.find((l) => l.lease_id === al.lease_id);
                return (
                  <button className="btn btn-s btn-sm" disabled={!match || match.is_on_hold}
                    title={!match ? 'Find this lease in the register below to renew it' : match.is_on_hold ? 'Renewal is blocked while the lease is on hold' : 'Renew and escalate'}
                    onClick={() => { if (match) { setError(null); setRenewTarget(match); setRenewYears(1); setRenewEscalation(Number(match.escalation_pct || 10)); } }}>Renew</button>
                );
              })()}
            </div>
          ))}
        </Card>
      )}

      <Card icon="cal" title="Leases & Agreements"
        sub="Surface leases with reason-based hold and release · renewal applies the agreed annual escalation">
        <LoadError {...list} what="the lease register" />
        {error && !holdTarget && !renewTarget && !isNewModalOpen && <ErrorNote>{error}</ErrorNote>}
        {canCreate && (
          <div className="bar">
            {canCreateFully
              ? <button className="btn btn-p" onClick={() => { setError(null); setIsNewModalOpen(true); }}>+ Add Lease</button>
              : <button className="btn btn-p" disabled title="Adding a lease also needs read access to projects and landowners.">+ Add Lease</button>}
          </div>
        )}
        <Toolbar>
          <SearchBox value={lq.q} onChange={lq.setQ} placeholder="Search lease, project or landowner…" />
          <Count n={page?.total ?? filtered.length} />
        </Toolbar>
        {loading ? <Loading what="leases" /> : (
          <Table caption="Leases"
            head={<><th>Lease no.</th><th>Prov.</th><th>Project</th><th>Lessor(s)</th><th className="num">Area (acres)</th>
              <th className="num">Annual rent (Rs)</th><th className="num">Escalation</th><th>Expiry</th><th>Status</th><th>Actions</th></>}
            empty={filtered.length || listError ? false : `No leases${lq.q ? ' match the search' : ' yet'}.`} colSpan={10}>
            {filtered.map((l) => {
              const expiring = l.days_to_expiry <= 90 && l.days_to_expiry >= 0;
              const isHold = l.is_on_hold || l.lease_status === 'On Hold';
              const canUpd = canUpdateIn(l.province_code);
              return (
                <tr key={l.lease_id} {...rowOpen(() => setDetailLease(l), `Show details of ${l.lease_code}`)}>
                  <td><span className="code">{l.lease_code}</span>{l.renewal_count > 0 && <><br /><small className="note">renewed {l.renewal_count}×</small></>}</td>
                  <td><span className="pill">{l.province_code}</span></td>
                  <td>{l.project_name}</td>
                  <td>{l.lessors || <span className="note">—</span>}</td>
                  <td className="num">{fmtNum(l.current_area || l.initial_area, 2)}</td>
                  <td className="num">{fmtNum(l.annual_rent)}</td>
                  <td className="num">+{Number(l.escalation_pct)}%/yr</td>
                  <td>{fmtDate(l.end_date)}</td>
                  <td>
                    {isHold
                      ? <><span className="b b-d">On hold</span>{l.hold_reason && <><br /><small className="note">{l.hold_reason}</small></>}</>
                      : <span className={`b ${expiring ? 'b-w' : 'b-g'}`}>{expiring ? 'Expiring' : l.lease_status || '—'}</span>}
                  </td>
                  <td>
                    <div className="acts">
                      <WorkflowActions workflow="leases" resource="/api/leases" record={l} idField="lease_id" can={canUpd} />
                      {canUpd && (<>
                        <button onClick={() => { setError(null); setHoldTarget(l); setCustomHoldNote(''); }}
                          title={isHold ? 'Release hold' : 'Place a reason-based hold'}>{isHold ? 'Release' : 'Hold'}</button>
                        <button disabled={isHold} onClick={() => { setError(null); setRenewTarget(l); setRenewYears(1); setRenewEscalation(Number(l.escalation_pct)); }}
                          title={isHold ? 'Renewal is blocked while the lease is on hold' : 'Renew and escalate'}>Renew</button>
                      </>)}
                      <button onClick={() => setDetailLease(l)}>Print</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
        <Pager page={page} onOffset={lq.setOffset} />
      </Card>

      <Modal open={!!detailLease} size="lg" icon="print" title={`Lease Agreement Summary — ${detailLease?.lease_code ?? ''}`}
        onClose={() => setDetailLease(null)}
        footer={<>
          {deed.error && <span className="u-danger u-flex-1" role="alert">{deed.error}</span>}
          <button type="button" className="btn btn-s" onClick={printDeed} disabled={deed.loading || !deed.data}>Print Lease Deed</button>
          <button type="button" className="btn btn-p" onClick={() => setDetailLease(null)}>Close</button>
        </>}>
        {detailLease && (
          <div className="dl">
            <div><small>Lease Code</small><span className="code">{detailLease.lease_code}</span></div>
            <div><small>Project</small><span>{detailLease.project_name} ({detailLease.province_code})</span></div>
            <div><small>Lessor(s)</small><span>{detailLease.lessors || '—'}</span></div>
            <div><small>Lease Area</small><span>{fmtNum(detailLease.current_area || detailLease.initial_area, 2)} acres</span></div>
            <div><small>Rate / Acre</small><span>{formatPKR(detailLease.rate_per_acre)}</span></div>
            <div><small>Annual Rent</small><span><b>{formatPKR(detailLease.annual_rent)}</b> (+{Number(detailLease.escalation_pct)}%/yr)</span></div>
            <div><small>Start Date</small><span>{fmtDate(detailLease.start_date)}</span></div>
            <div><small>Expiry Date</small><span>{fmtDate(detailLease.end_date)}</span></div>
            <div><small>Workflow Stage</small><span><Stage value={detailLease.stage_code || 'Approved'} /></span></div>
          </div>
        )}
      </Modal>

      <Modal open={!!holdTarget} size="sm" icon="lock"
        title={holdTarget?.is_on_hold ? 'Release lease hold' : 'Place lease on hold'}
        onClose={() => setHoldTarget(null)}
        footer={<>
          <button type="button" className="btn btn-s" onClick={() => setHoldTarget(null)}>Cancel</button>
          <button type="submit" form="holdForm" disabled={isSubmittingHold} className={`btn ${holdTarget?.is_on_hold ? 'btn-g' : 'btn-w'}`}>
            {isSubmittingHold ? 'Saving…' : holdTarget?.is_on_hold ? 'Release hold' : 'Place hold'}
          </button>
        </>}>
        {holdTarget && (
          <form id="holdForm" onSubmit={handleToggleHold}>
            {error && <ErrorNote>{error}</ErrorNote>}
            <div className="dl">
              <div><small>Lease</small><span className="code">{holdTarget.lease_code}</span></div>
              <div><small>Project</small><span>{holdTarget.project_name}</span></div>
              <div><small>Lessor</small><span>{holdTarget.lessors || '—'}</span></div>
            </div>
            {!holdTarget.is_on_hold ? (
              <>
                <Field label="Reason" required htmlFor="holdReason">
                  <input id="holdReason" list="holdReasonList" required value={holdReason} onChange={(e) => setHoldReason(e.target.value)} />
                  <datalist id="holdReasonList">{HOLD_REASONS.map((r) => <option key={r} value={r} />)}</datalist>
                </Field>
                <Field label="Notes & evidence reference" required htmlFor="holdNote"
                  hint="A hold stops payment vouchers and blocks renewal until it is released.">
                  <textarea id="holdNote" required value={customHoldNote} onChange={(e) => setCustomHoldNote(e.target.value)}
                    placeholder="Dispute case number, court stay details or revenue official reference" />
                </Field>
              </>
            ) : (
              <>
                <p className="u-mb-10">Current hold: <b>{holdTarget.hold_reason}</b></p>
                <Field label="Release justification" required htmlFor="releaseNote">
                  <textarea id="releaseNote" required value={customHoldNote} onChange={(e) => setCustomHoldNote(e.target.value)}
                    placeholder="Resolution of the dispute, succession deed, or court order vacating the stay" />
                </Field>
              </>
            )}
          </form>
        )}
      </Modal>

      <Modal open={!!renewTarget} size="sm" icon="repeat" title="Renew lease" onClose={() => setRenewTarget(null)}
        footer={<>
          <button type="button" className="btn btn-s" onClick={() => setRenewTarget(null)}>Cancel</button>
          <button type="submit" form="renewForm" className="btn btn-p" disabled={isSubmittingRenew}>{isSubmittingRenew ? 'Renewing…' : 'Renew'}</button>
        </>}>
        {renewTarget && (
          <form id="renewForm" onSubmit={handleRenewLease}>
            {error && <ErrorNote>{error}</ErrorNote>}
            <div className="totals u-mb-10">
              <div><small>Lease</small><b className="mono">{renewTarget.lease_code}</b></div>
              <div><small>Current expiry</small><b>{fmtDate(renewTarget.end_date)}</b></div>
              <div><small>Annual rent</small><b>{formatPKR(renewTarget.annual_rent)}</b></div>
            </div>
            <div className="fgrid">
              <Field label="Extension (years)" required htmlFor="rnYears">
                <input id="rnYears" type="number" min="1" max="10" required value={renewYears} onChange={(e) => setRenewYears(parseInt(e.target.value) || 1)} />
              </Field>
              <Field label="Escalation (% / yr)" required htmlFor="rnEsc">
                <input id="rnEsc" type="number" step="0.5" min="0" max="50" required value={renewEscalation} onChange={(e) => setRenewEscalation(parseFloat(e.target.value) || 0)} />
              </Field>
              <Field label="Renewal note" required full htmlFor="rnNote">
                <textarea id="rnNote" required value={renewNote} onChange={(e) => setRenewNote(e.target.value)} />
              </Field>
            </div>
            <div className="calc u-mt-10">
              Escalated rent: {formatPKR(Math.round(Number(renewTarget.annual_rent) * (1 + renewEscalation / 100)))} / yr
            </div>
          </form>
        )}
      </Modal>

      <Modal open={isNewModalOpen} icon="cal" title={fromRequest ? `Add Lease — from land request ${fromRequest.code}` : "Add Lease"} onClose={() => setIsNewModalOpen(false)}
        footer={<>
          {error && <span className="u-danger u-flex-1" role="alert">{error}</span>}
          <button type="button" className="btn btn-s" onClick={() => setIsNewModalOpen(false)}>Cancel</button>
          <button type="submit" form="leaseForm" className="btn btn-p">Save</button>
        </>}>
        <form id="leaseForm" onSubmit={handleCreateLease} className="fgrid">
          <Field label="Project / well location" required full htmlFor="lsProj">
            <select id="lsProj" required value={newLeaseData.project_id} onChange={setL('project_id')}>
              <option value="">— Select project —</option>
              {projects.map((p) => <option key={p.project_id} value={p.project_id}>{p.project_code} · {p.project_name} ({p.province_code})</option>)}
            </select>
          </Field>
          <Field label="Lease kind" required htmlFor="lsKind">
            <RefSelect id="lsKind" required source="enum:lease.kind" value={newLeaseData.kind} onChange={(v) => setNewLeaseData({ ...newLeaseData, kind: v })} />
          </Field>
          <Field label="Initial area (acres)" required htmlFor="lsArea">
            <input id="lsArea" type="number" step="0.01" min="0.01" required value={newLeaseData.initial_area} onChange={setL('initial_area')} />
          </Field>
          <Field label="Lessor (landowner)" required full htmlFor="lsLessor">
            <RecordPicker id="lsLessor" resource="/api/landowners" rowsKey="landowners" label="Lessor" required value={newLeaseData.lessor_id}
              filters={{ province: projects.find((p) => p.project_id === newLeaseData.project_id)?.province_code }} idOf={(l) => l.id}
              optionLabel={(lo) => `${lo.full_name}${lo.cnic ? ` (${lo.cnic})` : ''} — ${lo.filer_status || lo.tax_status}${lo.is_deceased ? ' [deceased]' : ''}`}
              onChange={(id) => setNewLeaseData({ ...newLeaseData, lessor_id: id })} />
          </Field>
          <Field label="Survey parcel (optional)" full htmlFor="lsSurvey">
            <RecordPicker id="lsSurvey" resource="/api/surveys" rowsKey="surveys" label="Survey parcel" value={newLeaseData.survey_id}
              filters={{ province: projects.find((p) => p.project_id === newLeaseData.project_id)?.province_code }} idOf={(r) => r.survey_id}
              optionLabel={(r) => `${r.survey_code} — ${r.survey_no} (${r.total_area} ac)`}
              onChange={(id) => setNewLeaseData({ ...newLeaseData, survey_id: id })} />
          </Field>
          <Field label="Start date" required htmlFor="lsStart">
            <input id="lsStart" type="date" required value={newLeaseData.start_date} onChange={setL('start_date')} />
          </Field>
          <Field label="Term (years)" required htmlFor="lsTerm">
            <input id="lsTerm" type="number" min="1" max="30" required value={newLeaseData.term_years}
              onChange={(e) => setNewLeaseData({ ...newLeaseData, term_years: parseInt(e.target.value) })} />
          </Field>
          <Field label="Annual rent (Rs)" required htmlFor="lsRent">
            <input id="lsRent" type="number" min="0" step="0.01" required value={newLeaseData.annual_rent} onChange={setL('annual_rent')} placeholder="e.g. 750000" />
          </Field>
          <Field label="Escalation (% / yr)" htmlFor="lsEsc">
            <input id="lsEsc" type="number" step="0.1" min="0" value={newLeaseData.escalation_pct}
              onChange={(e) => setNewLeaseData({ ...newLeaseData, escalation_pct: parseFloat(e.target.value) })} />
          </Field>
        </form>
      </Modal>
    </>
  );
}
