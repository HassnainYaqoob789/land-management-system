'use client';

import React, { useState } from 'react';
import Shell from '@/components/layout/Shell';
import { Card, Modal, Field, Table, Toolbar, SearchBox, Count, Loading, Kpi, fmtNum } from '@/components/legacy/ui';
import { useList, RefSelect } from '@/components/legacy/data';
import { LoadError } from '@/components/auth/PageGuard';
import { send, useApi } from '@/lib/client/api';
import { useCan, useCanIn } from '@/lib/client/permissions';

export default function DocumentsPage() {
  return <Shell><DocumentsContent /></Shell>;
}

// What a document can be attached to, where to list those records, and the
// module permission that reading such a record needs (UI-09: a document is
// shown only to users who may read the record it is attached to).
const ENTITIES: Record<string, { label: string; url: string; key: string; id: string; code: string; name?: string; perm: string }> = {
  project: { label: 'Project', url: '/api/projects', key: 'projects', id: 'project_id', code: 'project_code', name: 'project_name', perm: 'projects:read' },
  survey: { label: 'Survey', url: '/api/surveys', key: 'surveys', id: 'survey_id', code: 'survey_code', name: 'survey_no', perm: 'surveys:read' },
  landowner: { label: 'Landowner', url: '/api/landowners', key: 'landowners', id: 'id', code: 'code', name: 'full_name', perm: 'landowners:read' },
  compensation_case: { label: 'Compensation case', url: '/api/cases', key: 'cases', id: 'case_id', code: 'case_code', name: 'project_name', perm: 'cases:read' },
  lease: { label: 'Lease', url: '/api/leases', key: 'leases', id: 'lease_id', code: 'lease_code', name: 'project_name', perm: 'leases:read' },
  row_corridor: { label: 'ROW corridor', url: '/api/rows', key: 'rows', id: 'id', code: 'code', name: 'name', perm: 'rows:read' },
  acquisition: { label: 'Acquisition', url: '/api/acquisitions', key: 'acquisitions', id: 'id', code: 'code', name: 'project_name', perm: 'acquisitions:read' },
  legal_case: { label: 'Legal case', url: '/api/legal', key: 'legal_cases', id: 'id', code: 'code', name: 'court_case_no', perm: 'legal:read' },
  mutation: { label: 'Mutation', url: '/api/mutations', key: 'mutations', id: 'id', code: 'code', name: 'transferor_name', perm: 'mutations:read' },
  encroachment: { label: 'Encroachment', url: '/api/encroachments', key: 'encroachments', id: 'encroachment_id', code: 'encroachment_code', perm: 'encroachments:read' },
  grievance: { label: 'Grievance', url: '/api/grievances', key: 'grievances', id: 'grievance_id', code: 'grievance_code', name: 'complainant', perm: 'grievances:read' },
  payment_request: { label: 'Payment voucher', url: '/api/payments', key: 'vouchers', id: 'id', code: 'code', name: 'payee', perm: 'payments:read' },
  dbpfc_estimate: { label: 'DBPFC estimate', url: '/api/dbpfc', key: 'dbpfc', id: 'dbpfc_id', code: 'dbpfc_code', name: 'district_name', perm: 'dbpfc:read' },
};
const sizeOf = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function DocumentsContent() {
  const can = useCan();
  const canIn = useCanIn();
  const readable = Object.entries(ENTITIES).filter(([, v]) => can(v.perm));
  const [entity, setEntity] = useState('');
  const list = useList('/api/documents', 'documents', { entity: entity || undefined });
  const { body, loading, error } = list;
  // The server filters too; this keeps documents of unreadable record types off the screen regardless.
  const rows = list.rows.filter((d: any) => !!ENTITIES[d.entity] && can(ENTITIES[d.entity].perm));
  const allTypesReadable = readable.length === Object.keys(ENTITIES).length;
  const visibleIds = new Set(rows.map((d: any) => d.id));
  const logs: any[] = (body?.access_logs ?? []).filter((l: any) => allTypesReadable || visibleIds.has(l.document_id));
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState({ entity: '', record_id: '', category_code: '' });
  const [file, setFile] = useState<File | null>(null);
  const [archive, setArchive] = useState<any | null>(null);
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const src = ENTITIES[up.entity];
  const records = (useApi(src ? src.url : null).data?.[src?.key ?? ''] as any[]) ?? [];

  const upload = async (e: React.FormEvent) => {
    e.preventDefault(); if (!file) return; setBusy(true); setFormError(null);
    const fd = new FormData();
    fd.set('file', file); fd.set('entity', up.entity); fd.set('record_id', up.record_id); fd.set('category_code', up.category_code);
    try { await send('POST', '/api/documents', fd); setOpen(false); setFile(null); setUp({ entity: '', record_id: '', category_code: '' }); }
    catch (err: any) { setFormError(err.message); } finally { setBusy(false); }
  };
  const doArchive = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setFormError(null);
    try { await send('PUT', '/api/documents', { id: archive.id, action: 'delete', delete_reason: reason }); setArchive(null); }
    catch (err: any) { setFormError(err.message); } finally { setBusy(false); }
  };

  const needle = q.trim().toLowerCase();
  const shown = needle ? rows.filter((d: any) => [d.code, d.file_name, d.record_code, d.category_name, d.sha256_hex].join(' ').toLowerCase().includes(needle)) : rows;

  return (
    <>
      {body && (
        <div className="kpis">
          <Kpi label="Documents" value={fmtNum(rows.length)} sub="stored, checksummed files" />
          <Kpi label="Stored size" value={sizeOf(rows.reduce((n: number, d: any) => n + Number(d.size_bytes || 0), 0) || 0)} sub="across all versions" />
          <Kpi label="Downloads logged" value={fmtNum(rows.reduce((n: number, d: any) => n + Number(d.access_count || 0), 0))} sub="every access is recorded" tone="g" />
        </div>
      )}
      <Card icon="folder" title="Documents"
        sub="Files attached to land records · type checked from the file itself · SHA-256 of the bytes verified on every download">
        <LoadError {...list} what="documents" />
        {can('documents:create') && readable.length > 0 && (
          <div className="bar"><button className="btn btn-p" onClick={() => { setFormError(null); setOpen(true); }}>+ Upload Document</button></div>
        )}
        <Toolbar>
          <SearchBox value={q} onChange={setQ} placeholder="Search code, file, record, category or checksum…" />
          <select className="sel" aria-label="Record type" value={entity} onChange={(e) => setEntity(e.target.value)}>
            <option value="">All record types</option>
            {readable.map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <Count n={shown.length} />
        </Toolbar>
        {loading ? <Loading what="documents" /> : error && !body ? null : (
          <Table caption="Documents"
            head={<><th>Document</th><th>File</th><th>Attached to</th><th>Category</th><th className="num">Size</th><th className="num">Version</th>
              <th>SHA-256</th><th>Uploaded</th><th>Actions</th></>}
            empty={shown.length ? false : 'No documents.'} colSpan={9}>
            {shown.map((d: any) => (
              <tr key={d.id}>
                <td><span className="code">{d.code}</span></td>
                <td>{d.file_name}<br /><small className="note">{d.mime_type}</small></td>
                <td>{ENTITIES[d.entity]?.label ?? d.entity}<br /><small className="note mono">{d.record_code}</small></td>
                <td>{d.category_name}</td>
                <td className="num">{sizeOf(Number(d.size_bytes))}</td>
                <td className="num">{d.version}</td>
                <td className="mono u-fs-11" title={d.sha256_hex}>{String(d.sha256_hex).slice(0, 12)}…</td>
                <td>{new Date(d.uploaded_at).toLocaleString('en-GB')}<br /><small className="note">{d.uploaded_by_name || '—'}</small></td>
                <td><div className="acts">
                  <a href={`/api/documents?download=${d.id}`}>Download</a>
                  {canIn('documents:update', d.province_code) && <button className="del" onClick={() => { setFormError(null); setReason(''); setArchive(d); }}>Archive</button>}
                </div></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {body && <Card icon="receipt" title="Access log" sub="Latest downloads and views">
        <Table caption="Document access log" head={<><th>When</th><th>Document</th><th>Action</th><th>By</th></>}
          empty={logs.length ? false : 'No access recorded yet.'} colSpan={4}>
          {logs.map((l) => (
            <tr key={l.id}>
              <td>{new Date(l.accessed_at).toLocaleString('en-GB')}</td>
              <td><span className="code">{l.doc_code}</span> {l.file_name}</td>
              <td><span className="b b-n">{l.action}</span></td>
              <td>{l.user_name || '—'}</td>
            </tr>
          ))}
        </Table>
      </Card>}

      <Modal open={open} icon="up" title="Upload Document" onClose={() => setOpen(false)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setOpen(false)}>Cancel</button>
          <button type="submit" form="upForm" className="btn btn-p" disabled={busy || !file}>{busy ? 'Uploading…' : 'Upload'}</button>
        </>}>
        <form id="upForm" onSubmit={upload} className="fgrid">
          <Field label="Record type" required htmlFor="upEnt">
            <select id="upEnt" required value={up.entity} onChange={(e) => setUp((u) => ({ ...u, entity: e.target.value, record_id: '' }))}>
              <option value="">— Select —</option>
              {readable.map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </Field>
          <Field label="Record" required htmlFor="upRec">
            <select id="upRec" required value={up.record_id} disabled={!src} onChange={(e) => setUp((u) => ({ ...u, record_id: e.target.value }))}>
              <option value="">— Select —</option>
              {src && records.map((r: any) => <option key={r[src.id]} value={r[src.id]}>{r[src.code]}{src.name && r[src.name] ? ` — ${r[src.name]}` : ''}</option>)}
            </select>
          </Field>
          <Field label="Category" required htmlFor="upCat"><RefSelect id="upCat" required source="lookup:document_category" value={up.category_code} onChange={(v) => setUp((u) => ({ ...u, category_code: v }))} /></Field>
          <Field label="File" required htmlFor="upFile" hint="PDF, JPEG, PNG, TIFF, Word (.docx) or Excel (.xlsx), up to 50 MB">
            <input id="upFile" type="file" required accept=".pdf,.jpg,.jpeg,.png,.tif,.tiff,.docx,.xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
        </form>
      </Modal>

      <Modal open={!!archive} size="sm" icon="trash" title={`Archive ${archive?.code ?? ''}`} onClose={() => setArchive(null)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setArchive(null)}>Cancel</button>
          <button type="submit" form="arForm" className="btn btn-d" disabled={busy}>Archive</button>
        </>}>
        <form id="arForm" onSubmit={doArchive}>
          <p className="u-mb-10">The file is kept and the record remains in the audit trail; it is hidden from the repository.</p>
          <Field label="Reason" required htmlFor="arWhy"><textarea id="arWhy" required minLength={5} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </form>
      </Modal>
    </>
  );
}
