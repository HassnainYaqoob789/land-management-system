'use client';

import React, { useState } from 'react';
import { Card, Field, Modal, Table } from '@/components/legacy/ui';
import { send } from '@/lib/client/api';
import { isPolicyKey } from '@/lib/iam/sso/policy-keys';
import { Done, messageOf } from './shared';

interface Setting { key: string; value: unknown; value_type: string; description: string; updated_at: string; updated_by_name: string | null }

// Runtime configuration (lms.system_setting) other than identity and security
// policy, which has its own tab and endpoint. The server returns policy keys
// only to identity readers, and refuses to change them here.
export default function GeneralTab({ data, canUpdate, reload }: { data: any; canUpdate: boolean; reload: () => void }) {
  const settings: Setting[] = data?.settings ?? [];
  const stages: any[] = data?.workflow_stages ?? [];
  // The first stage of each workflow (lowest seq) is where a record starts.
  const firstSeq = new Map<string, number>();
  for (const st of stages) firstSeq.set(st.workflow_code, Math.min(firstSeq.get(st.workflow_code) ?? Infinity, Number(st.seq)));
  const [edit, setEdit] = useState<Setting | null>(null);
  const [done, setDone] = useState<string | null>(null);

  return (
    <div className="grid2">
      <Card icon="save" title="System settings" sub="Runtime parameters stored in the database; every change is kept in the setting history.">
        <Done>{done}</Done>
        <Table caption="System settings" colSpan={4} empty={settings.length ? false : 'No settings.'}
          head={<><th>Parameter</th><th>Value</th><th>Description</th><th><span className="sr-only">Actions</span></th></>}>
          {settings.map((s) => {
            const policy = isPolicyKey(s.key);
            return (
              <tr key={s.key}>
                <td><span className="code">{s.key}</span></td>
                <td className="mono">{JSON.stringify(s.value)}</td>
                <td>{s.description || '—'}{policy && <p className="note u-mt-6">Changed under Security policy.</p>}</td>
                <td>{canUpdate && !policy && <button type="button" className="btn btn-s btn-sm" aria-label={`Change ${s.key}`}
                  onClick={() => setEdit(s)}>Change…</button>}</td>
              </tr>
            );
          })}
        </Table>
      </Card>

      <Card icon="layers" title="Workflow stages" sub="Each workflow's ordered stages (lms.workflow_stage)">
        <Table caption="Workflow stages" colSpan={4} empty={stages.length ? false : 'No workflows loaded.'}
          head={<><th>Workflow</th><th>Stage</th><th className="num">Order</th><th>Kind</th></>}>
          {stages.map((w: any) => (
            <tr key={`${w.workflow_code}-${w.code}`}>
              <td><span className="pill">{w.workflow_code}</span></td>
              <td><b>{w.label || w.code}</b></td>
              <td className="num">{w.seq}</td>
              <td>{w.is_terminal ? <span className="b b-g">Terminal</span>
                : Number(w.seq) === firstSeq.get(w.workflow_code) ? <span className="b b-i">Initial</span> : '—'}</td>
            </tr>
          ))}
        </Table>
      </Card>

      {edit && <SettingModal setting={edit} onClose={() => setEdit(null)} onSaved={(m) => { setEdit(null); setDone(m); reload(); }} />}
    </div>
  );
}

function SettingModal({ setting, onClose, onSaved }: { setting: Setting; onClose: () => void; onSaved: (m: string) => void }) {
  const [value, setValue] = useState(typeof setting.value === 'string' ? setting.value : JSON.stringify(setting.value));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      // A string setting takes the text as typed; any other type is JSON.
      const parsed = setting.value_type === 'string' ? value : JSON.parse(value);
      await send('PUT', '/api/settings', { key: setting.key, value: parsed, note: note || undefined }, { also: ['/api/reference', '/api/payments'] });
      onSaved(`Updated ${setting.key}.`);
    } catch (err) { setError(err instanceof SyntaxError ? `Enter a valid ${setting.value_type} value.` : messageOf(err)); } finally { setBusy(false); }
  };
  return (
    <Modal open icon="save" title={`Change ${setting.key}`} onClose={onClose}
      footer={<>
        {error && <span className="u-danger u-flex-1" role="alert">{error}</span>}
        <button type="button" className="btn btn-s" onClick={onClose}>Cancel</button>
        <button type="submit" form="settingForm" className="btn btn-p" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </>}>
      <form id="settingForm" onSubmit={save} className="fgrid">
        <p className="note full">{setting.description}</p>
        <Field label={`Value (${setting.value_type})`} required full htmlFor="stVal">
          <input id="stVal" required className="mono" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Field label="Reason for the change" full htmlFor="stNote" hint="Recorded with the old and new value in the setting history">
          <input id="stNote" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. FBR circular no. and date" />
        </Field>
      </form>
    </Modal>
  );
}
