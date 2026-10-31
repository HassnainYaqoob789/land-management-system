'use client';

// Create a custom role (code, name, description, database tier) or edit an
// existing one's name and description. The tier cannot be above the creator's
// own and is fixed after creation; a role code never changes.

import React, { useState } from 'react';
import { Modal, Field } from '@/components/legacy/ui';
import { send } from '@/lib/client/api';
import { roleCodeProblem } from './model';
import type { RoleSummary, Tier } from './types';

export default function RoleForm({ role, tiers, actorTierRank, onClose, onCreated }: {
  role: RoleSummary | null; tiers: Tier[]; actorTierRank: number; onClose: () => void; onCreated?: (code: string) => void;
}) {
  const editing = !!role;
  const [form, setForm] = useState({ code: '', name: role?.name ?? '', description: role?.description ?? '', db_role_code: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const usable = tiers.filter((t) => t.code !== 'Admin' && t.rank <= actorTierRank);
  const codeProblem = !editing && form.code ? roleCodeProblem(form.code) : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (editing) {
        await send('PATCH', `/api/roles/${role!.code}`, { name: form.name, description: form.description, version: role!.version });
        onClose();
      } else {
        const r = await send<{ role: RoleSummary }>('POST', '/api/roles', form);
        if (onCreated) onCreated(r.role.code); else onClose();
      }
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <Modal open icon={editing ? 'edit' : 'plus'} title={editing ? `Edit ${role!.name}` : 'New role'} onClose={onClose}
      footer={<>
        {error && <span className="u-danger u-flex-1" role="alert">{error}</span>}
        <button type="button" className="btn btn-s" onClick={onClose}>Cancel</button>
        <button type="submit" form="roleForm" className="btn btn-p" disabled={busy || !!codeProblem}>{busy ? 'Saving…' : editing ? 'Save' : 'Create role'}</button>
      </>}>
      <form id="roleForm" className="fgrid" onSubmit={submit}>
        {!editing && (
          <Field label="Code" required htmlFor="rfCode" hint={codeProblem ?? 'Lower-case letters, digits and hyphens; it never changes.'}>
            <input id="rfCode" required className="mono" pattern="[a-z][a-z0-9-]{2,30}" value={form.code} aria-invalid={!!codeProblem}
              onChange={(e) => setForm({ ...form, code: e.target.value.toLowerCase() })} />
          </Field>
        )}
        <Field label="Name" required htmlFor="rfName"><input id="rfName" required minLength={3} maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        {!editing && (
          <Field label="Database tier" required htmlFor="rfTier" hint="What row-level security lets members do. It cannot be above your own tier, and cannot be changed later.">
            <select id="rfTier" required value={form.db_role_code} onChange={(e) => setForm({ ...form, db_role_code: e.target.value })}>
              <option value="">— Select —</option>
              {tiers.filter((t) => t.code !== 'Admin').map((t) => (
                <option key={t.code} value={t.code} disabled={!usable.includes(t)}>{t.name}{!usable.includes(t) ? ' (above your tier)' : ''}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Description" full htmlFor="rfDesc"><textarea id="rfDesc" maxLength={500} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        {!editing && <div className="fg full"><p className="note">The new role starts active with no permissions; add them with “Permissions”.</p></div>}
      </form>
    </Modal>
  );
}
