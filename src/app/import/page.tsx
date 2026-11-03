'use client';

import React, { useState } from 'react';
import Shell, { useLMS } from '@/components/layout/Shell';
import { Card, Modal, Field, Stage, Table, Loading, ErrorNote, Kpi, fmtNum, rowOpen } from '@/components/legacy/ui';
import { ProvinceSelect } from '@/components/legacy/data';
import { LoadError } from '@/components/auth/PageGuard';
import { send, useApi } from '@/lib/client/api';
import { useCan, useCanIn } from '@/lib/client/permissions';

export default function ImportPage() {
  return <Shell><ImportContent /></Shell>;
}

// The columns api.validate_import_batch reads for each target (migration 0012).
const TARGETS: Record<string, { label: string; required: string[]; optional: string[] }> = {
  landowner: { label: 'Landowners', required: ['full_name', 'father_name', 'cnic'], optional: ['owner_type', 'phone', 'iban', 'province_code'] },
  survey: { label: 'Survey / khasra register', required: ['survey_no', 'unit_name', 'area_value'], optional: ['block_no', 'land_class', 'area_unit', 'province_code'] },
};

/** RFC 4180 CSV → array of objects keyed by the header row. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((x) => x !== '')) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some((x) => x !== '')) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  const keys = head.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

function ImportContent() {
  const { activeProvince } = useLMS();
  const can = useCan();
  const canIn = useCanIn();
  const batchList = useApi<any>('/api/import');
  const { data, loading, error } = batchList;
  const batches: any[] = data?.batches ?? [];
  // Staging and validating are import:create; promoting rows into the registers is the
  // sensitive import:update (UI-07) — what api.promote_import_batch checks.
  const canCreate = can('import:create');
  const canValidate = (b: any) => canIn('import:create', b.province_code);
  const canPromote = (b: any) => canIn('import:update', b.province_code);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('landowner');
  const [province, setProvince] = useState('');
  const [file, setFile] = useState<{ name: string; rows: Record<string, string>[] } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const detailLoad = useApi<any>(detailId ? `/api/import?id=${detailId}` : null);
  const detail = detailLoad.data;
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const spec = TARGETS[target];
  const cols = file?.rows[0] ? Object.keys(file.rows[0]) : [];
  const missing = file ? spec.required.filter((c) => !cols.includes(c)) : [];

  const pick = async (f: File | undefined) => {
    setFormError(null); setFile(null);
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) { setFormError('Files are limited to 10 MB per batch.'); return; }
    const text = await f.text();
    try {
      const rows = f.name.toLowerCase().endsWith('.json') ? JSON.parse(text) : parseCsv(text);
      if (!Array.isArray(rows) || !rows.length) throw new Error('The file has no rows.');
      setFile({ name: f.name, rows });
    } catch (e: any) { setFormError(`Could not read ${f.name}: ${e.message}`); }
  };

  const stage = async (e: React.FormEvent) => {
    e.preventDefault(); if (!file || missing.length) return; setBusy(true); setFormError(null);
    try {
      const r = await send<any>('POST', '/api/import', { target_entity: target, province_code: province, source_file: file.name, rows: file.rows });
      setOpen(false); setFile(null);
      if (r.batch?.id) setDetailId(r.batch.id);
    } catch (err: any) { setFormError(err.message); } finally { setBusy(false); }
  };
  const run = async (action: 'validate' | 'promote', id: string) => {
    setFormError(null);
    try { await send('POST', '/api/import', { action, batch_id: id }, { also: ['/api/landowners', '/api/surveys'] }); setDetailId(id); }
    catch (err: any) { setFormError(err.message); }
  };

  return (
    <>
      {data && (
        <div className="kpis">
          <Kpi label="Batches" value={fmtNum(batches.length)} sub="files staged" />
          <Kpi label="Awaiting validation" value={fmtNum(batches.filter((b) => b.status === 'staged').length)} sub="staged" tone="w" />
          <Kpi label="Rows promoted" value={fmtNum(batches.reduce((n, b) => n + Number(b.promoted_count || 0), 0))} sub="into the register" tone="g" />
          <Kpi label="Rows with errors" value={fmtNum(batches.reduce((n, b) => n + Number(b.error_count || 0), 0))} sub="held back" tone="d" />
        </div>
      )}
      <Card icon="up" title="Data Upload" sub="Stage a CSV or JSON file, let the database validate every row, then promote the valid ones · nothing reaches the register unvalidated">
        <LoadError {...batchList} what="import batches" />
        {formError && !open && <ErrorNote>{formError}</ErrorNote>}
        {canCreate && <div className="bar"><button className="btn btn-p" onClick={() => { setFormError(null); setFile(null); setProvince(activeProvince !== 'ALL' ? activeProvince : ''); setOpen(true); }}>+ Upload file</button></div>}
        {loading && !data ? <Loading what="batches" /> : error && !data ? null : (
          <Table caption="Import batches"
            head={<><th>Batch</th><th>Target</th><th>Prov.</th><th>File</th><th className="num">Rows</th><th className="num">Valid</th><th className="num">Errors</th><th className="num">Promoted</th><th>Status</th><th>Uploaded</th><th>Actions</th></>}
            empty={batches.length ? false : 'No files uploaded yet.'} colSpan={11}>
            {batches.map((b) => (
              <tr key={b.id} {...rowOpen(() => setDetailId(b.id), `Open batch ${b.code}`)}>
                <td><span className="code">{b.code}</span><br /><small className="note mono" title={b.sha256_hex}>{String(b.sha256_hex).slice(0, 12)}…</small></td>
                <td>{TARGETS[b.target_entity]?.label ?? b.target_entity}</td>
                <td>{b.province_code ? <span className="pill">{b.province_code}</span> : '—'}</td>
                <td>{b.source_file}</td>
                <td className="num">{fmtNum(b.row_count)}</td><td className="num">{fmtNum(b.valid_count)}</td>
                <td className="num">{fmtNum(b.error_count)}</td><td className="num">{fmtNum(b.promoted_count)}</td>
                <td><Stage value={b.status} /></td>
                <td>{new Date(b.uploaded_at).toLocaleString('en-GB')}<br /><small className="note">{b.uploaded_by_name || '—'}</small></td>
                <td><div className="acts">
                  <button onClick={() => setDetailId(b.id)}>Open</button>
                  {canValidate(b) && b.status === 'staged' && <button onClick={() => run('validate', b.id)}>Validate</button>}
                  {b.status === 'validated' && Number(b.valid_count) > 0 && (canPromote(b)
                    ? <button onClick={() => run('promote', b.id)}>Promote {fmtNum(b.valid_count)}</button>
                    : <span className="note" title="Promoting rows into the register needs import:update">Awaiting promotion</span>)}
                </div></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal open={open} icon="up" title="Upload file" onClose={() => setOpen(false)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setOpen(false)}>Cancel</button>
          <button type="submit" form="imForm" className="btn btn-p" disabled={busy || !file || missing.length > 0}>{busy ? 'Staging…' : `Stage ${file ? fmtNum(file.rows.length) : ''} rows`}</button>
        </>}>
        <form id="imForm" className="fgrid" onSubmit={stage}>
          <Field label="Into" required htmlFor="imT">
            <select id="imT" value={target} onChange={(e) => setTarget(e.target.value)}>
              {Object.entries(TARGETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </Field>
          <Field label="Province" required htmlFor="imP" hint="Used for rows that do not give their own"><ProvinceSelect id="imP" required value={province} onChange={setProvince} /></Field>
          <Field label="File" required full htmlFor="imF" hint={`CSV with a header row, or a JSON array. Columns: ${spec.required.join(', ')} (required); ${spec.optional.join(', ')}.`}>
            <input id="imF" type="file" required accept=".csv,.json,text/csv,application/json" onChange={(e) => pick(e.target.files?.[0])} />
          </Field>
          {file && (<div className="fg full">
            {missing.length > 0
              ? <ErrorNote>Missing required column(s): {missing.join(', ')}</ErrorNote>
              : <p className="note">{file.name}: {fmtNum(file.rows.length)} row(s). First rows:</p>}
            <Table caption="Preview" head={<>{cols.map((c) => <th key={c}>{c}</th>)}</>} colSpan={cols.length}>
              {file.rows.slice(0, 5).map((r, i) => <tr key={i}>{cols.map((c) => <td key={c}>{String(r[c] ?? '')}</td>)}</tr>)}
            </Table>
          </div>)}
        </form>
      </Modal>

      <Modal open={!!detailId} size="lg" icon="file" title={`Batch ${detail?.batch?.code ?? ''}`} onClose={() => setDetailId(null)}
        footer={<button className="btn btn-s" onClick={() => setDetailId(null)}>Close</button>}>
        {detailLoad.error ? <LoadError {...detailLoad} what="this batch" /> : !detail ? <Loading what="batch" /> : (<>
          <div className="totals u-mb-10">
            <div><small>Status</small><b>{detail.batch.status}</b></div>
            <div><small>Rows</small><b>{fmtNum(detail.batch.row_count)}</b></div>
            <div><small>Valid</small><b>{fmtNum(detail.batch.valid_count)}</b></div>
            <div><small>Errors</small><b>{fmtNum(detail.batch.error_count)}</b></div>
            <div><small>Promoted</small><b>{fmtNum(detail.batch.promoted_count)}</b></div>
          </div>
          <div className="sec-t">Validation findings</div>
          <Table caption="Validation errors" head={<><th className="num">Line</th><th>Field</th><th>Severity</th><th>Problem</th><th>Value</th></>}
            empty={detail.errors.length ? false : detail.batch.status === 'staged' ? 'Not validated yet.' : 'No problems found.'} colSpan={5}>
            {detail.errors.map((x: any) => (
              <tr key={x.id}><td className="num">{x.source_line}</td><td className="mono">{x.field}</td>
                <td><span className={`b ${x.severity === 'error' ? 'b-d' : 'b-w'}`}>{x.severity}</span></td><td>{x.message}</td><td className="mono">{x.observed ?? '—'}</td></tr>
            ))}
          </Table>
          <div className="sec-t u-mt-16">Rows (first 200)</div>
          <Table caption="Staged rows" head={<><th className="num">Line</th><th>Status</th><th>Data</th></>} colSpan={3}>
            {detail.rows.map((r: any) => (
              <tr key={r.id}><td className="num">{r.source_line}</td><td><Stage value={r.status} /></td>
                <td className="mono u-fs-11" style={{ overflowWrap: 'anywhere' }}>{JSON.stringify(r.raw)}</td></tr>
            ))}
          </Table>
        </>)}
      </Modal>
    </>
  );
}
