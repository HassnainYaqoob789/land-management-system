'use client';

// Saved report templates: save as, update, rename, delete, set default and —
// with reports:share — share with everyone who may read reports or only with
// the user's department. The database enforces the same rules (row-level
// security on lms.report_template); these controls only hide what would be refused.

import React, { useState } from 'react';
import { send } from '@/lib/client/api';
import { Field, Modal } from '@/components/legacy/ui';
import type { ExportFormat, ReportConfig, TemplateInfo } from '@/lib/reporting/types';

const TPL = '/api/reports/templates';

type Body = {
  name: string; description?: string; config: ReportConfig; visibility: 'private' | 'shared';
  sharedDepartment?: string | null; isDefault?: boolean; exportFormat?: ExportFormat | null;
};

const bodyOf = (t: TemplateInfo, config: ReportConfig, patch: Partial<Body> = {}): Body => ({
  name: t.name, description: t.description ?? undefined, config, visibility: t.visibility,
  sharedDepartment: t.sharedDepartment, isDefault: t.isDefault, exportFormat: t.exportFormat, ...patch,
});

/** A template list from the API (an array, or { templates } from an older build). */
export function templatesOf(data: unknown): TemplateInfo[] {
  if (Array.isArray(data)) return data as TemplateInfo[];
  const t = (data as { templates?: unknown })?.templates;
  return Array.isArray(t) ? (t as TemplateInfo[]) : [];
}

export function SharedBadge({ t }: { t: TemplateInfo }) {
  if (t.visibility !== 'shared') return null;
  return <span className="b b-i" title={t.mine ? 'You share this template' : `Shared by ${t.owner}`}>
    shared{t.sharedDepartment ? ` · ${t.sharedDepartment}` : ''}{t.mine ? '' : ` · ${t.owner}`}
  </span>;
}

function SaveDialog({ open, onClose, initial, canShare, department, onSave, title }: {
  open: boolean; onClose: () => void; initial: Partial<Body>; canShare: boolean; department: string | null;
  onSave: (b: Omit<Body, 'config'>) => Promise<void>; title: string;
}) {
  const [name, setName] = useState(initial.name ?? '');
  const [description, setDescription] = useState(initial.description ?? '');
  const [share, setShare] = useState<'private' | 'all' | 'dept'>(initial.visibility === 'shared' ? (initial.sharedDepartment ? 'dept' : 'all') : 'private');
  const [isDefault, setIsDefault] = useState(!!initial.isDefault);
  const [exportFormat, setExportFormat] = useState<string>(initial.exportFormat ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setErr('Give the template a name.'); return; }
    setBusy(true); setErr('');
    try {
      await onSave({
        name: name.trim(), description: description.trim() || undefined,
        visibility: share === 'private' ? 'private' : 'shared', sharedDepartment: share === 'dept' ? department : null,
        isDefault, exportFormat: (exportFormat || null) as ExportFormat | null,
      });
      onClose();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={title} icon="save"
      footer={<><button type="button" className="btn btn-s" onClick={onClose}>Cancel</button>
        <button type="submit" form="rptTplForm" className="btn btn-p" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <form id="rptTplForm" onSubmit={submit} noValidate>
        {err && <div className="al d u-mb-8" role="alert"><span className="i" /><div className="tx">{err}</div></div>}
        <Field label="Name" required htmlFor="rptTplName">
          <input id="rptTplName" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description" htmlFor="rptTplDesc">
          <textarea id="rptTplDesc" maxLength={500} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {canShare ? (
          <Field label="Who can use it" htmlFor="rptTplShare" hint="Shared templates are read-only for others; they can save their own copy.">
            <select id="rptTplShare" value={share} onChange={(e) => setShare(e.target.value as typeof share)}>
              <option value="private">Only me</option>
              <option value="all">Everyone who can read reports</option>
              {department && <option value="dept">My department ({department})</option>}
            </select>
          </Field>
        ) : <p className="note">Only you can see this template.</p>}
        <Field label="Preferred export format" htmlFor="rptTplFmt">
          <select id="rptTplFmt" value={exportFormat} onChange={(e) => setExportFormat(e.target.value)}>
            <option value="">No preference</option><option value="pdf">PDF</option><option value="xlsx">Excel</option><option value="csv">CSV</option>
          </select>
        </Field>
        <div className="checks"><label><input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} /> My default for this dataset</label></div>
      </form>
    </Modal>
  );
}

export default function TemplatesPanel({ config, current, canShare, department, onSaved, onDeleted }: {
  config: ReportConfig | null; current: TemplateInfo | null; canShare: boolean; department: string | null;
  onSaved: (t: TemplateInfo | null) => void; onDeleted: () => void;
}) {
  const [dialog, setDialog] = useState<'new' | 'edit' | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const mine = !!current?.mine;
  const canDelete = !!current && (current.mine || (canShare && current.visibility === 'shared'));

  const act = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await f(); setMsg({ kind: 'ok', text: ok }); } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); } finally { setBusy(false); }
  };
  const saved = (res: unknown): TemplateInfo | null => (res && typeof res === 'object' && 'id' in (res as object) ? res as TemplateInfo : null);

  return (
    <div className="u-mb-10">
      <div className="bar" style={{ flexWrap: 'wrap', gap: 6 }} aria-label="Template actions">
        {current && <span className="note">Template: <b>{current.name}</b> <SharedBadge t={current} />{current.isDefault && <span className="b b-g"> default</span>}</span>}
        <button type="button" className="btn btn-s btn-sm" disabled={!config || busy} onClick={() => setDialog('new')}>Save as template…</button>
        {mine && config && (
          <button type="button" className="btn btn-s btn-sm" disabled={busy}
            onClick={() => act(async () => onSaved(saved(await send('PUT', `${TPL}?id=${encodeURIComponent(current!.id)}`, bodyOf(current!, config)))), `Template “${current!.name}” updated.`)}>
            Update template
          </button>
        )}
        {mine && config && <button type="button" className="btn btn-s btn-sm" disabled={busy} onClick={() => setDialog('edit')}>Rename / sharing…</button>}
        {mine && config && !current!.isDefault && (
          <button type="button" className="btn btn-s btn-sm" disabled={busy}
            onClick={() => act(async () => onSaved(saved(await send('PUT', `${TPL}?id=${encodeURIComponent(current!.id)}`, bodyOf(current!, current!.config, { isDefault: true })))), `“${current!.name}” is now your default for this dataset.`)}>
            Set as default
          </button>
        )}
        {canDelete && (
          <button type="button" className="btn btn-s btn-sm" disabled={busy}
            onClick={() => { if (window.confirm(`Delete the template “${current!.name}”? This cannot be undone.`)) act(async () => { await send('DELETE', `${TPL}?id=${encodeURIComponent(current!.id)}`); onDeleted(); }, 'Template deleted.'); }}>
            Delete template
          </button>
        )}
      </div>
      {msg && <div className={`al ${msg.kind === 'ok' ? 'i' : 'd'} u-mt-6`} role={msg.kind === 'ok' ? 'status' : 'alert'}><span className="i" /><div className="tx">{msg.text}</div></div>}
      {dialog && config && (
        <SaveDialog open onClose={() => setDialog(null)} canShare={canShare} department={department}
          title={dialog === 'new' ? 'Save as template' : 'Template details'}
          initial={dialog === 'edit' && current ? bodyOf(current, config) : { name: current ? `${current.name} (copy)` : '', visibility: 'private' }}
          onSave={async (b) => {
            const res = dialog === 'edit' && current
              ? await send('PUT', `${TPL}?id=${encodeURIComponent(current.id)}`, { ...b, config: current.config })
              : await send('POST', TPL, { ...b, config });
            onSaved(saved(res));
            setMsg({ kind: 'ok', text: `Template “${b.name}” saved.` });
          }} />
      )}
    </div>
  );
}
