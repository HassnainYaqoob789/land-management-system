'use client';

import React, { useState } from 'react';
import Shell, { useLMS } from '@/components/layout/Shell';
import { Card, Modal, Field, Stage, Table, Toolbar, SearchBox, Count, Loading, Kpi, fmtNum, fmtRsM } from '@/components/legacy/ui';
import { useList, RefSelect, ProvinceSelect } from '@/components/legacy/data';
import { LoadError } from '@/components/auth/PageGuard';
import { send, useApi } from '@/lib/client/api';
import { useCan, useCanIn } from '@/lib/client/permissions';

export default function ProjectsPage() {
  return <Shell><ProjectsContent /></Shell>;
}

const EMPTY = { code: '', name: '', type_code: '', block: '', province_code: '', district_id: '', required_area: '', description: '', status: '' };

function ProjectsContent() {
  const { activeProvince } = useLMS();
  const can = useCan();
  const canIn = useCanIn();
  const list = useList('/api/projects', 'projects');
  const { rows, loading, error } = list;
  // Cases and money per project are other modules' figures (UI-09).
  const showCases = can('cases:read'), showPaid = can('payments:read');
  const canWrite = can('projects:create') || can('projects:update');
  const units = useApi(canWrite ? '/api/units' : null).data?.admin_units ?? [];
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<'new' | 'edit' | null>(null);
  const [form, setForm] = useState({ ...EMPTY });
  const [editing, setEditing] = useState<any | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof EMPTY) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const districts = units.filter((u: any) => u.province_code === form.province_code && Number(u.level_no) === 0);

  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setFormError(null);
    const area = form.required_area ? Number(form.required_area) : undefined;
    try {
      if (mode === 'edit') {
        await send('PUT', '/api/projects', { id: editing.project_id, name: form.name, type_code: form.type_code, block: form.block,
          district_id: form.district_id || undefined, required_area: area, description: form.description, status: form.status });
      } else {
        await send('POST', '/api/projects', { code: form.code, name: form.name, type_code: form.type_code, block: form.block,
          province_code: form.province_code, district_id: form.district_id, required_area: area, description: form.description || undefined });
      }
      setMode(null);
    } catch (err: any) { setFormError(err.message); } finally { setBusy(false); }
  };

  const needle = q.trim().toLowerCase();
  const shown = needle ? rows.filter((p: any) => [p.project_code, p.project_name, p.block, p.type_code, p.district_name].join(' ').toLowerCase().includes(needle)) : rows;

  return (
    <>
      {list.body && (
        <div className="kpis">
          <Kpi label="Projects" value={fmtNum(rows.length)} sub={`${fmtNum(rows.filter((p: any) => p.status === 'Active').length)} active`} />
          <Kpi label="Land linked" value={`${fmtNum(rows.reduce((n: number, p: any) => n + Number(p.linked_area || 0), 0), 1)} ac`} sub="surveys linked to projects" tone="g" />
          {showCases && <Kpi label="Approved compensation" value={fmtRsM(rows.reduce((n: number, p: any) => n + Number(p.approved_compensation || 0), 0))} sub="HO-approved cases" />}
          {showPaid && <Kpi label="Released" value={fmtRsM(rows.reduce((n: number, p: any) => n + Number(p.released_amount || 0), 0))} sub="cheques released" tone="g" />}
        </div>
      )}
      <Card icon="rig" title="Projects / Well Locations" sub="Wells, pipelines, facilities and seismic surveys · land linked, cases and money by project">
        <LoadError {...list} what="projects" />
        {can('projects:create') && (
          <div className="bar"><button className="btn btn-p" onClick={() => { setFormError(null); setEditing(null); setForm({ ...EMPTY, province_code: activeProvince !== 'ALL' ? activeProvince : '' }); setMode('new'); }}>+ Add Project</button></div>
        )}
        <Toolbar>
          <SearchBox value={q} onChange={setQ} placeholder="Search project code, name, block, type or district…" />
          <Count n={shown.length} />
        </Toolbar>
        {loading ? <Loading what="projects" /> : (
          <Table caption="Projects"
            head={<><th>Project</th><th>Name</th><th>Type</th><th>Block</th><th>Prov.</th><th>District</th><th className="num">Required (ac)</th>
              <th className="num">Linked (ac)</th>{showCases && <><th className="num">Cases</th><th className="num">Approved (Rs)</th></>}{showPaid && <th className="num">Released (Rs)</th>}<th>Status</th><th>Actions</th></>}
            empty={shown.length || error ? false : 'No projects.'} colSpan={10 + (showCases ? 2 : 0) + (showPaid ? 1 : 0)}>
            {shown.map((p: any) => (
              <tr key={p.project_id}>
                <td><span className="code">{p.project_code}</span></td>
                <td>{p.project_name}</td>
                <td>{p.type_code}</td>
                <td>{p.block}</td>
                <td><span className="pill">{p.province_code}</span></td>
                <td>{p.district_name || <span className="note">—</span>}</td>
                <td className="num">{p.required_area != null ? fmtNum(p.required_area, 1) : '—'}</td>
                <td className="num">{fmtNum(p.linked_area, 1)} <small className="note">({fmtNum(p.linked_parcels)})</small></td>
                {showCases && <><td className="num">{fmtNum(p.live_cases)} live · {fmtNum(p.approved_cases)} appr.</td>
                  <td className="num">{fmtNum(p.approved_compensation)}</td></>}
                {showPaid && <td className="num">{fmtNum(p.released_amount)}</td>}
                <td><Stage value={p.status} /></td>
                <td><div className="acts">{canIn('projects:update', p.province_code) && (
                  <button onClick={() => {
                    setFormError(null); setEditing(p);
                    setForm({ ...EMPTY, code: p.project_code, name: p.project_name, type_code: p.type_code, block: p.block, province_code: p.province_code,
                      district_id: p.district_id ?? '', required_area: p.required_area ?? '', description: p.description ?? '', status: p.status });
                    setMode('edit');
                  }}>Edit</button>
                )}</div></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal open={!!mode} icon="rig" title={mode === 'edit' ? `Edit project — ${editing?.project_code}` : 'Add Project'} onClose={() => setMode(null)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setMode(null)}>Cancel</button>
          <button type="submit" form="pjForm" className="btn btn-p" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </>}>
        <form id="pjForm" onSubmit={save} className="fgrid">
          {mode === 'new' && (<>
            <Field label="Project code" required htmlFor="pjCode"><input id="pjCode" className="mono" required value={form.code} onChange={(e) => set('code')(e.target.value)} placeholder="e.g. SUI-004" /></Field>
            <Field label="Province" required htmlFor="pjProv"><ProvinceSelect id="pjProv" required value={form.province_code} onChange={(v) => setForm((f) => ({ ...f, province_code: v, district_id: '' }))} /></Field>
          </>)}
          <Field label="Name" required full htmlFor="pjName"><input id="pjName" required value={form.name} onChange={(e) => set('name')(e.target.value)} /></Field>
          <Field label="Type" required htmlFor="pjType"><RefSelect id="pjType" required source="lookup:project_type" value={form.type_code} onChange={set('type_code')} /></Field>
          <Field label="Block / concession" required htmlFor="pjBlock"><input id="pjBlock" required value={form.block} onChange={(e) => set('block')(e.target.value)} /></Field>
          <Field label="District" required={mode === 'new'} htmlFor="pjDist">
            <select id="pjDist" required={mode === 'new'} value={form.district_id} onChange={(e) => set('district_id')(e.target.value)} disabled={!form.province_code}>
              <option value="">— Select district —</option>
              {districts.map((d: any) => <option key={d.admin_unit_id} value={d.admin_unit_id}>{d.name}</option>)}
            </select>
          </Field>
          <Field label="Required area" htmlFor="pjArea"><div className="area-in"><input id="pjArea" type="number" min="0" step="0.01" value={form.required_area} onChange={(e) => set('required_area')(e.target.value)} /><span className="u">acres</span></div></Field>
          {mode === 'edit' && <Field label="Status" required htmlFor="pjStatus"><RefSelect id="pjStatus" required source="enum:project.status" value={form.status} onChange={set('status')} /></Field>}
          <Field label="Description" full htmlFor="pjDesc"><textarea id="pjDesc" value={form.description} onChange={(e) => set('description')(e.target.value)} /></Field>
        </form>
      </Modal>
    </>
  );
}
