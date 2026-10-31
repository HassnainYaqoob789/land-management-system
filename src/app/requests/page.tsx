'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import Shell, { useLMS } from '@/components/layout/Shell';
import { RefSelect } from '@/components/legacy/data';
import { Card, Modal, Field, Stage, Table, Toolbar, SearchBox, Select, Count, Loading, ErrorNote, Kpi, fmtNum, fmtDate } from '@/components/legacy/ui';
import { LoadError } from '@/components/auth/PageGuard';
import { send, useApi } from '@/lib/client/api';
import { useCan, useCanIn } from '@/lib/client/permissions';

// Land requests: Initiator (Exploration Planner or Land Officer) → Director
// Operations → Regional Manager → DM / TL Land Affairs → Land Officer takes
// the land work up ("Handed over"). Polygons are drawn on the GIS map
// (/gis); this screen lists the requests, shows each one's polygon versions,
// parcels inside and warnings, and carries the decisions.

const REVIEW = ['Submitted', 'Under Review - Ops', 'Under Review - Regional', 'Under Review - Land Affairs'];
const CLOSED = ['Rejected', 'Withdrawn', 'Handed over'];
const HANDOVER_KINDS = ['Acquisition', 'Lease', 'Compensation case', 'DBPFC'];

export default function RequestsPage() {
  return (
    <Shell>
      <RequestsContent />
    </Shell>
  );
}

type Decision = 'APPROVE' | 'REJECT' | 'RETURN';

function RequestsContent() {
  const { activeProvince, currentUser } = useLMS();
  const can = useCan();
  const canIn = useCanIn();
  const groups = currentUser?.groups ?? [];
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState('ALL');
  const [mineOnly, setMineOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Raising a request needs requests:create and the project list; deciding needs
  // requests:approve in the request's province and the tier's position (UI-06). The server checks both again.
  const canCreate = can('requests:create');
  const canCreateFully = can(['requests:create', 'projects:read']);
  const canMap = can('gis:read');

  const [isNewModalOpen, setIsNewModalOpen] = useState(false);
  const [transitionTarget, setTransitionTarget] = useState<any | null>(null);
  const [actionChoice, setActionChoice] = useState<Decision>('APPROVE');
  const [actionComment, setActionComment] = useState('');
  const [ownAction, setOwnAction] = useState<{ r: any; action: 'SUBMIT' | 'WITHDRAW' } | null>(null);
  const [handover, setHandover] = useState<any | null>(null);
  const [hoKind, setHoKind] = useState('Acquisition');
  const [hoMark, setHoMark] = useState(true);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const [newRequestData, setNewRequestData] = useState({
    project_id: '', concession_name: '', purpose: '', area_acres: '', area_ghunta: '0', target_deh: '',
    required_date: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().split('T')[0], priority: 'Standard', justification: '',
  });

  // /requests?open=<id> opens a request's details (links from the map and from notices).
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('open');
    if (id) setDetailId(id);
  }, []);

  const params = new URLSearchParams();
  if (activeProvince !== 'ALL') params.append('province', activeProvince);
  if (stageFilter !== 'ALL') params.append('stage', stageFilter);
  if (mineOnly) params.append('mine', '1');
  const list = useApi<any>(`/api/requests${params.toString() ? `?${params}` : ''}`);
  const requests: any[] = list.data?.requests ?? [];
  const summary: any = list.data?.summary ?? {};
  const loading = list.loading;
  const projects: any[] = useApi<any>(canCreateFully ? '/api/projects' : null).data?.projects ?? [];
  const openNew = () => {
    setError(null);
    setNewRequestData((prev) => ({ ...prev, project_id: prev.project_id || projects[0]?.project_id || '' }));
    setIsNewModalOpen(true);
  };

  const run = async (fn: () => Promise<any>, after: () => void, message?: string) => {
    setIsSubmitting(true);
    try { await fn(); setError(null); after(); if (message) setDone(message); }
    catch (err: any) { setError(err.message); }
    finally { setIsSubmitting(false); }
  };

  const handleCreateRequest = (e: React.FormEvent) => {
    e.preventDefault();
    run(() => send('POST', '/api/requests', newRequestData), () => {
      setIsNewModalOpen(false);
      setNewRequestData((p) => ({ ...p, purpose: '', area_acres: '', area_ghunta: '0', target_deh: '', justification: '' }));
    }, 'Land request submitted to Director Operations.');
  };
  const handleTransition = (e: React.FormEvent) => {
    e.preventDefault();
    if (!transitionTarget) return;
    run(() => send('POST', `/api/requests/${transitionTarget.id}/transition`, { action: actionChoice, comment: actionComment }),
      () => { setTransitionTarget(null); setActionComment(''); }, `${transitionTarget.code}: decision recorded.`);
  };
  const handleOwn = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ownAction) return;
    run(() => send('POST', `/api/requests/${ownAction.r.id}/transition`, { action: ownAction.action, comment: actionComment }),
      () => { setOwnAction(null); setActionComment(''); },
      ownAction.action === 'SUBMIT' ? `${ownAction.r.code} sent to Director Operations.` : `${ownAction.r.code} withdrawn.`);
  };
  const handleHandover = (e: React.FormEvent) => {
    e.preventDefault();
    if (!handover) return;
    run(async () => {
      const r = await send<any>('POST', `/api/requests/${handover.id}/transition`,
        { action: 'HANDOVER', handover_kind: hoKind, mark_parcels: hoMark && can('surveys:update'), comment: actionComment });
      const n = r.parcels_marked?.length ?? 0;
      const asked = hoMark && can('surveys:update') && handover.area_version;
      setDone(`${handover.code} handed over for ${hoKind.toLowerCase()}.${n ? ` ${n} parcel(s) marked Under Acquisition: ${r.parcels_marked.join(', ')}.`
        : asked ? ' No parcel was marked: no recorded khasra still "Proposed" lies inside the polygon.' : ''}`);
    }, () => { setHandover(null); setActionComment(''); });
  };

  const needle = search.toLowerCase();
  const filtered = requests.filter((r) =>
    [r.code, r.project_name, r.purpose, r.concession_name, r.created_by_name].some((v) => String(v ?? '').toLowerCase().includes(needle)));

  const TIERS: [string, (r: any) => boolean, (r: any) => boolean][] = [
    // [label, done, current]
    ['Initiator', (r) => r.stage_code !== 'Draft' && r.stage_code !== 'Returned', (r) => r.stage_code === 'Draft' || r.stage_code === 'Returned'],
    ['Director Ops', (r) => ['Under Review - Regional', 'Under Review - Land Affairs', 'Approved', 'Handed over'].includes(r.stage_code), (r) => ['Submitted', 'Under Review - Ops'].includes(r.stage_code)],
    ['Regional Mgr', (r) => ['Under Review - Land Affairs', 'Approved', 'Handed over'].includes(r.stage_code), (r) => r.stage_code === 'Under Review - Regional'],
    ['Land Affairs', (r) => ['Approved', 'Handed over'].includes(r.stage_code), (r) => r.stage_code === 'Under Review - Land Affairs'],
    ['Land work', (r) => r.stage_code === 'Handed over', (r) => r.stage_code === 'Approved'],
  ];
  const tierGroup: Record<string, string> = {
    'Submitted': 'Director Operations', 'Under Review - Ops': 'Director Operations',
    'Under Review - Regional': 'Regional Manager', 'Under Review - Land Affairs': 'DM / TL Land Affairs',
  };
  const setR = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setNewRequestData({ ...newRequestData, [k]: e.target.value });

  const actionsFor = (r: any) => {
    const out: React.ReactNode[] = [];
    out.push(<button key="d" onClick={() => setDetailId(r.id)}>Details</button>);
    if (canMap && r.area_version) out.push(<Link key="m" className="btn btn-s btn-sm" href={`/gis?request=${r.id}`}>Map</Link>);
    if (r.is_mine && (r.stage_code === 'Draft' || r.stage_code === 'Returned')) {
      if (canMap) out.push(<Link key="e" className="btn btn-s btn-sm" href={`/gis?edit=${r.id}`}>Edit on map</Link>);
      out.push(<button key="s" onClick={() => { setError(null); setActionComment(''); setOwnAction({ r, action: 'SUBMIT' }); }}>Send</button>);
      out.push(<button key="w" onClick={() => { setError(null); setActionComment(''); setOwnAction({ r, action: 'WITHDRAW' }); }}>Withdraw</button>);
    }
    if (REVIEW.includes(r.stage_code) && canIn('requests:approve', r.province_code) && groups.includes(tierGroup[r.stage_code]))
      out.push(<button key="r" onClick={() => { setError(null); setTransitionTarget(r); setActionChoice('APPROVE'); setActionComment(''); }}>Review</button>);
    if (r.stage_code === 'Handed over' && r.handed_over_kind === 'Acquisition' && !r.handed_over_record_id && canIn('acquisitions:create', r.province_code))
      out.push(<Link key="a" className="btn btn-p btn-sm" href={`/acquisitions?from_request=${r.id}`}>Create acquisition</Link>);
    if (r.stage_code === 'Approved' && canIn('requests:create', r.province_code) && groups.includes('Land Officer (Field)'))
      out.push(<button key="h" onClick={() => { setError(null); setActionComment(''); setHoKind('Acquisition'); setHoMark(true); setHandover(r); }}>Start land work</button>);
    return out;
  };

  return (
    <>
      {list.data && (
        <div className="kpis">
          <Kpi label="Requests" value={fmtNum(summary.total)} sub={Number(summary.drafts) ? `${summary.drafts} draft(s) of yours` : 'all requisitions'} />
          <Kpi label="Pending Director Ops" value={fmtNum(summary.pending_ops)} sub="tier 2 review" tone="w" />
          <Kpi label="Pending Regional Manager" value={fmtNum(summary.pending_regional)} sub="tier 3 review" tone="w" />
          <Kpi label="Pending Land Affairs" value={fmtNum(summary.pending_land_affairs)} sub="tier 4 review" tone="w" />
          <Kpi label="Approved" value={fmtNum(summary.approved)} sub="waiting for the land team" tone="g" />
          <Kpi label="Handed over" value={fmtNum(summary.handed_over)} sub={Number(summary.returned) ? `${summary.returned} returned for changes` : 'land work started'} tone="g" />
        </div>
      )}
      <Card icon="clip" title="Land Requests"
        sub="Initiator → Director Operations → Regional Manager → Land Affairs → Land Officer · the requester cannot approve, and no one approves two tiers">
        <LoadError error={list.error} status={list.status} code={list.code} what="land requests" />
        {error && !isNewModalOpen && !transitionTarget && !ownAction && !handover && <ErrorNote>{error}</ErrorNote>}
        {done && <div className="al i" role="status"><span className="i" /><div className="tx">{done}</div></div>}
        {canCreate && (
          <div className="bar">
            {canCreateFully && canMap && <Link className="btn btn-p" href="/gis">✎ Draw a land request on the map</Link>}
            {canCreateFully
              ? <button className="btn btn-s" onClick={openNew}>+ Add without a map</button>
              : <button className="btn btn-p" disabled title="Raising a request also needs read access to projects.">+ Add Land Request</button>}
          </div>
        )}
        <Toolbar>
          <SearchBox value={search} onChange={setSearch} placeholder="Search request, project, purpose or requester…" />
          <Select label="Stage" value={stageFilter === 'ALL' ? '' : stageFilter} onChange={(v) => setStageFilter(v || 'ALL')} all="All stages"
            options={['Draft', ['Submitted', 'Submitted (Director Ops)'], ['Under Review - Regional', 'Regional Manager'], ['Under Review - Land Affairs', 'Land Affairs'],
              'Returned', 'Approved', 'Handed over', 'Rejected', 'Withdrawn']} />
          {canCreate && <label className="gl-check"><input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} /> Mine only</label>}
          <Count n={filtered.length} />
        </Toolbar>
        {loading && !requests.length ? <Loading what="land requests" /> : list.error && !list.data ? null : (
          <Table caption="Land requests"
            head={<><th>Request no.</th><th>Project</th><th>Purpose &amp; deh</th><th className="num">Area</th><th>Required by</th><th>Workflow</th><th>Actions</th></>}
            empty={filtered.length ? false : search ? 'No land requests match the search.' : 'No land requests.'} colSpan={7}>
            {filtered.map((r) => (
              <tr key={r.id}>
                <td><span className="code">{r.code}</span><br />
                  <span className={`b ${r.priority === 'Standard' ? 'b-n' : 'b-d'}`}>{r.priority}</span>
                  <br /><small className="note">by {r.created_by_name}{r.is_mine ? ' (you)' : ''}</small></td>
                <td>{r.project_name || <span className="note">—</span>}<br /><small className="note">{r.concession_name}</small></td>
                <td>{r.purpose}<br /><small className="note">{r.target_deh || '—'}</small></td>
                <td className="num">{fmtNum(r.area_acres, 2)} ac
                  {Number(r.area_ghunta) > 0 && <><br /><small className="note">{Number(r.area_ghunta)} ghunta</small></>}
                  <br /><small className="note">{r.area_version ? `polygon v${r.area_version}` : 'no polygon'}</small></td>
                <td>{fmtDate(r.required_date)}</td>
                <td>
                  {['Rejected', 'Withdrawn'].includes(r.stage_code) ? <Stage value={r.stage_code} /> : (
                    <div className="wf u-m-0">
                      {TIERS.map(([label, isDone, cur], i) => (
                        <div key={label} className={`st${cur(r) ? ' cur' : isDone(r) ? ' done' : ''}`}>{i + 1}. {label}</div>
                      ))}
                    </div>
                  )}
                  {!CLOSED.includes(r.stage_code) && <small className="note">
                    {r.stage_code === 'Draft' ? 'Draft — not sent yet' : r.stage_code === 'Returned' ? 'Returned to the requester for changes'
                      : r.stage_code === 'Approved' ? 'Approved — waiting for the Land Officer' : `Waiting on ${r.pending_approver_role}`}</small>}
                  {r.stage_code === 'Handed over' && <small className="note">{r.handed_over_kind} · {r.handed_over_by_name}{r.handed_over_record_code ? ` · ${r.handed_over_record_code}` : ''}</small>}
                </td>
                <td><div className="acts">{actionsFor(r)}</div></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {detailId && <RequestDetail id={detailId} canMap={canMap} onClose={() => setDetailId(null)} />}

      <Modal open={isNewModalOpen} icon="clip" title="Add Land Request (without a map)" onClose={() => setIsNewModalOpen(false)}
        footer={<>
          {error && <span className="u-danger u-flex-1" role="alert">{error}</span>}
          <button type="button" className="btn btn-s" onClick={() => setIsNewModalOpen(false)}>Cancel</button>
          <button type="submit" form="reqForm" className="btn btn-p" disabled={isSubmitting}>{isSubmitting ? 'Submitting…' : 'Submit to Director Operations'}</button>
        </>}>
        {canMap && <p className="note u-mb-10">Drawing the area on the <Link href="/gis">GIS map</Link> is better: it records the exact lat/long, measures the area and finds the parcels inside.</p>}
        <form id="reqForm" onSubmit={handleCreateRequest} className="fgrid">
          <Field label="Project" required full htmlFor="rqProj">
            <select id="rqProj" required value={newRequestData.project_id} onChange={setR('project_id')}>
              <option value="">— Select project —</option>
              {projects.map((p) => <option key={p.project_id} value={p.project_id}>{p.project_code} — {p.project_name} ({p.province_code})</option>)}
            </select>
          </Field>
          <Field label="Concession block" htmlFor="rqConc">
            <input id="rqConc" type="text" value={newRequestData.concession_name} onChange={setR('concession_name')} />
          </Field>
          <Field label="Purpose" required htmlFor="rqPurpose">
            <RefSelect id="rqPurpose" required source="lookup:land_use" value={newRequestData.purpose} onChange={(v) => setNewRequestData({ ...newRequestData, purpose: v })} />
          </Field>
          <Field label="Required area" required htmlFor="rqAc">
            <div className="area-in">
              <input id="rqAc" type="number" step="0.01" min="0.01" required value={newRequestData.area_acres} onChange={setR('area_acres')} />
              <span className="u">acres</span>
            </div>
          </Field>
          <Field label="Ghunta (Sindh)" htmlFor="rqGh">
            <input id="rqGh" type="number" min="0" max="39" value={newRequestData.area_ghunta} onChange={setR('area_ghunta')} />
          </Field>
          <Field label="Target deh / village" htmlFor="rqDeh">
            <input id="rqDeh" type="text" value={newRequestData.target_deh} onChange={setR('target_deh')} placeholder="e.g. Deh Mari" />
          </Field>
          <Field label="Required by" required htmlFor="rqDate">
            <input id="rqDate" type="date" required value={newRequestData.required_date} onChange={setR('required_date')} />
          </Field>
          <Field label="Priority" htmlFor="rqPri">
            <RefSelect id="rqPri" required source="enum:land_request.priority" value={newRequestData.priority} onChange={(v) => setNewRequestData({ ...newRequestData, priority: v })} />
          </Field>
          <Field label="Justification" required full htmlFor="rqJust"
            hint="Submitting records tier 1 in the audit trail and assigns tier 2 review to Director Operations.">
            <textarea id="rqJust" required value={newRequestData.justification} onChange={setR('justification')}
              placeholder="Why this land is needed, the drilling timeline, and the facilities to be built" />
          </Field>
        </form>
      </Modal>

      <Modal open={!!transitionTarget} size="sm" icon="check" title={`Decision — ${transitionTarget?.code ?? ''}`}
        onClose={() => setTransitionTarget(null)}
        footer={<>
          <button type="button" className="btn btn-s" onClick={() => setTransitionTarget(null)}>Cancel</button>
          <button type="submit" form="decisionForm" disabled={isSubmitting}
            className={`btn ${actionChoice === 'APPROVE' ? 'btn-g' : actionChoice === 'RETURN' ? 'btn-w' : 'btn-d'}`}>
            {isSubmitting ? 'Saving…' : actionChoice === 'APPROVE' ? 'Approve' : actionChoice === 'RETURN' ? 'Return for revision' : 'Reject'}
          </button>
        </>}>
        {transitionTarget && (
          <form id="decisionForm" onSubmit={handleTransition}>
            {error && <ErrorNote>{error}</ErrorNote>}
            <p className="u-mb-10">Stage <Stage value={transitionTarget.stage_code} /> · waiting on {transitionTarget.pending_approver_role}
              {canMap && transitionTarget.area_version && <> · <Link href={`/gis?request=${transitionTarget.id}`}>see the polygon on the map</Link></>}</p>
            <div className="fg">
              <label>Decision</label>
              <div className="tabs" role="radiogroup" aria-label="Decision">
                {([['APPROVE', 'Approve'], ['RETURN', 'Return'], ['REJECT', 'Reject']] as const).map(([k, l]) => (
                  <button key={k} type="button" role="radio" aria-checked={actionChoice === k}
                    className={`tab${actionChoice === k ? ' active' : ''}`} onClick={() => setActionChoice(k)}>{l}</button>
                ))}
              </div>
            </div>
            <Field label="Audit comment" required htmlFor="decNote" hint="Mandatory for every decision; recorded in the audit trail. A returned request goes back to its requester to change.">
              <textarea id="decNote" required value={actionComment} onChange={(e) => setActionComment(e.target.value)}
                placeholder="The reason for this decision" />
            </Field>
          </form>
        )}
      </Modal>

      <Modal open={!!ownAction} size="sm" icon={ownAction?.action === 'SUBMIT' ? 'check' : 'warn'}
        title={ownAction ? `${ownAction.action === 'SUBMIT' ? 'Send' : 'Withdraw'} — ${ownAction.r.code}` : ''} onClose={() => setOwnAction(null)}
        footer={<>
          <button type="button" className="btn btn-s" onClick={() => setOwnAction(null)}>Cancel</button>
          <button type="submit" form="ownForm" disabled={isSubmitting} className={`btn ${ownAction?.action === 'SUBMIT' ? 'btn-p' : 'btn-d'}`}>
            {isSubmitting ? 'Saving…' : ownAction?.action === 'SUBMIT' ? 'Send to Director Operations' : 'Withdraw request'}</button>
        </>}>
        {ownAction && (
          <form id="ownForm" onSubmit={handleOwn}>
            {error && <ErrorNote>{error}</ErrorNote>}
            <p className="u-mb-10">{ownAction.action === 'SUBMIT'
              ? 'The request goes to Director Operations. It cannot be changed again unless a reviewer returns it.'
              : 'A withdrawn request is closed and cannot be sent again.'}</p>
            <Field label={ownAction.action === 'SUBMIT' ? 'Note to the reviewers' : 'Reason'} required={ownAction.action === 'WITHDRAW'} htmlFor="ownNote">
              <textarea id="ownNote" required={ownAction.action === 'WITHDRAW'} value={actionComment} onChange={(e) => setActionComment(e.target.value)} />
            </Field>
          </form>
        )}
      </Modal>

      <Modal open={!!handover} size="sm" icon="clip" title={`Start land work — ${handover?.code ?? ''}`} onClose={() => setHandover(null)}
        footer={<>
          <button type="button" className="btn btn-s" onClick={() => setHandover(null)}>Cancel</button>
          <button type="submit" form="hoForm" disabled={isSubmitting} className="btn btn-p">{isSubmitting ? 'Saving…' : 'Take it up'}</button>
        </>}>
        {handover && (
          <form id="hoForm" onSubmit={handleHandover}>
            {error && <ErrorNote>{error}</ErrorNote>}
            <p className="u-mb-10">The request is closed as <b>Handed over</b> to you. Then open the register you chose and create the record there.</p>
            <Field label="Land work" required htmlFor="hoKind">
              <select id="hoKind" value={hoKind} onChange={(e) => setHoKind(e.target.value)}>
                {HANDOVER_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </Field>
            {can('surveys:update') && handover.area_version && hoKind === 'Acquisition' && (
              <label className="gl-check u-mb-10"><input type="checkbox" checked={hoMark} onChange={(e) => setHoMark(e.target.checked)} />
                Mark the recorded parcels inside the polygon “Under Acquisition” (only those still “Proposed”)</label>
            )}
            <Field label="Comment" required htmlFor="hoNote">
              <textarea id="hoNote" required value={actionComment} onChange={(e) => setActionComment(e.target.value)} placeholder="e.g. negotiation with the owners starts next week" />
            </Field>
          </form>
        )}
      </Modal>
    </>
  );
}

const REGISTER_OF: Record<string, string> = { 'Acquisition': '/acquisitions', 'Lease': '/leases', 'Compensation case': '/cases', 'DBPFC': '/dbpfc' };

/** One request: decisions, polygon versions (lat/long), parcels inside and warnings. */
function RequestDetail({ id, canMap, onClose }: { id: string; canMap: boolean; onClose: () => void }) {
  const d = useApi<any>(`/api/requests?id=${encodeURIComponent(id)}`);
  const r = d.data?.request;
  const areas: any[] = d.data?.areas ?? [];
  const parcels: any[] = d.data?.parcels ?? [];
  const warnings: any[] = d.data?.warnings ?? [];
  const [showCorners, setShowCorners] = useState(false);
  const ring: [number, number][] = areas[0]?.geometry?.coordinates?.[0]?.slice(0, -1) ?? [];
  const tiers: [string, string, string][] = [['Director Operations', 'director_ops', 'director_ops_name'], ['Regional Manager', 'regional_mgr', 'regional_mgr_name'], ['DM / TL Land Affairs', 'land_affairs', 'land_affairs_name']];
  return (
    <Modal open size="lg" icon="clip" title={r ? `${r.code} — ${r.purpose}` : 'Land request'} onClose={onClose}
      footer={<>
        {r && canMap && areas.length > 0 && <Link className="btn btn-s" href={`/gis?request=${r.id}`}>Show on map</Link>}
        {r && canMap && r.is_mine && ['Draft', 'Returned'].includes(r.stage_code) && <Link className="btn btn-p" href={`/gis?edit=${r.id}`}>Edit on map</Link>}
        <button type="button" className="btn btn-s" onClick={onClose}>Close</button>
      </>}>
      {d.loading && !r ? <Loading what="the land request" /> : d.error ? <ErrorNote>{d.error}</ErrorNote> : r && (
        <>
          <div className="dl u-mb-10">
            <div><small>Stage</small><span><Stage value={r.stage_code} /></span></div>
            <div><small>Project</small><span>{r.project_code} — {r.project_name}</span></div>
            <div><small>Requested by</small><span>{r.created_by_name} · {fmtDate(r.created_at)}</span></div>
            <div><small>Required area</small><span>{fmtNum(r.area_acres, 2)} acres{areas[0] ? ` (drawn, version ${areas[0].version})` : ''}</span></div>
            <div><small>Required by</small><span>{fmtDate(r.required_date)} · {r.priority}</span></div>
            <div><small>Target deh</small><span>{r.target_deh || '—'}</span></div>
            {areas[0] && <div><small>Centre (lat, long)</small><span>{Number(areas[0].centroid_lat).toFixed(5)}, {Number(areas[0].centroid_lng).toFixed(5)}</span></div>}
            {r.stage_code === 'Handed over' && <div><small>Handed over</small><span>{r.handed_over_kind} · {r.handed_over_by_name} · {fmtDate(r.handed_over_at)}
              {r.handed_over_record_code ? <> · record <b>{r.handed_over_record_code}</b></> : null}
              {REGISTER_OF[r.handed_over_kind] && <> · <Link href={REGISTER_OF[r.handed_over_kind]}>open the register</Link></>}</span></div>}
          </div>
          <p className="u-mb-10"><b>Justification.</b> {r.justification || <span className="note">— (not yet written)</span>}</p>

          {warnings.map((w, i) => (
            <div key={i} className={`al ${w.level === 'danger' ? 'd' : w.level === 'warning' ? 'w' : 'i'} u-mb-6`}><span className="i" /><div className="tx">{w.text}</div></div>
          ))}

          <h4 className="u-mt-10">Decisions</h4>
          <Table caption="Decisions" head={<><th>Tier</th><th>Decision</th><th>By</th><th>When</th><th>Comment</th></>} empty={false} colSpan={5}>
            {tiers.map(([label, p, n]) => (
              <tr key={p}>
                <td>{label}</td>
                <td>{r[`${p}_action`] ? <Stage value={r[`${p}_action`]} /> : <span className="note">—</span>}</td>
                <td>{r[n] || '—'}</td>
                <td>{r[`${p}_date`] ? fmtDate(r[`${p}_date`]) : '—'}</td>
                <td>{r[`${p}_comment`] || '—'}</td>
              </tr>
            ))}
            {r.stage_code === 'Handed over' && (
              <tr><td>Land Officer</td><td><Stage value="Handed over" /></td><td>{r.handed_over_by_name}</td><td>{fmtDate(r.handed_over_at)}</td><td>{r.handed_over_comment}</td></tr>
            )}
          </Table>

          <h4 className="u-mt-10">Polygon versions</h4>
          <Table caption="Polygon versions" head={<><th>Version</th><th className="num">Acres</th><th>Entered by</th><th>How</th><th>When</th><th>What changed</th></>}
            empty={areas.length ? false : 'No polygon: this request was raised without a map.'} colSpan={6}>
            {areas.map((a) => (
              <tr key={a.id}>
                <td>v{a.version}{a === areas[0] && <small className="note"> (current)</small>}</td>
                <td className="num">{fmtNum(a.area_acres, 2)}</td>
                <td>{a.drawn_by_name}</td>
                <td>{a.source === 'draw' ? 'Drawn on the map' : a.source === 'kml' ? 'KML file' : 'Typed / pasted lat-long'}</td>
                <td>{fmtDate(a.drawn_at)}</td>
                <td>{a.note || '—'}</td>
              </tr>
            ))}
          </Table>
          {ring.length > 0 && (
            <>
              <button type="button" className="btn btn-s btn-sm u-mt-6" onClick={() => setShowCorners(!showCorners)} aria-expanded={showCorners}>
                {showCorners ? 'Hide' : 'Show'} the {ring.length} corners (lat / long)</button>
              {showCorners && (
                <Table caption="Corners of the current polygon" head={<><th>#</th><th className="num">Latitude</th><th className="num">Longitude</th></>} empty={false} colSpan={3}>
                  {ring.map((p, i) => <tr key={i}><td>{i + 1}</td><td className="num">{Number(p[1]).toFixed(6)}</td><td className="num">{Number(p[0]).toFixed(6)}</td></tr>)}
                </Table>
              )}
            </>
          )}

          <h4 className="u-mt-10">Recorded parcels inside the polygon</h4>
          <Table caption="Parcels inside" head={<><th>Survey</th><th>Status</th><th>Class</th><th className="num">Acres</th><th>Location</th></>}
            empty={parcels.length ? false : areas.length ? 'No recorded parcel point lies inside the polygon.' : 'Draw the area to find the parcels.'} colSpan={5}>
            {parcels.map((p) => (
              <tr key={p.id}><td className="code">{p.code}</td><td><Stage value={p.status} /></td><td>{p.land_class}</td><td className="num">{fmtNum(p.total_area_acres, 2)}</td><td>{p.location || '—'}</td></tr>
            ))}
          </Table>
        </>
      )}
    </Modal>
  );
}
