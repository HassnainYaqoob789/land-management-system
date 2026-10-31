'use client';

// The permissions of one role, grouped by resource, each with a scope. Only
// what the editor holds can be granted, at their scope or a narrower one;
// anything else is shown disabled with the reason. The server re-checks every
// change and the database guards decide (delegation, separation of duties).

import React, { useMemo, useState } from 'react';
import { Modal, ErrorNote } from '@/components/legacy/ui';
import { send } from '@/lib/client/api';
import {
  SCOPES, SCOPE_LABEL, canChange, diffPermissions, fingerprint, grantableScopes, groupByResource, permKey, scopeLabel, scopeRank,
  type RolePerm,
} from './model';
import type { CatalogueEntry, RoleSummary } from './types';

export default function PermissionEditor({ role, catalogue, holds, onClose }: {
  role: RoleSummary; catalogue: CatalogueEntry[]; holds: Record<string, string>; onClose: () => void;
}) {
  const initial = useMemo(() => Object.fromEntries(role.permissions.map((p) => [permKey(p), p.scope_level])) as Record<string, string>, [role]);
  const [sel, setSel] = useState<Record<string, string>>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');

  const next: RolePerm[] = Object.entries(sel).map(([k, s]) => { const [resource, action] = k.split(':'); return { resource, action, scope_level: s }; });
  const diff = diffPermissions(role.permissions, next);
  const pending = diff.added.length + diff.removed.length + diff.changed.length;
  const needle = q.trim().toLowerCase();
  const groups = groupByResource(catalogue.filter((p) => !needle || `${p.resource} ${p.action} ${p.description}`.toLowerCase().includes(needle)));

  const toggle = (key: string, on: boolean) => setSel((s) => {
    const copy = { ...s };
    if (on) {
      const options = grantableScopes(holds, key);
      // Start at the role's original scope if it had one, else the widest the editor can grant.
      copy[key] = initial[key] && (options as string[]).includes(initial[key]) ? initial[key] : options[0];
    } else delete copy[key];
    return copy;
  });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await send('PUT', `/api/roles/${role.code}/permissions`, { permissions: next, base: fingerprint(role.permissions) }, { also: ['/api/users'] });
      onClose();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <Modal open size="lg" icon="shield" title={`Permissions — ${role.name}`} onClose={onClose}
      footer={<>
        {error && <span className="u-danger u-flex-1" role="alert">{error}</span>}
        <span className="note u-flex-1" aria-live="polite">{pending ? `${pending} change(s): +${diff.added.length} −${diff.removed.length} ~${diff.changed.length}` : 'No changes yet.'}</span>
        <button type="button" className="btn btn-s" onClick={onClose}>Cancel</button>
        <button type="submit" form="permEditor" className="btn btn-p" disabled={busy || !pending}>{busy ? 'Saving…' : 'Save permissions'}</button>
      </>}>
      <form id="permEditor" onSubmit={save}>
        <p className="note u-mb-10">
          You can grant a permission only if you hold it yourself, at the same scope or a narrower one, and remove or
          re-scope one only if you hold it at the scope it has now. Scope: Global and Head Office reach every province;
          Province reaches the member&apos;s provinces; Project and Assigned records narrow it further.
        </p>
        <div className="bar"><input className="search" type="search" aria-label="Filter permissions" placeholder="Filter permissions…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {error && <ErrorNote>{error}</ErrorNote>}
        {groups.map(([resource, list]) => (
          <section key={resource} aria-labelledby={`pe-h-${resource}`}>
            <h4 id={`pe-h-${resource}`} className="u-subhead mono">{resource}</h4>
            <div className="tw" tabIndex={0} role="region" aria-label={`${resource} permissions`}>
              <table className="t">
                <thead><tr><th scope="col">Action</th><th scope="col">Granted</th><th scope="col">Scope</th><th scope="col">Why not</th></tr></thead>
                <tbody>
                  {list.map((p) => {
                    const key = permKey(p);
                    const on = key in sel;
                    const orig = initial[key] ?? null;
                    const options = grantableScopes(holds, key);
                    const canToggle = on ? canChange(holds, key, orig, null) : options.length > 0;
                    const canScope = on && canChange(holds, key, orig, sel[key]) && options.length > 0;
                    const why = !holds[key] ? 'You do not hold this permission.'
                      : orig && scopeRank(holds[key]) < scopeRank(orig) ? `You hold it only at ${scopeLabel(holds[key])} scope.` : '';
                    const id = `pe-${key.replace(':', '-')}`;
                    return (
                      <tr key={key}>
                        <td><label htmlFor={id}><b>{p.action}</b></label>{p.is_sensitive && <> <span className="b b-w" title="Sensitive: re-authentication and two-step verification apply">sensitive</span></>}
                          <br /><small className="note">{p.description}</small></td>
                        <td><input id={id} type="checkbox" checked={on} disabled={!canToggle} onChange={(e) => toggle(key, e.target.checked)}
                          aria-describedby={why ? `${id}-why` : undefined} /></td>
                        <td>
                          <select aria-label={`Scope of ${key}`} value={on ? sel[key] : ''} disabled={!canScope}
                            onChange={(e) => setSel((s) => ({ ...s, [key]: e.target.value }))}>
                            {!on && <option value="">—</option>}
                            {SCOPES.map((s) => (
                              <option key={s} value={s} disabled={!options.includes(s)}>{SCOPE_LABEL[s]}</option>
                            ))}
                          </select>
                        </td>
                        <td><small id={`${id}-why`} className="note">{why}</small></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ))}
        {!groups.length && <div className="empty">No permission matches “{q}”.</div>}
      </form>
    </Modal>
  );
}
