'use client';

import React, { useState } from 'react';
import { Card, Field, Modal, Table } from '@/components/legacy/ui';
import { send } from '@/lib/client/api';
import { POLICY_FIELDS, type PolicyField } from '@/lib/iam/sso/policy-keys';
import { Done, messageOf, when, type IdentityData, type PolicyRow } from './shared';

const show = (v: unknown) => (Array.isArray(v) ? (v.length ? v.join(', ') : '(none)') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v));

// Authentication and security policy, changed only through iam.set_policy
// (validated, recorded as a security event).
export default function PolicyTab({ data, reload }: { data: IdentityData; reload: () => void }) {
  const [edit, setEdit] = useState<PolicyRow | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <Card icon="lock" title="Security policy" sub="Sign-in, session, lockout, MFA and provisioning rules. Each change is validated and recorded as a security event.">
      <Done>{done}</Done>
      <Table caption="Security policy" colSpan={4} empty={data.policy.length ? false : 'No policy settings.'}
        head={<><th>Setting</th><th>Value</th><th>Last changed</th><th><span className="sr-only">Actions</span></th></>}>
        {data.policy.map((s) => {
          const field = POLICY_FIELDS[s.key];
          return (
            <tr key={s.key}>
              <td><b>{s.description || s.key}</b><br /><span className="code">{s.key}</span></td>
              <td className="mono">{show(s.value)}{field?.type === 'number' && field.unit ? ` ${field.unit}` : ''}
                {field?.type === 'fixed' && <p className="note u-mt-6">{field.note}</p>}</td>
              <td>{when(s.updated_at)}</td>
              <td>{data.canConfigure && field?.type !== 'fixed' &&
                <button type="button" className="btn btn-s btn-sm" aria-label={`Change ${s.key}`} onClick={() => setEdit(s)}>Change…</button>}</td>
            </tr>
          );
        })}
      </Table>
      {edit && <PolicyModal row={edit} roles={data.roles} onClose={() => setEdit(null)}
        onSaved={(m) => { setEdit(null); setDone(m); reload(); }} />}
    </Card>
  );
}

function PolicyModal({ row, roles, onClose, onSaved }: {
  row: PolicyRow; roles: IdentityData['roles']; onClose: () => void; onSaved: (m: string) => void;
}) {
  const field: PolicyField | undefined = POLICY_FIELDS[row.key];
  const [value, setValue] = useState<any>(field?.type === 'roles' ? (Array.isArray(row.value) ? row.value : [])
    : field ? row.value : JSON.stringify(row.value));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typed = (): unknown => {
    if (!field) return JSON.parse(String(value));                       // raw JSON for keys the form does not know
    if (field.type === 'number') return Number(value);
    if (field.type === 'boolean') return value === true || value === 'true';
    return value;
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      await send('PUT', '/api/settings/policy', { key: row.key, value: typed(), note: note || undefined });
      onSaved(`Changed ${row.key}.`);
    } catch (err) { setError(err instanceof SyntaxError ? 'The value is not valid JSON.' : messageOf(err)); } finally { setBusy(false); }
  };

  return (
    <Modal open icon="lock" title={`Change ${row.key}`} onClose={onClose}
      footer={<>
        {error && <span className="u-danger u-flex-1" role="alert">{error}</span>}
        <button type="button" className="btn btn-s" onClick={onClose}>Cancel</button>
        <button type="submit" form="policyForm" className="btn btn-p" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </>}>
      <form id="policyForm" onSubmit={save} className="fgrid">
        <p className="note full">{row.description}</p>
        {field?.type === 'number' && (
          <Field label={`Value (${field.min}–${field.max}${field.unit ? ` ${field.unit}` : ''})`} required htmlFor="polVal">
            <input id="polVal" type="number" required min={field.min} max={field.max} step={1} value={String(value)} onChange={(e) => setValue(e.target.value)} />
          </Field>
        )}
        {field?.type === 'boolean' && (
          <Field label="Value" required htmlFor="polVal">
            <select id="polVal" value={String(value)} onChange={(e) => setValue(e.target.value === 'true')}>
              <option value="true">Yes</option><option value="false">No</option>
            </select>
          </Field>
        )}
        {field?.type === 'choice' && (
          <Field label="Value" required full htmlFor="polVal">
            <select id="polVal" value={String(value)} onChange={(e) => setValue(e.target.value)}>
              {field.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
        )}
        {field?.type === 'roles' && (
          <fieldset className="fg full">
            <legend>Roles that must use MFA</legend>
            {roles.filter((r) => r.status !== 'retired').map((r) => (
              <label key={r.code} className="u-nowrap" style={{ display: 'block' }}>
                <input type="checkbox" checked={(value as string[]).includes(r.code)}
                  onChange={(e) => setValue((v: string[]) => (e.target.checked ? [...v, r.code] : v.filter((x) => x !== r.code)))} /> {r.name}
              </label>
            ))}
            <small>Roles with sensitive permissions require MFA whatever is chosen here.</small>
          </fieldset>
        )}
        {!field && (
          <Field label="Value (JSON)" required full htmlFor="polVal">
            <textarea id="polVal" className="mono" required value={String(value)} onChange={(e) => setValue(e.target.value)} />
          </Field>
        )}
        <Field label="Reason for the change" full htmlFor="polNote" hint="Recorded with the old and new value.">
          <input id="polNote" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}
