'use client';

// One account's access: what it can do now (iam.effective_permissions), its
// role grants (grant with an optional province limit and expiry, revoke with a
// reason), its role history, its linked sign-in identities, and the rare
// lifecycle actions (emergency access, anonymisation). Every change needs the
// matching permission and a recent re-authentication on the server; nothing
// here is offered on your own account where the database refuses it.

import React, { useCallback, useState } from 'react';
import { Modal, Field, Table, Tabs, Loading, ErrorNote, fmtDate } from '@/components/legacy/ui';
import { send, useApi } from '@/lib/client/api';
import { groupByResource, scopeLabel } from './model';

export interface AccessUser {
  id: string; code: string; username: string; full_name: string; status: string; provinces: string[];
  is_break_glass?: boolean; anonymised_at?: string | null; mfa_enrolled?: boolean;
}
export interface AccessRole { code: string; name: string; status: string; grantable: boolean; is_system: boolean }
export interface Assignment {
  id: string; user_id: string; role_code: string; role_name: string; role_status?: string; scope_province: string | null;
  granted_at: string; expires_at: string | null; expired?: boolean; granted_by_name: string | null; reason: string | null;
}
export interface Identity { id: string; user_id: string; subject: string; provider: string | null; kind: string | null; linked_at: string; last_login_at: string | null }

const SYSADMIN = 'system-administrator';
/** End of the chosen day in the browser's time zone, as the server expects (ISO with offset). */
export const endOfDay = (d: string) => (d ? new Date(`${d}T23:59:59`).toISOString() : undefined);
const tomorrow = () => { const d = new Date(Date.now() + 86_400_000); return d.toISOString().slice(0, 10); };

function Effective({ userId }: { userId: string }) {
  const { data, loading, error } = useApi<any>(`/api/users?effective=${userId}`, { ttl: 5_000 });
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (loading && !data) return <Loading what="permissions" />;
  const perms: any[] = data?.permissions ?? [];
  return (<>
    <p className="note u-mb-10">What this account can do on its next request: active, unexpired assignments of active roles, for an active account.
      {data?.user?.status !== 'Active' && <> <b>The account is {data?.user?.status}: it can do nothing.</b></>}</p>
    <Table caption="Effective permissions" head={<><th>Resource</th><th>Action</th><th>Widest scope</th><th>Through</th></>}
      empty={perms.length ? false : 'No effective permissions.'} colSpan={4}>
      {groupByResource(perms).flatMap(([resource, list]) => list.map((p: any, i: number) => (
        <tr key={p.key}>
          <td>{i === 0 ? <b className="mono">{resource}</b> : ''}</td><td>{p.action}</td><td>{scopeLabel(p.widest)}</td>
          <td>{p.grants.map((g: any, j: number) => (
            <span key={j} className="pill" title={g.scope_province ? `limited to ${g.scope_province}` : undefined}>
              {g.role}{g.scope_province ? ` · ${g.scope_province}` : ''} ({scopeLabel(g.scope_level)})</span>))}</td>
        </tr>
      )))}
    </Table>
  </>);
}

function History({ userId }: { userId: string }) {
  const { data, loading, error } = useApi<any>(`/api/users?history=${userId}`, { ttl: 5_000 });
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (loading && !data) return <Loading what="history" />;
  const rows: any[] = data?.assignments ?? [], events: any[] = data?.events ?? [];
  return (<>
    <Table caption="Role grants, current and past" head={<><th>Role</th><th>Limited to</th><th>Granted</th><th>Expires</th><th>Revoked</th></>}
      empty={rows.length ? false : 'No role has ever been granted.'} colSpan={5}>
      {rows.map((a) => (
        <tr key={a.id}>
          <td>{a.role_name}<br /><small className="note mono">{a.role_code}</small></td>
          <td>{a.scope_province ?? 'all their provinces'}</td>
          <td>{fmtDate(a.granted_at)} · {a.granted_by_name ?? '—'}{a.reason && <><br /><small className="note">{a.reason}</small></>}</td>
          <td>{a.expires_at ? fmtDate(a.expires_at) : '—'}</td>
          <td>{a.revoked_at ? <>{fmtDate(a.revoked_at)} · {a.revoked_by_name ?? '—'}{a.revoke_reason && <><br /><small className="note">{a.revoke_reason}</small></>}</> : <span className="b b-g">open</span>}</td>
        </tr>
      ))}
    </Table>
    {events.length > 0 && (
      <Table caption="Account events" head={<><th>When</th><th>Event</th><th>By</th><th>Detail</th></>} colSpan={4}>
        {events.map((e) => (
          <tr key={e.id}><td className="u-nowrap">{new Date(e.occurred_at).toLocaleString('en-GB')}</td><td>{e.event_type.replace(/_/g, ' ')}</td>
            <td>{e.actor_name ?? '—'}</td>
            <td><small className="note">{Object.entries(e.metadata ?? {}).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ')}</small></td></tr>
        ))}
      </Table>
    )}
  </>);
}

export default function UserAccess({ user, self, roles, assignments, identities, grantableProvinces, can, onClose }: {
  user: AccessUser; self: boolean; roles: AccessRole[]; assignments: Assignment[]; identities: Identity[]; grantableProvinces: string[];
  can: { assign: boolean; update: boolean; delete: boolean; breakGlass: boolean }; onClose: () => void;
}) {
  const [tab, setTab] = useState<'effective' | 'grants' | 'history' | 'identities' | 'account'>('effective');
  const [form, setForm] = useState({ role_code: '', scope_province: '', expires_on: '', reason: '' });
  const [confirm, setConfirm] = useState<null | { kind: 'revoke'; a: Assignment } | { kind: 'unlink'; i: Identity } | { kind: 'anonymise' } | { kind: 'glass' }>(null);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const closeConfirm = useCallback(() => setConfirm(null), []);

  const mine = assignments.filter((a) => a.user_id === user.id);
  const myIds = identities.filter((i) => i.user_id === user.id);
  const chosen = roles.find((r) => r.code === form.role_code);
  const isAdminRole = chosen?.code === SYSADMIN;
  // A grant can be limited only to a province the account has and the grantor may hand out.
  const scopeOptions = user.provinces.filter((p) => grantableProvinces.includes(p));

  const post = async (body: Record<string, unknown>, done: string, after?: () => void) => {
    setBusy(true); setError(null); setNotice(null);
    try { await send('POST', '/api/users', body, { also: ['/api/roles'] }); setNotice(done); after?.(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const openConfirm = (c: NonNullable<typeof confirm>) => { setReason(''); setTyped(''); setError(null); setConfirm(c); };

  const tabs: [typeof tab, string][] = [['effective', 'Effective permissions'], ['grants', `Role grants (${mine.length})`], ['history', 'History']];
  if (myIds.length || can.update) tabs.push(['identities', `Sign-in identities (${myIds.length})`]);
  if (!self && (can.delete || can.breakGlass)) tabs.push(['account', 'Account']);

  return (
    <Modal open size="lg" icon="lock" title={`Access — ${user.full_name} (${user.username})`} onClose={onClose}
      footer={<>
        {error && <span className="u-danger u-flex-1" role="alert">{error}</span>}
        {notice && !error && <span className="u-flex-1" role="status">{notice}</span>}
        <button type="button" className="btn btn-p" onClick={onClose}>Done</button>
      </>}>
      <Tabs label="Account access" value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'effective' && <Effective userId={user.id} />}
      {tab === 'history' && <History userId={user.id} />}

      {tab === 'grants' && (<>
        <Table caption="Current role grants" head={<><th>Role</th><th>Limited to</th><th>Granted</th><th>By</th><th>Expires</th><th>Reason</th><th></th></>}
          empty={mine.length ? false : 'No roles granted.'} colSpan={7}>
          {mine.map((a) => (
            <tr key={a.id}>
              <td>{a.role_name}{a.role_status && a.role_status !== 'active' && <> <span className="b b-w">{a.role_status === 'inactive' ? 'suspended role' : a.role_status}</span></>}</td>
              <td>{a.scope_province || 'all their provinces'}</td><td>{fmtDate(a.granted_at)}</td><td>{a.granted_by_name || '—'}</td>
              <td>{a.expires_at ? <>{fmtDate(a.expires_at)}{a.expired && <> <span className="b b-d">expired</span></>}</> : '—'}</td>
              <td>{a.reason || '—'}</td>
              <td>{can.assign && !(self && a.role_code === SYSADMIN) && (
                <div className="acts"><button type="button" className="del" onClick={() => openConfirm({ kind: 'revoke', a })}>Revoke</button></div>)}</td>
            </tr>
          ))}
        </Table>
        {can.assign && !self && (
          <form className="fgrid u-mt-16" onSubmit={(e) => {
            e.preventDefault();
            post({ action: 'assign_role', user_id: user.id, role_code: form.role_code, reason: form.reason,
              scope_province: isAdminRole ? undefined : form.scope_province || undefined,
              expires_at: isAdminRole ? undefined : endOfDay(form.expires_on) },
            'Role granted.', () => setForm({ role_code: '', scope_province: '', expires_on: '', reason: '' }));
          }}>
            <Field label="Grant role" required htmlFor="uaRole" hint="Roles with permissions you do not hold, above your tier, or not active cannot be granted.">
              <select id="uaRole" required value={form.role_code} onChange={(e) => setForm({ ...form, role_code: e.target.value })}>
                <option value="">— Select —</option>
                {roles.filter((r) => r.status !== 'retired').map((r) => {
                  const why = r.status !== 'active' ? ' (suspended)' : !r.grantable ? ' (beyond your authority)' : '';
                  return <option key={r.code} value={r.code} disabled={!!why}>{r.name}{why}</option>;
                })}
              </select>
            </Field>
            {!isAdminRole ? (<>
              <Field label="Limited to province" htmlFor="uaScope" hint={scopeOptions.length < user.provinces.length ? 'Only provinces this account has and you may grant.' : undefined}>
                <select id="uaScope" value={form.scope_province} onChange={(e) => setForm({ ...form, scope_province: e.target.value })}>
                  <option value="">All the account&apos;s provinces</option>
                  {scopeOptions.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </Field>
              <Field label="Expires on" htmlFor="uaExp" hint="Optional. The grant stops at the end of that day.">
                <input id="uaExp" type="date" min={tomorrow()} value={form.expires_on} onChange={(e) => setForm({ ...form, expires_on: e.target.value })} />
              </Field>
            </>) : (
              <div className="fg"><p className="note">A system administrator grant covers every province and cannot expire.</p></div>
            )}
            <Field label="Reason" required full htmlFor="uaReason"><input id="uaReason" required minLength={5} maxLength={300} value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="e.g. appointed DM Field, Sindh — order no." /></Field>
            <div className="fg full"><button type="submit" className="btn btn-p" disabled={busy}>{busy ? 'Saving…' : 'Grant role'}</button></div>
          </form>
        )}
        {self && <p className="note u-mt-10">You cannot change your own roles.</p>}
      </>)}

      {tab === 'identities' && (
        <Table caption="Linked sign-in identities" head={<><th>Provider</th><th>Subject</th><th>Linked</th><th>Last sign-in</th><th></th></>}
          empty={myIds.length ? false : 'No external identity is linked.'} colSpan={5}>
          {myIds.map((i) => (
            <tr key={i.id}><td>{i.provider ?? '—'}{i.kind && <> <span className="b b-n">{i.kind}</span></>}</td><td className="mono">{i.subject}</td>
              <td>{fmtDate(i.linked_at)}</td><td>{i.last_login_at ? fmtDate(i.last_login_at) : '—'}</td>
              <td>{can.update && !self && <div className="acts"><button type="button" className="del" onClick={() => openConfirm({ kind: 'unlink', i })}>Unlink</button></div>}</td></tr>
          ))}
        </Table>
      )}

      {tab === 'account' && (<>
        {can.breakGlass && (
          <div className="u-mb-10">
            <p><b>Emergency access</b> — {user.is_break_glass ? 'this account is an emergency-access (break-glass) account.' : 'not designated.'}</p>
            <p className="note u-mb-6">An emergency-access account needs a local password and two-step verification, and cannot be recovered by link.</p>
            <button type="button" className="btn btn-w btn-sm" onClick={() => openConfirm({ kind: 'glass' })}>{user.is_break_glass ? 'Remove emergency access' : 'Designate for emergency access'}</button>
          </div>
        )}
        {can.delete && (
          <div className="u-mt-16">
            <p><b>Anonymise</b> — removes the person&apos;s name, email and sign-in methods, revokes every role and deactivates the account. The record and its history stay.</p>
            {user.anonymised_at ? <p className="note">Anonymised {fmtDate(user.anonymised_at)}.</p>
              : <button type="button" className="btn btn-d btn-sm u-mt-6" onClick={() => openConfirm({ kind: 'anonymise' })}>Anonymise account…</button>}
          </div>
        )}
      </>)}

      <Modal open={!!confirm} stacked size="sm" icon="warn" onClose={closeConfirm}
        title={confirm?.kind === 'revoke' ? `Revoke ${confirm.a.role_name}` : confirm?.kind === 'unlink' ? 'Unlink sign-in identity'
          : confirm?.kind === 'anonymise' ? `Anonymise ${user.username}` : 'Emergency access'}
        footer={<>
          {error && <span className="u-danger u-flex-1" role="alert">{error}</span>}
          <button type="button" className="btn btn-s" onClick={closeConfirm}>Back</button>
          <button type="submit" form="uaConfirm" className="btn btn-d" disabled={busy}>{busy ? 'Saving…' : 'Confirm'}</button>
        </>}>
        <form id="uaConfirm" onSubmit={(e) => {
          e.preventDefault();
          if (!confirm) return;
          if (confirm.kind === 'revoke') post({ action: 'revoke_role', assignment_id: confirm.a.id, reason }, 'Role revoked.', closeConfirm);
          else if (confirm.kind === 'unlink') post({ action: 'unlink_identity', identity_id: confirm.i.id, reason }, 'Identity unlinked.', closeConfirm);
          else if (confirm.kind === 'anonymise') post({ action: 'anonymise_user', user_id: user.id, reason, confirm: typed }, 'Account anonymised.', closeConfirm);
          else post({ action: 'set_break_glass', user_id: user.id, on: !user.is_break_glass }, 'Emergency access updated.', closeConfirm);
        }}>
          {confirm?.kind === 'glass' ? (
            <p>{user.is_break_glass ? 'Remove the emergency-access designation from this account?' : 'Designate this account for emergency (break-glass) access?'}</p>
          ) : (<>
            {confirm?.kind === 'anonymise' && (<>
              <p className="u-danger u-mb-10">This cannot be undone.</p>
              <Field label={`Type ${user.username} to confirm`} required htmlFor="uaTyped">
                <input id="uaTyped" required className="mono" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} /></Field>
            </>)}
            <Field label={confirm?.kind === 'anonymise' ? 'Justification' : 'Reason'} required htmlFor="uaWhy"
              hint={confirm?.kind === 'anonymise' ? 'At least 10 characters, e.g. the erasure request reference.' : 'Recorded in the audit trail.'}>
              <textarea id="uaWhy" required minLength={confirm?.kind === 'anonymise' ? 10 : 5} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </>)}
        </form>
      </Modal>
    </Modal>
  );
}
