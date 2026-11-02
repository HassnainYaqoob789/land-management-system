'use client';

// Data-bound building blocks shared by the module screens, so each screen is
// its columns and its form — not another copy of fetching, workflow and
// list-of-values code.

import React, { useEffect, useState } from 'react';
import { useLMS } from '@/components/layout/Shell';
import { useApi, useReference, send, stagesOf, nextStage, enumOf, lookupOf } from '@/lib/client/api';
import { Modal, Field, ErrorNote } from './ui';

/** `value`, once it has stopped changing for `ms` (search boxes). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/**
 * A province-scoped, server-paged list: GET /api/x?province=…&q=…&offset=… →
 * body[key], with body.page (limit, offset, total) and body.summary (register
 * totals for the KPI tiles). Searching happens in the database, over the whole
 * register, not over the rows on screen.
 */
export function useList<T = any>(resource: string, key: string, extra: Record<string, string | number | undefined> = {}) {
  const { activeProvince } = useLMS();
  const params = new URLSearchParams();
  if (activeProvince && activeProvince !== 'ALL') params.set('province', activeProvince);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '') params.set(k, String(v));
  const qs = params.toString();
  const r = useApi<Record<string, any>>(resource ? `${resource}${qs ? `?${qs}` : ''}` : null);   // '' = not needed yet
  return {
    rows: ((r.data?.[key] as T[]) ?? []), body: r.data, loading: r.loading && !r.data, error: r.error, reload: r.reload,
    page: r.data?.page as { limit: number; offset: number; total: number } | undefined,
    summary: (r.data?.summary ?? {}) as Record<string, number>,
  };
}

/** The `?q=` a page was opened with (a global-search result links to /cases?q=<code>). */
function initialQuery(): string {
  if (typeof window === 'undefined') return '';
  try { return (new URLSearchParams(window.location.search).get('q') ?? '').slice(0, 100); } catch { return ''; }
}

/** Search text and page position for one list; changing the search goes back to page 1. */
export function useListQuery() {
  const [q, setQState] = useState(initialQuery);
  const [offset, setOffset] = useState(0);
  const dq = useDebounced(q.trim());
  const setQ = (v: string) => { setQState(v); setOffset(0); };
  return { q, setQ, dq, offset, setOffset, params: { q: dq || undefined, offset: offset || undefined } };
}

/**
 * Choose one record from a large register (50,000 landowners will not fit in
 * a <select>): type to search the database, then pick from the matches.
 * `current` labels the selected record when it is not among the matches.
 * Enter in the search box never submits the surrounding form, and the number
 * of matches is announced politely (UX-13).
 */
export function RecordPicker({ resource, rowsKey, value, onChange, label, optionLabel, idOf, filters = {}, current, required, id, allowDeceased }: {
  resource: string; rowsKey: string; value: string; onChange: (id: string, row?: any) => void; label: string;
  optionLabel: (row: any) => string; idOf: (row: any) => string; filters?: Record<string, string | undefined>;
  current?: string; required?: boolean; id?: string;
  /** Deceased landowners are not selectable unless this is set (a succession's transferor). */
  allowDeceased?: boolean;
}) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const params = new URLSearchParams({ limit: '25' });
  if (dq) params.set('q', dq);
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  const { data, loading, error } = useApi<any>(`${resource}?${params}`);
  const rows: any[] = data?.[rowsKey] ?? [];
  const has = rows.some((r) => idOf(r) === value);
  const total = Number(data?.page?.total ?? rows.length);
  const status = loading && !data ? `Searching ${label}…`
    : error ? `Could not search ${label}.`
    : rows.length ? `${total.toLocaleString()} ${total === 1 ? 'match' : 'matches'}${total > rows.length ? `, first ${rows.length} listed` : ''}`
    : `No ${label} match${dq ? ` “${dq}”` : ''}`;
  return (
    <div className="picker">
      <input type="search" aria-label={`Search ${label}`} placeholder={`Search ${label}…`} value={q}
        onChange={(e) => setQ(e.target.value)}
        // Enter would submit the surrounding form (implicit submission); here it only searches.
        onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} />
      <select id={id} aria-label={label} required={required} value={value}
        onChange={(e) => onChange(e.target.value, rows.find((r) => idOf(r) === e.target.value))}>
        <option value="">{loading && !data ? 'Loading…' : rows.length ? `— Select ${label} (${total.toLocaleString()} found) —` : 'No match'}</option>
        {value && !has && <option value={value}>{current ?? `Selected ${label} (not in these results)`}</option>}
        {rows.map((r) => <option key={idOf(r)} value={idOf(r)} disabled={!allowDeceased && r.is_deceased}>{optionLabel(r)}</option>)}
      </select>
      <span className="sr-only" role="status" aria-live="polite">{status}</span>
    </div>
  );
}

/**
 * A <select> whose options come from PostgreSQL:
 *   source="lookup:land_use"        → lms.land_use codes
 *   source="enum:survey.land_class" → the values survey.land_class's CHECK allows
 *   source="stages:cases"           → the cases workflow stages
 */
export function RefSelect({ source, value, onChange, id, required, all, label, className }: {
  source: string; value: string; onChange: (v: string) => void; id?: string; required?: boolean;
  all?: string; label?: string; className?: string;
}) {
  const ref = useReference();
  const [kind, name] = source.split(':');
  const options: [string, string][] =
    kind === 'lookup' ? lookupOf(ref, name).map((o) => [o.code, o.name]) :
    kind === 'enum' ? enumOf(ref, name).map((v) => [v, v]) :
    kind === 'stages' ? stagesOf(ref, name, { withTerminal: true }).map((v) => [v, v]) : [];
  return (
    <select id={id} className={className} aria-label={label} required={required} value={value} onChange={(e) => onChange(e.target.value)}
      disabled={!ref}>
      {all !== undefined ? <option value="">{all}</option> : !value && <option value="">— Select —</option>}
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

/**
 * Workflow actions for one record, from lms.workflow / lms.workflow_stage:
 * advance to the next stage, and cancel or stop where the workflow allows it.
 * The server (api.advance_workflow) decides who may act. Here `can` hides the
 * buttons from users without the permission, and the "→ next" button is shown
 * only to holders of an approval position that owns that step
 * (lms.workflow_step_group); everyone else sees who the record is waiting on.
 */
export function WorkflowActions({ workflow, resource, record, can, stageField = 'stage_code', idField = 'id', label }: {
  workflow: string; resource: string; record: any; can: boolean; stageField?: string; idField?: string; label?: string;
}) {
  const ref = useReference();
  const [target, setTarget] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { currentUser } = useLMS();
  const myGroups = currentUser?.groups ?? [];
  const stage = record[stageField];
  const wf = ref?.workflows[workflow];
  if (!wf || !can) return null;
  const st = wf.stages.find((s) => s.code === stage);
  if (!st || st.terminal || (wf.lockAt && stage === wf.lockAt)) return null;
  const next = nextStage(ref, workflow, stage);
  const nextGroups = wf.stages.find((s) => s.code === next)?.groups ?? [];
  const mayAdvance = !!next && (nextGroups.length === 0 || nextGroups.some((g) => myGroups.includes(g)));
  const side = [wf.allowsCancel && 'Cancelled', wf.allowsStop && 'Stopped'].filter(Boolean) as string[];
  const terminal = target === 'Cancelled' || target === 'Stopped';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!target) return;
    setBusy(true); setError(null);
    try {
      await send('PUT', resource, { id: record[idField], action: 'transition', to_stage: target, note: note.trim() || undefined });
      setTarget(null); setNote('');
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <>
      {mayAdvance && <button onClick={() => { setError(null); setTarget(next); }} title={`Move to ${next}`}>→ {next}</button>}
      {next && !mayAdvance && <small className="note" style={{ whiteSpace: 'normal', maxWidth: 170, lineHeight: 1.3 }}
        title={`Next step: ${next}. Done by: ${nextGroups.join(', ')}`}>Waiting on {nextGroups.join(' / ')}</small>}
      {side.map((s) => <button key={s} className="del" onClick={() => { setError(null); setTarget(s); }}>{s === 'Cancelled' ? 'Cancel' : 'Stop'}</button>)}
      <Modal open={!!target} size="sm" stacked icon={terminal ? 'x' : 'send'}
        title={`${label ?? record.code ?? ''} → ${target ?? ''}`} onClose={() => setTarget(null)}
        footer={<>
          <button type="button" className="btn btn-s" onClick={() => setTarget(null)}>Back</button>
          <button type="submit" form={`wf-${record[idField]}`} className={`btn ${terminal ? 'btn-d' : 'btn-p'}`} disabled={busy}>
            {busy ? 'Saving…' : terminal ? `Confirm: ${target}` : `Move to ${target}`}
          </button>
        </>}>
        <form id={`wf-${record[idField]}`} onSubmit={submit}>
          {error && <ErrorNote>{error}</ErrorNote>}
          <p className="u-mb-10">From <b>{stage}</b> to <b>{target}</b>. The server checks your approval position and
            separation of duties, and records this in the audit trail.</p>
          <Field label={terminal ? 'Reason' : 'Note'} required={terminal} htmlFor={`wfn-${record[idField]}`}>
            <textarea id={`wfn-${record[idField]}`} required={terminal} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </form>
      </Modal>
    </>
  );
}

/** Province options the signed-in user may write to. */
export function ProvinceSelect({ value, onChange, id, required }: { value: string; onChange: (v: string) => void; id?: string; required?: boolean }) {
  const ref = useReference();
  const { provinces } = useLMS();
  const opts = (ref?.provinces ?? []).filter((p) => !provinces.length || provinces.includes(p.code));
  return (
    <select id={id} required={required} value={value} onChange={(e) => onChange(e.target.value)}>
      {!value && <option value="">— Select —</option>}
      {opts.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
    </select>
  );
}
