'use client';

// Drawing a land request on the GIS map (plan: docs/plans/EXPLORATION_LAND_REQUEST_GIS_PLAN.md).
// The map page owns the map and the corner list; this file holds the side
// panel shown while drawing (corners as lat/long, live area, parcels inside,
// warnings, paste / KML) and the request form that saves it. Figures shown
// here are a preview: the server measures the polygon again and stores its own.

import React, { useMemo, useRef, useState } from 'react';
import { Field, Modal, ErrorNote, fmtNum } from '@/components/legacy/ui';
import { RefSelect } from '@/components/legacy/data';
import { send } from '@/lib/client/api';
import {
  type LngLat, SQM_PER_ACRE, SQM_PER_HECTARE, centroid, parseCoordinateText, parseKmlPolygon, pointInRing,
  polygonAreaSqm, ringProblem, ringsOverlap, MAX_CORNERS,
} from '@/lib/geo';

export type AreaSource = 'draw' | 'coordinates' | 'kml';
export interface EditTarget { id: string; code: string; stage: string; request: any }

const fix = (v: number, d = 6) => (Number.isFinite(v) ? v.toFixed(d) : '');

/** Parcels inside and warnings, from what the map already holds (the server repeats this on save). */
export function previewOf(corners: LngLat[], surveys: any, requests: any, exceptId: string | null) {
  const ok = corners.length >= 3;
  const sqm = ok ? polygonAreaSqm(corners) : 0;
  const inside = ok ? (surveys?.features ?? []).filter((f: any) => pointInRing(f.geometry.coordinates, corners)).map((f: any) => f.properties) : [];
  const overlaps = ok ? (requests?.features ?? []).filter((f: any) => f.properties.id !== exceptId
    && !['Rejected', 'Withdrawn'].includes(f.properties.stage)
    && ringsOverlap(corners, f.geometry.coordinates[0])).map((f: any) => f.properties) : [];
  const warn: { level: 'd' | 'w' | 'i'; text: string }[] = [];
  const codes = (s: string) => inside.filter((p: any) => p.status === s).map((p: any) => p.code);
  if (codes('Disputed').length) warn.push({ level: 'd', text: `Disputed parcel inside: ${codes('Disputed').join(', ')}` });
  for (const [s, t] of [['Acquired', 'Already acquired'], ['Leased', 'Already leased'], ['Under Acquisition', 'Already under acquisition']] as const)
    if (codes(s).length) warn.push({ level: 'w', text: `${t}: ${codes(s).join(', ')}` });
  const gov = inside.filter((p: any) => p.land_class === 'Government').map((p: any) => p.code);
  if (gov.length) warn.push({ level: 'i', text: `Government land inside: ${gov.join(', ')} (Sindh: DBPFC)` });
  if (ok && sqm / SQM_PER_ACRE > 1000) warn.push({ level: 'w', text: `A very large area (${Math.round(sqm / SQM_PER_ACRE).toLocaleString()} acres). Zoom in and check the corners.` });
  if (overlaps.length) warn.push({ level: 'w', text: `Overlaps open request(s): ${overlaps.map((o: any) => `${o.code} (${o.stage})`).join(', ')}` });
  return { sqm, acres: sqm / SQM_PER_ACRE, inside, overlaps, warn, problem: ok ? ringProblem(corners) : null };
}

export function DrawPanel({ corners, setCorners, source, setSource, surveys, requests, editing, onCancel, onContinue }: {
  corners: LngLat[]; setCorners: (c: LngLat[]) => void; source: AreaSource; setSource: (s: AreaSource) => void;
  surveys: any; requests: any; editing: EditTarget | null; onCancel: () => void; onContinue: () => void;
}) {
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const p = useMemo(() => previewOf(corners, surveys, requests, editing?.id ?? null), [corners, surveys, requests, editing]);
  const c = corners.length >= 3 ? centroid(corners) : null;

  const edit = (i: number, k: 0 | 1, v: string) => {
    const n = Number(v);
    const next = corners.map((pt) => [...pt] as LngLat);
    next[i][k] = Number.isFinite(n) ? n : NaN;
    setCorners(next); setSource('coordinates');
  };
  const applyPaste = () => {
    const { ring, skipped } = parseCoordinateText(pasteText);
    if (ring.length < 3) { setMsg('At least 3 lines with a latitude and a longitude are needed.'); return; }
    setCorners(ring.slice(0, MAX_CORNERS)); setSource('coordinates'); setPasteOpen(false);
    setMsg(`${ring.length} corner(s) read${skipped ? `, ${skipped} line(s) skipped` : ''}.`);
  };
  const loadKml = async (f: File | undefined) => {
    if (!f) return;
    if (!/\.kml$/i.test(f.name)) { setMsg('Choose a .kml file (for KMZ, extract the KML first).'); return; }
    const ring = parseKmlPolygon(await f.text());
    if (!ring || ring.length < 3) { setMsg('No polygon was found in that KML file.'); return; }
    setCorners(ring.slice(0, MAX_CORNERS)); setSource('kml'); setMsg(`Polygon read from ${f.name}: ${ring.length} corners.`);
  };

  return (
    <div className="gl-draw">
      <h4>{editing ? `Edit area — ${editing.code}` : 'New land request'}</h4>
      <p className="note">Click the map to place each corner. Drag a corner to move it. You can also type the latitude and longitude below, paste them from a GPS, or load a KML file.</p>
      <div className="bar u-mb-6">
        <button type="button" className="btn btn-s btn-sm" disabled={!corners.length} onClick={() => setCorners(corners.slice(0, -1))}>Undo corner</button>
        <button type="button" className="btn btn-s btn-sm" disabled={!corners.length} onClick={() => setCorners([])}>Clear</button>
        <button type="button" className="btn btn-s btn-sm" onClick={() => { setMsg(null); setPasteOpen(true); }}>Paste lat/long</button>
        <button type="button" className="btn btn-s btn-sm" onClick={() => fileRef.current?.click()}>Load KML</button>
        <input ref={fileRef} type="file" accept=".kml" hidden onChange={(e) => { loadKml(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      {msg && <p className="note" role="status">{msg}</p>}

      <div className="dl">
        <div><small>Corners</small><span>{corners.length}</span></div>
        <div><small>Area</small><span>{corners.length >= 3 ? <>{fmtNum(p.acres, 2)} acres · {fmtNum(p.sqm / SQM_PER_HECTARE, 2)} ha</> : '—'}</span></div>
        <div><small>Centre</small><span>{c ? `${fix(c[1], 5)}, ${fix(c[0], 5)}` : '—'}</span></div>
        <div><small>Parcels inside</small><span>{corners.length >= 3 ? `${p.inside.length}${p.inside.length ? ': ' + p.inside.slice(0, 5).map((x: any) => x.code).join(', ') + (p.inside.length > 5 ? '…' : '') : ''}` : '—'}</span></div>
      </div>
      {p.problem && <div className="al d u-mt-6" role="alert"><span className="i" /><div className="tx">{p.problem}</div></div>}
      {p.warn.map((w, i) => <div key={i} className={`al ${w.level} u-mt-6`}><span className="i" /><div className="tx">{w.text}</div></div>)}

      <h4>Corners (latitude, longitude)</h4>
      {corners.length ? (
        <table className="gl-corners">
          <thead><tr><th>#</th><th>Latitude</th><th>Longitude</th><th><span className="sr-only">Remove</span></th></tr></thead>
          <tbody>
            {corners.map((pt, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td><input aria-label={`Corner ${i + 1} latitude`} type="number" step="0.000001" value={Number.isFinite(pt[1]) ? pt[1] : ''} onChange={(e) => edit(i, 1, e.target.value)} /></td>
                <td><input aria-label={`Corner ${i + 1} longitude`} type="number" step="0.000001" value={Number.isFinite(pt[0]) ? pt[0] : ''} onChange={(e) => edit(i, 0, e.target.value)} /></td>
                <td><button type="button" className="btn btn-s btn-sm" aria-label={`Remove corner ${i + 1}`} onClick={() => setCorners(corners.filter((_, j) => j !== i))}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="note">No corners yet.</p>}
      <div className="bar u-mt-6">
        <button type="button" className="btn btn-s btn-sm" onClick={() => setCorners([...corners, corners.length ? [...corners[corners.length - 1]] as LngLat : [69.3, 28.0]])}>+ Add corner row</button>
      </div>

      <div className="bar u-mt-10">
        <button type="button" className="btn btn-s" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-p" disabled={corners.length < 3 || !!p.problem} onClick={onContinue}>
          {editing ? 'Continue: review and save' : 'Continue: request details'}
        </button>
      </div>

      <Modal open={pasteOpen} size="sm" icon="pin" title="Paste latitude / longitude" onClose={() => setPasteOpen(false)}
        footer={<>
          <button type="button" className="btn btn-s" onClick={() => setPasteOpen(false)}>Cancel</button>
          <button type="button" className="btn btn-p" onClick={applyPaste}>Use these corners</button>
        </>}>
        {msg && <ErrorNote>{msg}</ErrorNote>}
        <Field label="One corner per line" htmlFor="pasteLL" hint="“28.03100, 69.32850” or “28.031 69.3285”. A corner number in front and header lines are ignored. KML order (longitude first) is detected.">
          <textarea id="pasteLL" rows={8} value={pasteText} onChange={(e) => setPasteText(e.target.value)}
            placeholder={'28.03100, 69.32850\n28.03100, 69.33300\n28.02700, 69.33300\n28.02700, 69.32850'} />
        </Field>
      </Modal>
    </div>
  );
}

/** The request form after drawing: create (draft or submit), or save a new area version of a draft / returned request. */
export function RequestFormModal({ open, corners, source, editing, projects, preview, onClose, onSaved }: {
  open: boolean; corners: LngLat[]; source: AreaSource; editing: EditTarget | null; projects: any[];
  preview: ReturnType<typeof previewOf>; onClose: () => void; onSaved: (req: any, submitted: boolean) => void;
}) {
  const r = editing?.request;
  const deh = preview.inside[0]?.location ? String(preview.inside[0].location).split(/\s*[›>/]\s*/).pop() : '';
  const [f, setF] = useState(() => ({
    project_id: r?.project_id ?? '', purpose: r?.purpose ?? '', concession_name: r?.concession_name ?? '',
    target_deh: r?.target_deh ?? deh ?? '', priority: r?.priority ?? 'Standard', justification: r?.justification ?? '',
    required_date: r?.required_date ? String(r.required_date).slice(0, 10) : new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10),
    area_note: '',
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  const save = async (submit: boolean) => {
    setBusy(true); setError(null);
    try {
      const payload = { ...f, corners, area_source: source };
      let saved: any;
      if (editing) {
        saved = (await send<any>('PATCH', `/api/requests/${editing.id}`, payload)).request;
        if (submit) saved = (await send<any>('POST', `/api/requests/${editing.id}/transition`, { action: 'SUBMIT', comment: f.area_note || 'Revised and sent again' })).request;
      } else {
        saved = (await send<any>('POST', '/api/requests', { ...payload, draft: !submit })).request;
      }
      onSaved(saved, submit);
    } catch (e: any) {
      setError(e.message);
    } finally { setBusy(false); }
  };

  return (
    <Modal open={open} icon="clip" title={editing ? `Save area — ${editing.code}` : 'Land request details'} onClose={onClose}
      footer={<>
        {error && <span className="u-danger u-flex-1" role="alert">{error}</span>}
        <button type="button" className="btn btn-s" onClick={onClose} disabled={busy}>Back to the map</button>
        <button type="button" className="btn btn-s" onClick={() => save(false)} disabled={busy || !f.project_id || !f.purpose}>
          {editing ? 'Save changes' : 'Save as draft'}</button>
        <button type="button" className="btn btn-p" onClick={() => save(true)} disabled={busy || !f.project_id || !f.purpose || !f.justification.trim()}>
          {busy ? 'Saving…' : editing ? 'Save and send to Director Operations' : 'Submit to Director Operations'}</button>
      </>}>
      <div className="al i u-mb-10"><span className="i" /><div className="tx">
        Drawn area <b>{fmtNum(preview.acres, 2)} acres</b> ({corners.length} corners) · {preview.inside.length} recorded parcel(s) inside.
        <small>The drawn area becomes the required area. {editing ? 'Saving keeps the earlier version of the polygon.' : 'A draft is seen only by you until you send it.'}</small>
      </div></div>
      <form className="fgrid" onSubmit={(e) => { e.preventDefault(); save(true); }}>
        <Field label="Project" required full htmlFor="drProj">
          <select id="drProj" required value={f.project_id} onChange={set('project_id')} disabled={!!editing && editing.stage !== 'Draft' && editing.stage !== 'Returned'}>
            <option value="">— Select project —</option>
            {projects.map((p) => <option key={p.project_id} value={p.project_id}>{p.project_code} — {p.project_name} ({p.province_code})</option>)}
          </select>
        </Field>
        <Field label="Purpose" required htmlFor="drPurpose">
          <RefSelect id="drPurpose" required source="lookup:land_use" value={f.purpose} onChange={(v) => setF({ ...f, purpose: v })} />
        </Field>
        <Field label="Priority" htmlFor="drPri">
          <RefSelect id="drPri" required source="enum:land_request.priority" value={f.priority} onChange={(v) => setF({ ...f, priority: v })} />
        </Field>
        <Field label="Required by" required htmlFor="drDate">
          <input id="drDate" type="date" required value={f.required_date} onChange={set('required_date')} />
        </Field>
        <Field label="Target deh / village" htmlFor="drDeh">
          <input id="drDeh" type="text" value={f.target_deh} onChange={set('target_deh')} />
        </Field>
        <Field label="Concession block" htmlFor="drConc">
          <input id="drConc" type="text" value={f.concession_name} onChange={set('concession_name')} placeholder="Mari Concession" />
        </Field>
        <Field label="Justification" required full htmlFor="drJust" hint="Needed to send the request. A draft can be saved without it.">
          <textarea id="drJust" value={f.justification} onChange={set('justification')}
            placeholder="Why this land is needed, the work planned (well pad, access road, camp, seismic line) and the timeline" />
        </Field>
        {editing && (
          <Field label="What changed" full htmlFor="drNote" hint="Recorded with the new version of the polygon and shown to the reviewers.">
            <input id="drNote" type="text" value={f.area_note} onChange={set('area_note')} placeholder="e.g. moved the access road 200 m east, as asked" />
          </Field>
        )}
      </form>
    </Modal>
  );
}
