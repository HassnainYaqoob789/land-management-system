'use client';

import React, { useState } from 'react';
import { Card, Field, Table } from '@/components/legacy/ui';
import { send } from '@/lib/client/api';
import { Done, messageOf, type IdentityData } from './shared';

// External group → role / approval position / province. The only way an
// external sign-in receives access; nothing is granted without a row here.
export default function MappingsTab({ data, reload }: { data: IdentityData; reload: () => void }) {
  const can = data.canConfigure;
  const [form, setForm] = useState({ providerId: '', externalGroup: '', roleCode: '', approvalGroup: '', province: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy('add'); setError(null); setDone(null);
    try {
      await send('POST', '/api/settings/identity/mappings', form);
      setDone(`Mapped “${form.externalGroup}”. It applies from each person’s next sign-in.`);
      setForm((f) => ({ ...f, externalGroup: '', roleCode: '', approvalGroup: '', province: '' }));
      reload();
    } catch (err) { setError(messageOf(err)); } finally { setBusy(null); }
  };
  const remove = async (id: string, group: string) => {
    setBusy(id); setError(null); setDone(null);
    try {
      await send('DELETE', `/api/settings/identity/mappings?id=${encodeURIComponent(id)}`);
      setDone(`Removed the mapping for “${group}”. Access it already gave stays until revoked on the Users screen.`);
      reload();
    } catch (err) { setError(messageOf(err)); } finally { setBusy(null); }
  };

  return (
    <Card icon="layers" title="Group mappings"
      sub="A directory or IdP group grants a role, an approval position or a province only through a mapping here. Roles that administer users, roles or identity, or hold sensitive permissions, are assigned by hand on the Users screen.">
      {error && <div className="al d" role="alert"><span className="i" /><div className="tx">{error}</div></div>}
      <Done>{done}</Done>
      <Table caption="Group mappings" colSpan={5} empty={data.mappings.length ? false : 'No mappings: external sign-ins receive no access.'}
        head={<><th>Provider</th><th>External group</th><th>Role</th><th>Approval position / province</th><th><span className="sr-only">Actions</span></th></>}>
        {data.mappings.map((m) => (
          <tr key={m.id}>
            <td>{m.providerDisplayName} <span className="code">{m.providerName}</span></td>
            <td className="mono">{m.externalGroup}</td>
            <td>{m.roleName ?? '—'}</td>
            <td>{[m.approvalGroup, m.provinceName].filter(Boolean).join(' · ') || '—'}</td>
            <td>{can && <button type="button" className="btn btn-d btn-sm" disabled={busy !== null}
              aria-label={`Remove mapping for ${m.externalGroup}`} onClick={() => remove(m.id, m.externalGroup)}>Remove</button>}</td>
          </tr>
        ))}
      </Table>

      {can && data.providers.length > 0 && (
        <form onSubmit={add} className="fgrid u-mt-16">
          <div className="sec-t full">Add a mapping</div>
          <Field label="Provider" required htmlFor="gmProv">
            <select id="gmProv" required value={form.providerId} onChange={set('providerId')}>
              <option value="">— Choose —</option>
              {data.providers.map((p) => <option key={p.id} value={p.id}>{p.displayName} ({p.kindLabel})</option>)}
            </select>
          </Field>
          <Field label="External group" required htmlFor="gmGroup" hint="Exactly as the provider sends it: a group name, or a directory group’s full DN.">
            <input id="gmGroup" required maxLength={256} value={form.externalGroup} onChange={set('externalGroup')} placeholder="e.g. LMS-LandOfficers" />
          </Field>
          <Field label="Role" htmlFor="gmRole">
            <select id="gmRole" value={form.roleCode} onChange={set('roleCode')}>
              <option value="">— None —</option>
              {data.roles.map((r) => <option key={r.code} value={r.code} disabled={!r.mappable}>{r.name}{r.mappable ? '' : ' (assign by hand)'}</option>)}
            </select>
          </Field>
          <Field label="Approval position" htmlFor="gmPos">
            <select id="gmPos" value={form.approvalGroup} onChange={set('approvalGroup')}>
              <option value="">— None —</option>
              {data.approvalGroups.map((g) => <option key={g.code} value={g.code}>{g.name}</option>)}
            </select>
          </Field>
          <Field label="Province" htmlFor="gmProvince">
            <select id="gmProvince" value={form.province} onChange={set('province')}>
              <option value="">— None —</option>
              {data.provinces.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
            </select>
          </Field>
          <div className="fg full bar">
            <button type="submit" className="btn btn-p" disabled={busy !== null || !(form.roleCode || form.approvalGroup || form.province)}>
              {busy === 'add' ? 'Adding…' : 'Add mapping'}</button>
          </div>
        </form>
      )}
    </Card>
  );
}
