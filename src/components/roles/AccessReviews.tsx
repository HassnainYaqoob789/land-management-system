'use client';

// Periodic access reviews: a snapshot of the active role assignments (all, one
// role or one province), a keep / revoke decision on each, closed when every
// item is decided. A revoke takes effect at once. Nobody decides on their own
// access. Reading needs users:read; acting needs users:assign.

import React, { useCallback, useState } from 'react';
import { Card, Modal, Field, Table, Loading, ErrorNote, fmtDate } from '@/components/legacy/ui';
import { send, useApi, useReference } from '@/lib/client/api';
import { useLMS } from '@/components/layout/Shell';
import type { RoleSummary } from './types';

interface Review {
  id: string; note: string; started_at: string; started_by_name: string | null; completed_at: string | null; completed_by_name: string | null;
  completion_note: string | null; role_code: string | null; role_name: string | null; scope_province: string | null;
  items?: number; open?: number; kept?: number; revoked?: number;
}
interface Item {
  id: string; decision: 'keep' | 'revoke' | null; reason: string | null; decided_at: string | null; decided_by_name: string | null;
  assignment_id: string; user_id: string; username: string | null; full_name: string | null; role_code: string; role_name: string;
  scope_province: string | null; granted_at: string; granted_by_name: string | null; expires_at: string | null; grant_reason: string | null;
  revoked_at: string | null; active: boolean;
}

function ReviewDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, loading, error } = useApi<{ review: Review; items: Item[]; actorId: string; can: { decide: boolean } }>(`/api/roles/reviews/${id}`, { ttl: 2_000 });
  const [revoking, setRevoking] = useState<Item | null>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const closeRevoke = useCallback(() => setRevoking(null), []);
  const act = async (body: Record<string, unknown>, then?: () => void) => {
    setBusy(true); setErr(null);
    try { await send('POST', `/api/roles/reviews/${id}`, body, { also: ['/api/users'] }); then?.(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const review = data?.review, items = data?.items ?? [];
  const open = items.filter((i) => !i.decision).length;
  return (
    <Modal open size="lg" icon="cbox" title={review ? `Access review — ${review.note}` : 'Access review'} onClose={onClose}
      footer={<>
        {err && <span className="u-danger u-flex-1" role="alert">{err}</span>}
        {data?.can.decide && (
          <form id="arClose" className="u-flex-1 bar u-m-0" onSubmit={(e) => { e.preventDefault(); act({ action: 'close', note }); }}>
            <input aria-label="Closing note" placeholder="Closing note (optional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
            <button type="submit" className="btn btn-p" disabled={busy || open > 0} title={open ? `${open} item(s) still need a decision` : undefined}>Close review</button>
          </form>
        )}
        <button type="button" className="btn btn-s" onClick={onClose}>Done</button>
      </>}>
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data ? <Loading what="review" /> : review && (<>
        <p className="u-mb-10">Started {new Date(review.started_at).toLocaleString('en-GB')} by {review.started_by_name ?? '—'}
          {' · '}{review.role_name ? `role ${review.role_name}` : 'all roles'}{review.scope_province ? ` in ${review.scope_province}` : ''}
          {' · '}{items.length - open} of {items.length} decided
          {review.completed_at && <><br /><span className="b b-g">Closed</span> {new Date(review.completed_at).toLocaleString('en-GB')} by {review.completed_by_name ?? '—'}{review.completion_note ? ` — ${review.completion_note}` : ''}</>}</p>
        <Table caption="Assignments under review" head={<><th>Member</th><th>Role</th><th>Limited to</th><th>Granted</th><th>Expires</th><th>Decision</th></>}
          empty={items.length ? false : 'No items.'} colSpan={6}>
          {items.map((i) => {
            const own = i.user_id === data!.actorId;
            return (
              <tr key={i.id}>
                <td>{i.full_name ?? '—'}<br /><small className="note mono">{i.username}</small></td>
                <td>{i.role_name}<br /><small className="note mono">{i.role_code}</small></td>
                <td>{i.scope_province ?? 'all their provinces'}</td>
                <td>{fmtDate(i.granted_at)}<br /><small className="note">{i.granted_by_name ?? ''}{i.grant_reason ? ` — ${i.grant_reason}` : ''}</small></td>
                <td>{i.expires_at ? fmtDate(i.expires_at) : '—'}{!i.active && !i.decision && <> <span className="b b-n">ended</span></>}</td>
                <td>
                  {i.decision ? (<><span className={`b ${i.decision === 'keep' ? 'b-g' : 'b-d'}`}>{i.decision === 'keep' ? 'Keep' : 'Revoked'}</span>
                    <br /><small className="note">{i.decided_by_name}{i.reason ? ` — ${i.reason}` : ''}</small></>)
                    : !data!.can.decide ? <span className="note">Undecided</span>
                    : own ? <small className="note">Your own access: another reviewer must decide.</small>
                    : <div className="acts">
                        {i.active && <button type="button" disabled={busy} onClick={() => act({ action: 'decide', item_id: i.id, decision: 'keep' })}>Keep</button>}
                        <button type="button" className="del" disabled={busy} onClick={() => { setReason(''); setRevoking(i); }}>Revoke</button>
                      </div>}
                </td>
              </tr>
            );
          })}
        </Table>
      </>)}
      <Modal open={!!revoking} stacked size="sm" icon="x" title={`Revoke ${revoking?.role_name ?? ''} from ${revoking?.full_name ?? ''}`} onClose={closeRevoke}
        footer={<>
          <button type="button" className="btn btn-s" onClick={closeRevoke}>Back</button>
          <button type="submit" form="arRevoke" className="btn btn-d" disabled={busy}>{busy ? 'Saving…' : 'Revoke now'}</button>
        </>}>
        <form id="arRevoke" onSubmit={(e) => { e.preventDefault(); if (revoking) act({ action: 'decide', item_id: revoking.id, decision: 'revoke', reason }, closeRevoke); }}>
          <p className="note u-mb-10">The assignment is revoked as soon as you confirm; the member loses the role&apos;s permissions on their next request.</p>
          <Field label="Reason" required htmlFor="arReason"><textarea id="arReason" required minLength={5} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </form>
      </Modal>
    </Modal>
  );
}

export default function AccessReviews({ roles }: { roles: RoleSummary[] }) {
  const { data, loading, error } = useApi<{ reviews: Review[]; can: { start: boolean } }>('/api/roles/reviews', { ttl: 5_000 });
  const ref = useReference();
  const { provinces: mine } = useLMS();
  // A reviewer reviews only provinces they hold (the database refuses others).
  const provinces = (ref?.provinces ?? []).filter((p) => mine.includes(p.code));
  const [starting, setStarting] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState({ note: '', role_code: '', province: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const closeStart = useCallback(() => setStarting(false), []);
  const closeDetail = useCallback(() => setOpenId(null), []);
  const reviews = data?.reviews ?? [];

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await send<{ id: string }>('POST', '/api/roles/reviews', form);
      setStarting(false); setOpenId(r.id);
    } catch (e2: any) { setErr(e2.message); } finally { setBusy(false); }
  };

  return (
    <Card icon="cbox" title="Access reviews" sub="Periodic confirmation that every role assignment is still needed · evidence for SOC 2 / ISO 27001 access control"
      actions={data?.can.start ? <button type="button" className="btn btn-p" onClick={() => { setErr(null); setForm({ note: '', role_code: '', province: '' }); setStarting(true); }}>+ Start review</button> : undefined}>
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data ? <Loading what="reviews" /> : (
        <Table caption="Access reviews" head={<><th>Review</th><th>Scope</th><th>Started</th><th>Progress</th><th>Status</th><th></th></>}
          empty={reviews.length ? false : 'No access review has been run yet.'} colSpan={6}>
          {reviews.map((r) => (
            <tr key={r.id}>
              <td>{r.note}</td>
              <td>{r.role_name ?? 'All roles'}{r.scope_province ? ` · ${r.scope_province}` : ''}</td>
              <td>{fmtDate(r.started_at)}<br /><small className="note">{r.started_by_name}</small></td>
              <td>{(r.items ?? 0) - (r.open ?? 0)} / {r.items} decided<br /><small className="note">{r.kept} kept · {r.revoked} revoked</small></td>
              <td>{r.completed_at ? <span className="b b-g">Closed</span> : <span className="b b-w">Open</span>}</td>
              <td><div className="acts"><button type="button" onClick={() => setOpenId(r.id)}>Open</button></div></td>
            </tr>
          ))}
        </Table>
      )}

      <Modal open={starting} size="sm" icon="cbox" title="Start an access review" onClose={closeStart}
        footer={<>
          {err && <span className="u-danger u-flex-1" role="alert">{err}</span>}
          <button type="button" className="btn btn-s" onClick={closeStart}>Cancel</button>
          <button type="submit" form="arStart" className="btn btn-p" disabled={busy}>{busy ? 'Starting…' : 'Start'}</button>
        </>}>
        <form id="arStart" onSubmit={start}>
          <p className="note u-mb-10">The review lists the role assignments active now. Grants made later are not added.</p>
          <Field label="Description" required htmlFor="arNote"><input id="arNote" required minLength={5} maxLength={500} value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="e.g. Q4 2026 quarterly access review" /></Field>
          <Field label="Only this role" htmlFor="arRole"><select id="arRole" value={form.role_code} onChange={(e) => setForm({ ...form, role_code: e.target.value })}>
            <option value="">All roles</option>{roles.filter((r) => r.status !== 'retired').map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</select></Field>
          <Field label="Only this province" htmlFor="arProv"><select id="arProv" value={form.province} onChange={(e) => setForm({ ...form, province: e.target.value })}>
            <option value="">All provinces</option>{provinces.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></Field>
        </form>
      </Modal>
      {openId && <ReviewDetail id={openId} onClose={closeDetail} />}
    </Card>
  );
}
