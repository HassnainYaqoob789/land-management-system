'use client';

import React, { useState } from 'react';
import { Card, Field, Modal, Table } from '@/components/legacy/ui';
import { send } from '@/lib/client/api';
import { Done, messageOf, when, type IdentityData, type RequestView } from './shared';

const TONE: Record<RequestView['status'], string> = { pending: 'w', approved: 'g', rejected: 'n' };

// First-time external sign-ins wait here (iam.provisioning_mode = approval).
// Approving creates the account — or links an existing one — with no roles.
export default function RequestsTab({ data, reload }: { data: IdentityData; reload: () => void }) {
  const [decide, setDecide] = useState<{ req: RequestView; decision: 'approve' | 'reject' } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const pending = data.requests.filter((r) => r.status === 'pending');

  return (
    <Card icon="user" title="Access requests"
      sub={`${pending.length} waiting. An approved person gets access only from group mappings (at their next sign-in) or from roles assigned on the Users screen.`}>
      <Done>{done}</Done>
      <Table caption="Access requests from external sign-ins" colSpan={6} empty={data.requests.length ? false : 'No access requests.'}
        head={<><th>Person</th><th>Provider</th><th>Groups sent</th><th>Requested</th><th>Status</th><th><span className="sr-only">Actions</span></th></>}>
        {data.requests.map((r) => (
          <tr key={r.id}>
            <td><b>{r.displayName || '—'}</b><br /><span className="note">{r.email || 'no e-mail'} · subject </span><span className="code">{r.subject}</span></td>
            <td>{r.providerDisplayName}</td>
            <td className="mono">{r.groups.length ? r.groups.join(', ') : '—'}</td>
            <td>{when(r.requestedAt)}</td>
            <td><span className={`b b-${TONE[r.status]}`}>{r.status}</span>
              {r.status !== 'pending' && <p className="note u-mt-6">{r.decidedBy ?? ''} {when(r.decidedAt)}{r.username ? ` · account ${r.username}` : ''}</p>}</td>
            <td>{r.status === 'pending' && data.canDecide && (
              <div className="bar u-m-0">
                <button type="button" className="btn btn-g btn-sm" onClick={() => setDecide({ req: r, decision: 'approve' })}>Approve…</button>
                <button type="button" className="btn btn-d btn-sm" onClick={() => setDecide({ req: r, decision: 'reject' })}>Reject…</button>
              </div>)}</td>
          </tr>
        ))}
      </Table>
      {decide && <DecideModal {...decide} onClose={() => setDecide(null)}
        onDone={(msg) => { setDecide(null); setDone(msg); reload(); }} />}
    </Card>
  );
}

function DecideModal({ req, decision, onClose, onDone }: { req: RequestView; decision: 'approve' | 'reject'; onClose: () => void; onDone: (m: string) => void }) {
  const [link, setLink] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approve = decision === 'approve';
  const who = req.displayName || req.email || req.subject;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      await send('POST', `/api/settings/identity/requests/${req.id}`, { decision, note: note || undefined, ...(approve && link ? { linkUsername: link } : {}) });
      onDone(approve ? `Approved ${who}. They can sign in now; access comes from group mappings or the Users screen.` : `Rejected ${who}.`);
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  };
  return (
    <Modal open icon="user" title={`${approve ? 'Approve' : 'Reject'} access for ${who}`} onClose={onClose}
      footer={<>
        {error && <span className="u-danger u-flex-1" role="alert">{error}</span>}
        <button type="button" className="btn btn-s" onClick={onClose}>Cancel</button>
        <button type="submit" form="decideForm" className={`btn ${approve ? 'btn-g' : 'btn-d'}`} disabled={busy}>
          {busy ? 'Saving…' : approve ? 'Approve' : 'Reject'}</button>
      </>}>
      <form id="decideForm" onSubmit={submit} className="fgrid">
        <p className="note full">Signed in through {req.providerDisplayName} as <span className="code">{req.subject}</span>{req.email ? ` (${req.email})` : ''}.</p>
        {approve && (
          <Field label="Link to an existing account (optional)" full htmlFor="dLink"
            hint="Leave empty to create a new account. Only link when you are certain it is the same person.">
            <input id="dLink" value={link} maxLength={64} autoComplete="off" onChange={(e) => setLink(e.target.value)} placeholder="username" />
          </Field>
        )}
        <Field label="Note" full htmlFor="dNote" hint="Recorded with the decision.">
          <input id="dNote" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}
