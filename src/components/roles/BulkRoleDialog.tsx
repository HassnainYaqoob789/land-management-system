'use client';

// Grant or revoke one role for many accounts at once. The server applies it in
// one transaction: either every account changes or none does, and a refusal
// lists each account that could not change and why.

import React, { useState } from 'react';
import { Modal, Field, Table } from '@/components/legacy/ui';
import { invalidate } from '@/lib/client/api';
import { endOfDay, type AccessRole } from './UserAccess';

interface Picked { id: string; username: string; full_name: string }
interface Refusal { user_id: string | null; username: string | null; error: string }

export default function BulkRoleDialog({ users, roles, grantableProvinces, onClose, onDone }: {
  users: Picked[]; roles: AccessRole[]; grantableProvinces: string[]; onClose: () => void; onDone: (message: string) => void;
}) {
  const [mode, setMode] = useState<'assign' | 'revoke'>('assign');
  const [form, setForm] = useState({ role_code: '', scope_province: '', expires_on: '', reason: '' });
  const [error, setError] = useState<string | null>(null);
  const [refusals, setRefusals] = useState<Refusal[]>([]);
  const [busy, setBusy] = useState(false);
  const isAdminRole = form.role_code === 'system-administrator';
  const usable = roles.filter((r) => r.status !== 'retired' && (mode === 'revoke' || (r.status === 'active' && r.grantable)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null); setRefusals([]);
    const body = mode === 'assign'
      ? { action: 'bulk_assign', user_ids: users.map((u) => u.id), role_code: form.role_code, reason: form.reason,
          scope_province: isAdminRole ? undefined : form.scope_province || undefined, expires_at: isAdminRole ? undefined : endOfDay(form.expires_on) }
      : { action: 'bulk_revoke', user_ids: users.map((u) => u.id), role_code: form.role_code, reason: form.reason };
    try {
      // fetch, not send(): a refusal carries the per-account list. (The shell
      // adds the CSRF token and handles re-authentication.)
      const res = await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || `Request failed (${res.status})`); setRefusals(Array.isArray(data.errors) ? data.errors : []); return; }
      invalidate('/api/users', '/api/roles');
      onDone(mode === 'assign' ? `Role granted to ${data.assigned} account(s).` : `Role revoked from ${data.accounts} account(s).`);
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <Modal open icon="lock" title={`Bulk role change — ${users.length} account(s)`} onClose={onClose}
      footer={<>
        <button type="button" className="btn btn-s" onClick={onClose}>Cancel</button>
        <button type="submit" form="bulkRole" className={`btn ${mode === 'revoke' ? 'btn-d' : 'btn-p'}`} disabled={busy || !users.length}>
          {busy ? 'Saving…' : mode === 'assign' ? `Grant to ${users.length}` : `Revoke from ${users.length}`}</button>
      </>}>
      <form id="bulkRole" className="fgrid" onSubmit={submit}>
        <div className="fg full">
          <p className="note">All or nothing: if any account cannot change, none does, and each refusal is listed below.</p>
          <p className="u-mt-6">{users.map((u) => <span key={u.id} className="pill" title={u.full_name}>{u.username}</span>)}</p>
        </div>
        <Field label="Change" required htmlFor="brMode">
          <select id="brMode" value={mode} onChange={(e) => { setMode(e.target.value as 'assign' | 'revoke'); setForm({ ...form, role_code: '' }); }}>
            <option value="assign">Grant a role</option><option value="revoke">Revoke a role</option>
          </select>
        </Field>
        <Field label="Role" required htmlFor="brRole">
          <select id="brRole" required value={form.role_code} onChange={(e) => setForm({ ...form, role_code: e.target.value })}>
            <option value="">— Select —</option>{usable.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
          </select>
        </Field>
        {mode === 'assign' && !isAdminRole && (<>
          <Field label="Limited to province" htmlFor="brScope" hint="Every chosen account must have this province.">
            <select id="brScope" value={form.scope_province} onChange={(e) => setForm({ ...form, scope_province: e.target.value })}>
              <option value="">All each account&apos;s provinces</option>{grantableProvinces.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Expires on" htmlFor="brExp"><input id="brExp" type="date" value={form.expires_on} onChange={(e) => setForm({ ...form, expires_on: e.target.value })} /></Field>
        </>)}
        <Field label="Reason" required full htmlFor="brReason"><input id="brReason" required minLength={5} maxLength={300} value={form.reason}
          onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
      </form>
      {error && <div className="al d u-mt-10" role="alert"><span className="i" /><div className="tx">{error}</div></div>}
      {refusals.length > 0 && (
        <Table caption="Accounts that could not change" head={<><th>Account</th><th>Why</th></>} colSpan={2}>
          {refusals.map((r, i) => <tr key={r.user_id ?? i}><td className="mono">{r.username ?? r.user_id ?? '—'}</td><td>{r.error}</td></tr>)}
        </Table>
      )}
    </Modal>
  );
}
