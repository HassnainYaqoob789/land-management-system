'use client';

import React, { useState } from 'react';
import Shell, { useLMS } from '@/components/layout/Shell';
import { Card, Modal, Field, Stage, Table, Toolbar, SearchBox, Count, Loading, ErrorNote, Kpi, fmtNum, Pager } from '@/components/legacy/ui';
import { useList, RefSelect, ProvinceSelect, useListQuery } from '@/components/legacy/data';
import { LoadError } from '@/components/auth/PageGuard';
import { send, useApi, useReference, lookupOf } from '@/lib/client/api';
import { useCan, useCanIn } from '@/lib/client/permissions';
import ShareBalancer, { OwnerShareItem } from '@/components/ui/ShareBalancer';

export default function SurveysPage() {
  return <Shell><SurveysContent /></Shell>;
}

// The area is entered as the revenue record states it (recorded_area in
// recorded_unit); PostgreSQL derives total_area in acres from it (0040,
// lms.tg_survey_recorded_area), so the screen never converts units itself.
const EMPTY = { province_code: '', admin_unit_id: '', project_id: '', survey_no: '', block_no: '', khasra_type: '', land_class: '',
  status_code: '', recorded_area: '', recorded_unit: 'Acre', lat: '', lng: '', remarks: '' };
const AREA_RE = /^\d{1,14}(\.\d{1,4})?$/;   // numeric(18,4), > 0

/** GET a survey record; throws the server's message on refusal or failure. */
async function surveyRecord(id: string): Promise<any> {
  const res = await fetch(`/api/surveys?id=${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.survey) throw new Error(d.error || `Could not load this survey (${res.status}).`);
  return d;
}

function SurveysContent() {
  const { activeProvince } = useLMS();
  const can = useCan();
  const canIn = useCanIn();
  const ref = useReference();
  const lq = useListQuery();
  // `q` is the contract's search parameter (as the pickers send it); `search` is what older builds read.
  const list = useList('/api/surveys', 'surveys', { q: lq.dq || undefined, search: lq.dq || undefined, offset: lq.offset || undefined });
  const { rows, body, page, summary, loading, error } = list;
  const canCreate = can('surveys:create');
  const canEditIn = (province: string | null | undefined) => canIn('surveys:update', province);
  // Revenue locations come from /api/units; projects only when the user may read them.
  const units = useApi(canCreate ? '/api/units' : null).data;
  const projects = useApi(canCreate && can('projects:read') ? '/api/projects' : null).data?.projects ?? [];
  const [mode, setMode] = useState<'new' | 'edit' | null>(null);
  const [form, setForm] = useState<any>({ ...EMPTY });
  const [editing, setEditing] = useState<any | null>(null);
  // As loaded: an unchanged area is not sent, so a record captured before units were kept stays honest.
  const [initialArea, setInitialArea] = useState<{ recorded_area: string; recorded_unit: string; total_area: string; legacy: boolean } | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [shares, setShares] = useState<{ survey: any; items: OwnerShareItem[]; valid: boolean } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (v: string) => setForm((f: any) => ({ ...f, [k]: v }));
  const adminUnits = (units?.admin_units ?? []).filter((u: any) => u.province_code === form.province_code);
  const areaUnits = lookupOf(ref, 'measurement_unit');
  const areaBad = form.recorded_area !== '' && (!AREA_RE.test(String(form.recorded_area).trim()) || Number(form.recorded_area) <= 0);
  const areaChanged = !initialArea || initialArea.recorded_area !== String(form.recorded_area).trim() || initialArea.recorded_unit !== form.recorded_unit;

  const openNew = () => {
    setFormError(null); setEditing(null); setInitialArea(null); setEditLoading(false);
    setForm({ ...EMPTY, province_code: activeProvince !== 'ALL' ? activeProvince : '' }); setMode('new');
  };
  const openEdit = async (row: any) => {
    setFormError(null); setEditing(row); setInitialArea(null); setEditLoading(true); setMode('edit');
    setForm({ ...EMPTY, province_code: row.province_code, survey_no: row.survey_no ?? '', block_no: row.block_no ?? '', khasra_type: row.khasra_type ?? '',
      land_class: row.land_class ?? '', status_code: row.status_code ?? '' });
    try {
      // The list view omits coordinates, remarks and the recorded area; the record itself has them.
      const s = { ...row, ...(await surveyRecord(row.survey_id)).survey };
      const legacy = s.recorded_area == null || !s.recorded_unit;
      const area = { recorded_area: legacy ? String(s.total_area ?? '') : String(s.recorded_area), recorded_unit: legacy ? 'Acre' : String(s.recorded_unit),
        total_area: String(s.total_area ?? ''), legacy };
      setInitialArea(area);
      setForm({ ...EMPTY, province_code: s.province_code, survey_no: s.survey_no ?? '', block_no: s.block_no ?? '', khasra_type: s.khasra_type ?? '',
        land_class: s.land_class ?? '', status_code: s.status_code ?? '', recorded_area: area.recorded_area, recorded_unit: area.recorded_unit,
        lat: s.lat ?? '', lng: s.lng ?? '', remarks: s.remarks ?? '' });
      setEditLoading(false);
    } catch (err: any) { setFormError(err.message); }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (areaBad || (mode === 'edit' && editLoading)) return;
    setBusy(true); setFormError(null);
    try {
      // recorded_area travels as a decimal string (no float rounding); the database derives acres.
      const area = mode === 'new' || areaChanged ? { recorded_area: String(form.recorded_area).trim(), recorded_unit: form.recorded_unit } : {};
      const common = { survey_no: form.survey_no, block_no: form.block_no || undefined, khasra_type: form.khasra_type || undefined,
        land_class: form.land_class, ...area, lat: form.lat ? Number(form.lat) : undefined, lng: form.lng ? Number(form.lng) : undefined,
        remarks: form.remarks || undefined };
      if (mode === 'edit') await send('PUT', '/api/surveys', { id: editing.survey_id, ...common, status_code: form.status_code || undefined }, { also: ['/api/gis'] });
      else await send('POST', '/api/surveys', { ...common, province_code: form.province_code, admin_unit_id: form.admin_unit_id, project_id: form.project_id || undefined }, { also: ['/api/gis'] });
      setMode(null);
    } catch (err: any) { setFormError(err.message); } finally { setBusy(false); }
  };

  const openShares = async (s: any) => {
    setFormError(null);
    try {
      const d = await surveyRecord(s.survey_id);
      const items: OwnerShareItem[] = (d.shares ?? []).map((x: any) => ({
        landowner_id: x.landowner_id, landowner_name: x.full_name, cnic: x.cnic, share_pct: Number(x.share_pct),
        revenue_doc_ref: x.revenue_doc_ref, tax_status: x.tax_status, is_deceased: x.owner_status === 'Deceased',
      }));
      const sum = items.reduce((n, i) => n + i.share_pct, 0);
      setShares({ survey: s, items, valid: Math.abs(sum - 100) < 0.01 && !items.some((i) => i.is_deceased) });
    } catch (err: any) { setFormError(err.message); }
  };
  // Owners already registered are changed only by a mutation (the API refuses a direct edit with 409).
  const registered = !!shares && Number(shares.survey.owner_count || 0) > 0;
  const saveShares = async () => {
    if (!shares?.valid) return; setBusy(true); setFormError(null);
    try { await send('PUT', '/api/surveys', { survey_id: shares.survey.survey_id, shares: shares.items }); setShares(null); }
    catch (err: any) { setFormError(err.message); } finally { setBusy(false); }
  };


  return (
    <>
      {body && (
        <div className="kpis">
          <Kpi label="Surveys" value={fmtNum(summary.total)} sub="khasra / survey numbers registered" />
          <Kpi label="Area" value={`${fmtNum(summary.area, 1)} ac`} sub="total registered" tone="g" />
          <Kpi label="Shares not at 100%" value={fmtNum(summary.unbalanced)} sub="ownership to correct" tone={summary.unbalanced ? 'w' : 'g'} />
        </div>
      )}
      <Card icon="map" title="Survey / Khasra Register"
        sub="Province revenue hierarchy and native land units · owner shares must total 100% · area is stored in acres, converted by the database">
        <LoadError {...list} what="the survey register" />
        {formError && !mode && !shares && <ErrorNote>{formError}</ErrorNote>}
        {canCreate && <div className="bar"><button className="btn btn-p" onClick={openNew}>+ Add Survey</button></div>}
        <Toolbar>
          <SearchBox value={lq.q} onChange={lq.setQ} placeholder="Search survey no., block, khasra or village…" />
          <Count n={page?.total ?? rows.length} />
        </Toolbar>
        {loading ? <Loading what="surveys" /> : (
          <Table caption="Survey register"
            head={<><th>Survey code</th><th>Prov.</th><th>Survey / khasra no.</th><th>Revenue location</th><th>Class</th><th className="num">Area (acres)</th>
              <th>Owner shares</th><th>Status</th><th>Actions</th></>}
            empty={rows.length || error ? false : `No surveys${lq.q ? ' match the search' : ' yet'}.`} colSpan={9}>
            {rows.map((s: any) => {
              const total = Number(s.share_total_pct || 0); const ok = Math.abs(total - 100) < 0.01;
              return (
                <tr key={s.survey_id}>
                  <td><span className="code">{s.survey_code}</span></td>
                  <td><span className="pill">{s.province_code}</span></td>
                  <td>Survey {s.survey_no}{s.block_no ? ` · Block ${s.block_no}` : ''}{s.khasra_type && <><br /><small className="note">{s.khasra_type}</small></>}</td>
                  <td title={s.location_path}>{s.location_path || <span className="note">—</span>}</td>
                  <td>{s.land_class}</td>
                  <td className="num">{fmtNum(s.total_area, 2)}</td>
                  <td><span className={`b ${ok ? 'b-g' : 'b-w'}`}>{total.toFixed(1)}%</span> <small className="note">{s.owner_count || 0} owner(s)</small></td>
                  <td><Stage value={s.status_code} /></td>
                  <td><div className="acts">
                    {canIn('landowners:read', s.province_code) && <button onClick={() => openShares(s)}>Shares</button>}
                    {canEditIn(s.province_code) && <button onClick={() => openEdit(s)}>Edit</button>}
                  </div></td>
                </tr>
              );
            })}
          </Table>
        )}
        <Pager page={page} onOffset={lq.setOffset} />
      </Card>

      <Modal open={!!shares} size="lg" icon="scale" title={<>Owner shares — <span className="code">{shares?.survey.survey_code}</span></>} onClose={() => setShares(null)}
        footer={<>
          {formError ? <span className="u-danger u-flex-1" role="alert">{formError}</span>
            : <span className="note u-flex-1">{registered ? 'This parcel already has registered owners: change them through Mutation & Succession.' : 'Shares must total exactly 100.0% before they can be saved.'}</span>}
          <button type="button" className="btn btn-s" onClick={() => setShares(null)}>{registered ? 'Close' : 'Cancel'}</button>
          {shares && !registered && canEditIn(shares.survey.province_code) && <button type="button" className="btn btn-p" onClick={saveShares} disabled={!shares?.valid || busy}>{busy ? 'Saving…' : 'Save shares'}</button>}
        </>}>
        {shares && (
          <>
            <p className="note u-mb-10">Survey {shares.survey.survey_no} · {shares.survey.location_path}</p>
            <ShareBalancer totalAreaAcres={Number(shares.survey.total_area)} initialShares={shares.items}
              province={shares.survey.province_code}
              onSharesChange={(items, valid) => setShares((s) => s && { ...s, items, valid })} />
          </>
        )}
      </Modal>

      <Modal open={!!mode} icon="map" title={mode === 'edit' ? `Edit survey — ${editing?.survey_code}` : 'Add Survey'} onClose={() => setMode(null)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setMode(null)}>Cancel</button>
          <button type="submit" form="svForm" className="btn btn-p" disabled={busy || areaBad || (mode === 'edit' && editLoading)}>{busy ? 'Saving…' : 'Save'}</button>
        </>}>
        <form id="svForm" onSubmit={save} className="fgrid">
          {mode === 'new' && (<>
            <Field label="Province" required htmlFor="svProv"><ProvinceSelect id="svProv" required value={form.province_code} onChange={(v) => setForm((f: any) => ({ ...f, province_code: v, admin_unit_id: '', project_id: '' }))} /></Field>
            <Field label="Revenue location" required htmlFor="svUnit">
              <select id="svUnit" required value={form.admin_unit_id} onChange={(e) => set('admin_unit_id')(e.target.value)} disabled={!form.province_code}>
                <option value="">— Select —</option>
                {adminUnits.map((u: any) => <option key={u.admin_unit_id} value={u.admin_unit_id}>{u.full_path || u.path}</option>)}
              </select>
            </Field>
            <Field label="Project" full htmlFor="svProj">
              <select id="svProj" value={form.project_id} onChange={(e) => set('project_id')(e.target.value)}>
                <option value="">— None —</option>
                {projects.filter((p: any) => p.province_code === form.province_code).map((p: any) => <option key={p.project_id} value={p.project_id}>{p.project_code} — {p.project_name}</option>)}
              </select>
            </Field>
          </>)}
          <Field label="Survey / khasra no." required htmlFor="svNo"><input id="svNo" required value={form.survey_no} onChange={(e) => set('survey_no')(e.target.value)} /></Field>
          <Field label="Block no." htmlFor="svBlock" hint="Sindh and urban surveys"><input id="svBlock" value={form.block_no} onChange={(e) => set('block_no')(e.target.value)} /></Field>
          <Field label="Khasra type" htmlFor="svKt"><RefSelect id="svKt" source="enum:survey.khasra_type" all="—" value={form.khasra_type} onChange={set('khasra_type')} /></Field>
          <Field label="Land class" required htmlFor="svClass"><RefSelect id="svClass" required source="enum:survey.land_class" value={form.land_class} onChange={set('land_class')} /></Field>
          {mode === 'edit' && <Field label="Land status" required htmlFor="svSt"><RefSelect id="svSt" required source="lookup:land_status" value={form.status_code} onChange={set('status_code')} /></Field>}
          {mode === 'edit' && editLoading && !formError && <div className="fg full"><Loading what="survey" /></div>}
          <Field label="Recorded area" required htmlFor="svArea"
            hint={areaBad ? <span className="u-danger">A positive number with at most 4 decimals</span>
              : initialArea?.legacy && !areaChanged ? 'Captured before the recorded unit was kept: shown in acres. Enter the area as the revenue record states it to record its unit.'
                : 'As the revenue record states it, in that record\'s unit'}>
            <div className="area-in">
              <input id="svArea" inputMode="decimal" required className={areaBad ? 'err' : undefined} aria-invalid={areaBad} value={form.recorded_area}
                onChange={(e) => set('recorded_area')(e.target.value)} />
              <select aria-label="Recorded unit" required value={form.recorded_unit} onChange={(e) => set('recorded_unit')(e.target.value)} disabled={!areaUnits.length}>
                {areaUnits.map((u) => <option key={u.code} value={u.code}>{u.name}</option>)}
              </select>
            </div>
          </Field>
          <Field label="Area in acres" htmlFor="svAcres" hint="Derived by the database from the recorded area when you save; it cannot be typed.">
            <input id="svAcres" readOnly className="mono"
              value={mode === 'edit' && initialArea && !areaChanged ? `${fmtNum(initialArea.total_area, 4)} ac` : 'Calculated on save'} />
          </Field>
          <Field label="Latitude" htmlFor="svLat"><input id="svLat" type="number" step="0.000001" min="23" max="37.5" value={form.lat} onChange={(e) => set('lat')(e.target.value)} /></Field>
          <Field label="Longitude" htmlFor="svLng"><input id="svLng" type="number" step="0.000001" min="60" max="78" value={form.lng} onChange={(e) => set('lng')(e.target.value)} /></Field>
          <Field label="Remarks" full htmlFor="svRem"><textarea id="svRem" value={form.remarks} onChange={(e) => set('remarks')(e.target.value)} /></Field>
        </form>
      </Modal>
    </>
  );
}
