'use client';

// Activate, suspend or retire a role, with a reason (iam.set_role_status).
// Suspending keeps the assignments but they confer nothing from the next
// request; retiring is final and needs the role to have no members.

import React, { useState } from 'react';
import { Modal, Field } from '@/components/legacy/ui';
import { send } from '@/lib/client/api';
import { STATUS_LABEL, statusTargets, type RoleStatus } from './model';
import type { RoleSummary } from './types';

const EXPLAIN: Record<RoleStatus, string> = {
  active: 'Members get the role\'s permissions again from their next request.',
  inactive: 'Members keep the assignment, but it confers nothing from their next request until the role is reactivated.',
  retired: 'Final: a retired role cannot be assigned, edited or reactivated. It must have no members.',
};

export default function RoleStatusDialog({ role, can, onClose }: {
  role: RoleSummary; can: { update: boolean; delete: boolean }; onClose: () => void;
}) {
  const targets = statusTargets(role.status, role.is_system).filter((s) => (s === 'retired' ? can.delete : can.update));
  const [status, setStatus] = useState<RoleStatus | ''>(targets[0] ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const retireBlocked = status === 'retired' && role.member_count > 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!status) return;
    setBusy(true); setError(null);
    try {
      await send('POST', `/api/roles/${role.code}/status`, { status, reason }, { also: ['/api/users'] });
      onClose();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <Modal open size="sm" icon="lock" title={`Status — ${role.name}`} onClose={onClose}
      footer={<>
        {error && <span className="u-danger u-flex-1" role="alert">{error}</span>}
        <button type="button" className="btn btn-s" onClick={onClose}>Cancel</button>
        <button type="submit" form="roleStatus" className={`btn ${status === 'retired' ? 'btn-d' : 'btn-w'}`}
          disabled={busy || !status || retireBlocked}>{busy ? 'Saving…' : status ? `Make ${STATUS_LABEL[status].toLowerCase()}` : 'Save'}</button>
      </>}>
      <form id="roleStatus" onSubmit={submit}>
        <p className="u-mb-10">Now: <b>{STATUS_LABEL[role.status as RoleStatus] ?? role.status}</b>{role.status_reason ? <> — <span className="note">{role.status_reason}</span></> : null}</p>
        {!targets.length ? <p className="note">There is no status change you can make to this role.</p> : (<>
          <Field label="New status" required htmlFor="rsS">
            <select id="rsS" required value={status} onChange={(e) => setStatus(e.target.value as RoleStatus)}>
              {targets.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
          </Field>
          {status && <p className="note u-mb-10">{EXPLAIN[status]}</p>}
          {retireBlocked && <p className="u-danger u-mb-10" role="alert">It has {role.member_count} member(s): revoke their assignments first.</p>}
          <Field label="Reason" required htmlFor="rsR" hint="Recorded in the role's history.">
            <textarea id="rsR" required minLength={5} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </>)}
      </form>
    </Modal>
  );
}
