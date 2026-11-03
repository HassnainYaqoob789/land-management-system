'use client';

// Users: accounts, their roles, province access and approval positions, two-step
// verification and sessions. Each control appears only with the permission its
// API action needs (see GATES in /api/users), never on your own account where
// the database refuses it, and every change re-confirms your identity on the
// server. A users:read holder without other rights (the security auditor) sees
// every account — and, with sessions:read, every session — read-only.

import React, { useCallback, useState } from 'react';
import Link from 'next/link';
import Shell, { useLMS } from '@/components/layout/Shell';
import { Card, Modal, Field, Table, Toolbar, SearchBox, Count, Tabs, Loading, ErrorNote, Kpi, fmtNum, rowOpen, DetailsModal } from '@/components/legacy/ui';
import { RefSelect } from '@/components/legacy/data';
import { send, useApi, useReference } from '@/lib/client/api';
import { useCan } from '@/lib/client/permissions';
import UserAccess from '@/components/roles/UserAccess';
import BulkRoleDialog from '@/components/roles/BulkRoleDialog';
import { expiryState, expiryBadge, untilLabel } from './grantExpiry';

export default function UsersPage() {
  return <Shell><UsersContent /></Shell>;
}

type Dialog = null | { kind: 'create' } | { kind: 'bulk' } | { kind: 'edit' | 'status' | 'mfa' | 'access' | 'view'; u: any }
  | { kind: 'shown'; title: string; url: string; expires?: string };
const multi = (e: React.ChangeEvent<HTMLSelectElement>) => [...e.target.selectedOptions].map((o) => o.value);
const sameSet = (a: string[], b: string[]) => {
  if (a.length !== b.length) return false;
  const sb = [...b].sort();
  return [...a].sort().every((x, i) => x === sb[i]);
};

/**
 * An account's open role grants, each with its end date: "until …", a warning when it
 * ends within a week, "Expired" once it has (an expired grant confers nothing).
 */
function RoleGrants({ grants, fallback }: { grants: any[]; fallback: string[] }) {
  if (!grants.length) return fallback.length ? <>{fallback.map((r) => <span key={r} className="pill">{r}</span>)}</> : <span className="note">none</span>;
  return <>{grants.map((a) => {
    const s = a.expired ? { ...expiryState(a.expires_at), tone: 'expired' as const } : expiryState(a.expires_at);
    const badge = expiryBadge(s);
    return (
      <span key={a.id} className="u-nowrap">
        <span className="pill" title={a.scope_province ? `limited to ${a.scope_province}` : undefined}>{a.role_code}{a.scope_province ? ` · ${a.scope_province}` : ''}</span>
        {s.at && <small className="note"> {untilLabel(s.at)}</small>}
        {badge && <> <span className={`b ${s.tone === 'expired' ? 'b-d' : 'b-w'}`}>{badge}</span></>}
        <br />
      </span>
    );
  })}</>;
}

function UsersContent() {
  const { currentUser } = useLMS();
  const allowed = useCan();
  const can = (a: string) => allowed(`users:${a}`);
  const ref = useReference();
  const { data, loading, error } = useApi<any>('/api/users');
  const users: any[] = data?.users ?? [], roles: any[] = data?.roles ?? [], groups: any[] = data?.approval_groups ?? [];
  const offices: any[] = data?.offices ?? [], sessions: any[] = data?.active_sessions ?? [], assignments: any[] = data?.assignments ?? [];
  const identities: any[] = data?.identities ?? [];
  const grantable: string[] = data?.actor?.grantableProvinces ?? [];
  const canSessions = !!data?.actor?.canReadSessions;
  const [tab, setTab] = useState<'users' | 'sessions' | 'roles'>('users');
  const [q, setQ] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [form, setForm] = useState<any>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  // Read-only details of a session or role row (Sessions / Roles tabs).
  const [sessView, setSessView] = useState<any | null>(null);
  const [roleView, setRoleView] = useState<any | null>(null);
  const close = useCallback(() => setDialog(null), []);
  const open = (d: Dialog, init: any = {}) => { setFormError(null); setNotice(null); setForm(init); setDialog(d); };
  const post = async (body: any, then?: (r: any) => void) => {
    setBusy(true); setFormError(null);
    try { const r = await send('POST', '/api/users', body, { also: ['/api/roles'] }); if (then) then(r); else setDialog(null); }
    catch (err: any) { setFormError(err.message); } finally { setBusy(false); }
  };
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  const needle = q.trim().toLowerCase();
  const shown = needle ? users.filter((u) => [u.code, u.username, u.full_name, u.email, u.position, (u.iam_roles ?? []).join(' ')].join(' ').toLowerCase().includes(needle)) : users;
  const canBulk = can('assign');
  const togglePick = (id: string, on: boolean) => setPicked((p) => (on ? [...new Set([...p, id])] : p.filter((x) => x !== id)));

  const footer = (formId: string, label: string, cls = 'btn-p') => (<>
    {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
    <button type="button" className="btn btn-s" onClick={close}>Cancel</button>
    <button type="submit" form={formId} className={`btn ${cls}`} disabled={busy}>{busy ? 'Saving…' : label}</button>
  </>);
  const u = dialog && 'u' in dialog ? dialog.u : null;
  const editSelf = !!u && u.id === currentUser?.id;
  const editMembership = can('assign') && !editSelf;
  const editIsAdmin = !!u && (u.iam_roles ?? []).includes('system-administrator');
  const provinceOptions = (ref?.provinces ?? []).map((p) => ({ ...p, ok: grantable.includes(p.code) }));

  const tabs: [typeof tab, string][] = [['users', `Users (${users.length})`]];
  if (canSessions) tabs.push(['sessions', `Sessions (${sessions.length})`]);
  tabs.push(['roles', `Roles (${roles.length})`]);

  return (
    <>
      <div className="kpis">
        <Kpi label="Accounts" value={fmtNum(users.length)} sub={`${fmtNum(users.filter((x) => x.status === 'Active').length)} active`} />
        <Kpi label="Two-step verification" value={fmtNum(users.filter((x) => x.mfa_enrolled).length)} sub="enrolled" tone="g" />
        <Kpi label="Locked" value={fmtNum(users.filter((x) => x.locked_until && new Date(x.locked_until) > new Date()).length)} sub="after failed sign-ins" tone="w" />
        {canSessions && <Kpi label="Signed in now" value={fmtNum(new Set(sessions.map((s) => s.user_id)).size)} sub={`${fmtNum(sessions.length)} session(s)`} />}
      </div>
      <Card icon="lock" title="Users & Roles" sub="Accounts, role grants, two-step verification and sessions · every change is checked by the database, re-confirms your identity and is audited">
        {error && <ErrorNote>{error}</ErrorNote>}
        {notice && <div className="al i" role="status"><span className="i" /><div className="tx">{notice}</div></div>}
        <div className="bar">
          {can('create') && can('assign') && <button type="button" className="btn btn-p" onClick={() => open({ kind: 'create' }, { provinces: [], groups: [], role_codes: [] })}>+ Add User</button>}
          {canBulk && <button type="button" className="btn btn-s" disabled={!picked.length} onClick={() => open({ kind: 'bulk' })}>Bulk role change{picked.length ? ` (${picked.length})` : ''}</button>}
          {allowed('roles:read') && <Link className="btn btn-s" href="/roles">Roles &amp; permissions</Link>}
        </div>
        <Tabs label="User administration" value={tab} onChange={setTab} tabs={tabs} />
        {loading && !data ? <Loading what="users" /> : (<>
          {tab === 'users' && (<>
            <Toolbar><SearchBox value={q} onChange={setQ} placeholder="Search name, username, email, position or role…" /><Count n={shown.length} /></Toolbar>
            <Table caption="Users"
              head={<>{canBulk && <th><span className="sr-only">Select</span></th>}<th>User</th><th>Name</th><th>Roles</th><th>Provinces</th><th>Positions</th><th>2-step</th><th>Status</th><th>Last sign-in</th><th>Actions</th></>}
              empty={shown.length ? false : 'No users.'} colSpan={canBulk ? 10 : 9}>
              {shown.map((x) => {
                const locked = x.locked_until && new Date(x.locked_until) > new Date();
                const self = x.id === currentUser?.id;
                const hasSessions = !canSessions || sessions.some((s) => s.user_id === x.id);
                return (
                  <tr key={x.id} {...rowOpen(() => open({ kind: 'view', u: x }), `Show details of ${x.username}`)}>
                    {canBulk && <td><input type="checkbox" aria-label={`Select ${x.username}`} disabled={self || x.status === 'Deactivated'}
                      title={self ? 'You cannot change your own roles' : undefined}
                      checked={picked.includes(x.id)} onChange={(e) => togglePick(x.id, e.target.checked)} /></td>}
                    <td><span className="code">{x.code}</span><br /><small className="note mono">{x.username}</small></td>
                    <td>{x.full_name}<br /><small className="note">{[x.position, x.department].filter(Boolean).join(' · ') || x.email || '—'}</small></td>
                    <td><RoleGrants grants={assignments.filter((a) => a.user_id === x.id)} fallback={x.iam_roles ?? []} /></td>
                    <td>{(x.provinces ?? []).join(', ') || '—'}</td>
                    <td>{(x.groups ?? []).map((g: string) => <span key={g} className="pill">{g}</span>)}</td>
                    <td>{x.mfa_enrolled ? <span className="b b-g" title={`${x.mfa_totp ? 'authenticator' : ''}${x.mfa_totp && x.passkeys ? ' + ' : ''}${x.passkeys ? `${x.passkeys} passkey(s)` : ''}`}>On</span> : <span className="b b-n">Off</span>}</td>
                    <td><span className={`b ${x.status === 'Active' ? 'b-g' : 'b-d'}`}>{x.status}</span>{locked && <><br /><span className="b b-w">Locked</span></>}
                      {x.must_change_password && <><br /><span className="b b-i">Must change password</span></>}
                      {x.is_break_glass && <><br /><span className="b b-w">Emergency access</span></>}</td>
                    <td>{x.last_login_at ? new Date(x.last_login_at).toLocaleString('en-GB') : <span className="note">never</span>}</td>
                    <td><div className="acts">
                      <button type="button" onClick={() => open({ kind: 'access', u: x })}>Access</button>
                      {can('update') && x.status !== 'Deactivated' && <button type="button" onClick={() => open({ kind: 'edit', u: x }, { full_name: x.full_name, email: x.email ?? '', department: x.department ?? '', position: x.position ?? '', office_code: x.office_code ?? '', provinces: x.provinces ?? [], groups: x.groups ?? [] })}>Edit</button>}
                      {can('update') && !self && <button type="button" onClick={() => open({ kind: 'status', u: x }, { status: x.status, reason: '' })}>Status</button>}
                      {can('update') && !self && x.status !== 'Deactivated' && <button type="button" onClick={() => post({ action: 'issue_token', user_id: x.id, purpose: 'password_reset' },
                        (r) => setDialog({ kind: 'shown', title: `Password reset link for ${x.username}`, url: origin + r.url, expires: r.expires_at }))}>Reset link</button>}
                      {can('reset_mfa') && x.mfa_enrolled && !self && <button type="button" onClick={() => open({ kind: 'mfa', u: x }, { justification: '' })}>Reset 2-step</button>}
                      {can('revoke_sessions') && hasSessions && <button type="button" className="del" onClick={() => post({ action: 'revoke_sessions', user_id: x.id }, (r) => setNotice(`${x.username}: ${r.revoked_count ?? 0} session(s) ended.`))}>Sign out everywhere</button>}
                    </div></td>
                  </tr>
                );
              })}
            </Table>
            {formError && !dialog && <ErrorNote>{formError}</ErrorNote>}
          </>)}
          {tab === 'sessions' && canSessions && (
            <Table caption="Active sessions" head={<><th>User</th><th>Started</th><th>Last seen</th><th>Expires</th><th>Method</th><th>From</th></>}
              empty={sessions.length ? false : 'No active sessions.'} colSpan={6}>
              {sessions.map((s) => (
                <tr key={s.id} {...rowOpen(() => setSessView(s), `Show session of ${s.username}`)}><td>{s.full_name || '—'}<br /><small className="note mono">{s.username}</small></td>
                  <td>{new Date(s.started_at).toLocaleString('en-GB')}</td><td>{new Date(s.last_seen_at).toLocaleString('en-GB')}</td>
                  <td>{new Date(s.expires_at).toLocaleString('en-GB')}</td><td>{s.auth_method ?? '—'}</td><td className="mono">{s.source_ip || '—'}</td></tr>
              ))}
            </Table>
          )}
          {tab === 'roles' && (<>
            <p className="note u-mb-10">Roles are defined and their permissions set on {allowed('roles:read') ? <Link href="/roles">Roles &amp; permissions</Link> : 'the Roles & permissions screen'}.</p>
            <Table caption="Roles" head={<><th>Role</th><th>Database tier</th><th>Status</th><th>Permissions</th></>} empty={roles.length ? false : 'No roles.'} colSpan={4}>
              {roles.map((r) => (
                <tr key={r.id} {...rowOpen(() => setRoleView(r), `Show role ${r.code}`)}><td><b>{r.name}</b><br /><small className="note mono">{r.code}</small>{r.description && <><br /><small className="note">{r.description}</small></>}</td>
                  <td>{r.db_role_code}</td>
                  <td><span className={`b ${r.status === 'active' ? 'b-g' : r.status === 'inactive' ? 'b-w' : 'b-n'}`}>{r.status === 'inactive' ? 'Suspended' : r.status}</span></td>
                  <td>{(r.permissions ?? []).length} permission(s)</td></tr>
              ))}
            </Table>
          </>)}
        </>)}
      </Card>

      {dialog?.kind === 'view' && (() => {
        const v = dialog.u;
        const locked = v.locked_until && new Date(v.locked_until) > new Date();
        const self = v.id === currentUser?.id;
        const mySessions = sessions.filter((s) => s.user_id === v.id);
        const myIds = identities.filter((i) => i.user_id === v.id);
        const when = (t?: string | null) => (t ? new Date(t).toLocaleString('en-GB') : null);
        return (
          <DetailsModal open icon="user" onClose={close}
            title={<>{v.full_name} <span className="code">{v.code}</span></>}
            sections={[
              { title: 'Account', items: [
                ['Username', <span className="mono">{v.username}</span>],
                ['Full name', v.full_name],
                ['Email', v.email],
                ['Status', <><span className={`b ${v.status === 'Active' ? 'b-g' : 'b-d'}`}>{v.status}</span>
                  {locked && <> <span className="b b-w">Locked until {when(v.locked_until)}</span></>}
                  {v.must_change_password && <> <span className="b b-i">Must change password</span></>}
                  {v.is_break_glass && <> <span className="b b-w">Emergency access</span></>}</>],
                ['Database tier', v.role_code],
                ['Created', when(v.created_at)],
              ] },
              { title: 'Work', items: [
                ['Position', v.position],
                ['Department', v.department],
                ['Office', v.office_code],
                ['Provinces', (v.provinces ?? []).join(', ')],
                ['Approval positions', (v.groups ?? []).length ? (v.groups ?? []).map((g: string) => <span key={g} className="pill">{g}</span>) : null, true],
              ] },
              { title: 'Access', items: [
                ['Roles', <RoleGrants grants={assignments.filter((a) => a.user_id === v.id)} fallback={v.iam_roles ?? []} />, true],
                ['Two-step verification', v.mfa_enrolled
                  ? [v.mfa_totp && 'Authenticator app', v.passkeys ? `${v.passkeys} passkey(s)` : null].filter(Boolean).join(' + ')
                  : 'Not enrolled'],
                myIds.length > 0 && ['Directory sign-in', myIds.map((i) => `${i.provider} (${i.kind})`).join(', ')],
              ] },
              { title: 'Activity', items: [
                ['Last sign-in', when(v.last_login_at) ?? 'never'],
                canSessions && ['Active sessions', mySessions.length
                  ? mySessions.map((s) => <React.Fragment key={s.id}>{when(s.last_seen_at)} · {s.auth_method ?? '—'} · <span className="mono">{s.source_ip || '—'}</span><br /></React.Fragment>)
                  : 'none', true],
              ] },
            ]}
            actions={<>
              <button type="button" className="btn btn-s" onClick={() => open({ kind: 'access', u: v })}>Access</button>
              {can('update') && v.status !== 'Deactivated' && <button type="button" className="btn btn-s" onClick={() => open({ kind: 'edit', u: v }, { full_name: v.full_name, email: v.email ?? '', department: v.department ?? '', position: v.position ?? '', office_code: v.office_code ?? '', provinces: v.provinces ?? [], groups: v.groups ?? [] })}>Edit</button>}
              {can('update') && !self && <button type="button" className="btn btn-s" onClick={() => open({ kind: 'status', u: v }, { status: v.status, reason: '' })}>Status</button>}
            </>} />
        );
      })()}

      {sessView && (() => {
        const owner = users.find((x) => x.id === sessView.user_id);
        return (
          <DetailsModal open icon="lock" onClose={() => setSessView(null)}
            title={<>Session · {sessView.full_name || sessView.username}</>}
            sections={[{ items: [
              ['User', sessView.full_name], ['Username', <span className="mono">{sessView.username}</span>],
              ['Started', new Date(sessView.started_at).toLocaleString('en-GB')], ['Last seen', new Date(sessView.last_seen_at).toLocaleString('en-GB')],
              ['Expires', new Date(sessView.expires_at).toLocaleString('en-GB')], ['Sign-in method', sessView.auth_method],
              ['From (IP)', sessView.source_ip && <span className="mono">{sessView.source_ip}</span>],
            ] }]}
            actions={owner ? <button type="button" className="btn btn-s" onClick={() => { setSessView(null); open({ kind: 'view', u: owner }); }}>Show user</button> : undefined} />
        );
      })()}
      {roleView && (() => {
        const perms: string[] = roleView.permissions ?? [];
        const byResource = perms.reduce<Record<string, string[]>>((m, p) => { const [res, act] = p.split(':'); (m[res] ??= []).push(act); return m; }, {});
        const members = users.filter((x) => (x.iam_roles ?? []).includes(roleView.code));
        return (
          <DetailsModal open icon="shield" onClose={() => setRoleView(null)}
            title={<>{roleView.name} <span className="code">{roleView.code}</span></>}
            sections={[
              { items: [['Code', <span className="mono">{roleView.code}</span>], ['Name', roleView.name], ['Database tier', roleView.db_role_code],
                ['Status', <span className={`b ${roleView.status === 'active' ? 'b-g' : roleView.status === 'inactive' ? 'b-w' : 'b-n'}`}>{roleView.status === 'inactive' ? 'Suspended' : roleView.status}</span>],
                ['Type', roleView.is_system ? 'System (defined by migration)' : 'Custom'], ['Description', roleView.description, true]] },
              { title: `Members (${members.length})`, items: [['Members', members.map((x) => <span key={x.id} className="pill">{x.full_name} · {x.username}</span>), true]] },
              { title: `Permissions (${perms.length})`, items: Object.entries(byResource).map(([res, acts]) => [res, acts.join(', ')] as const) },
            ]}
            actions={allowed('roles:read') ? <Link className="btn btn-s" href="/roles">Roles &amp; permissions</Link> : undefined} />
        );
      })()}

      <Modal open={dialog?.kind === 'create'} icon="user" title="Add User" onClose={close} footer={footer('ucForm', 'Create and get invitation link')}>
        <form id="ucForm" className="fgrid" onSubmit={(e) => { e.preventDefault(); post({ action: 'create_user', ...form },
          (r) => setDialog({ kind: 'shown', title: `Invitation for ${form.username}`, url: origin + r.invitation_url, expires: r.expires_at })); }}>
          <Field label="Username" required htmlFor="ucU"><input id="ucU" required className="mono" pattern="[a-z0-9._-]{3,40}" value={form.username ?? ''} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} /></Field>
          <Field label="Full name" required htmlFor="ucN"><input id="ucN" required value={form.full_name ?? ''} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></Field>
          <Field label="Email" htmlFor="ucE"><input id="ucE" type="email" value={form.email ?? ''} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Office" htmlFor="ucO"><select id="ucO" value={form.office_code ?? ''} onChange={(e) => setForm({ ...form, office_code: e.target.value })}>
            <option value="">—</option>{offices.map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}</select></Field>
          <Field label="Department" htmlFor="ucD"><input id="ucD" value={form.department ?? ''} onChange={(e) => setForm({ ...form, department: e.target.value })} /></Field>
          <Field label="Position" htmlFor="ucP"><input id="ucP" value={form.position ?? ''} onChange={(e) => setForm({ ...form, position: e.target.value })} /></Field>
          <Field label="Roles" required htmlFor="ucR" hint="Ctrl / ⌘ for several. Roles with permissions you do not hold cannot be granted."><select id="ucR" multiple required value={form.role_codes ?? []} onChange={(e) => setForm({ ...form, role_codes: multi(e) })}>
            {roles.filter((r) => r.status === 'active').map((r) => <option key={r.code} value={r.code} disabled={!r.grantable}>{r.name}{r.grantable ? '' : ' (beyond your authority)'}</option>)}</select></Field>
          <Field label="Provinces" required htmlFor="ucPr"><select id="ucPr" multiple required value={form.provinces ?? []} onChange={(e) => setForm({ ...form, provinces: multi(e) })}>
            {provinceOptions.map((p) => <option key={p.code} value={p.code} disabled={!p.ok}>{p.name}{p.ok ? '' : ' (not yours to grant)'}</option>)}</select></Field>
          <Field label="Approval positions" full htmlFor="ucG" hint="A system administrator cannot hold an approval position (separation of duties)."><select id="ucG" multiple value={form.groups ?? []} onChange={(e) => setForm({ ...form, groups: multi(e) })}>
            {groups.map((g) => <option key={g.code} value={g.code}>{g.name}{g.is_position ? ' (approval position)' : ''}</option>)}</select></Field>
        </form>
      </Modal>

      <Modal open={dialog?.kind === 'edit'} icon="edit" title={`Edit ${u?.username ?? ''}`} onClose={close} footer={footer('ueForm', 'Save')}>
        <form id="ueForm" className="fgrid" onSubmit={(e) => {
          e.preventDefault();
          // Province access and positions are sent only when they may be and did change (AUTHZ-08).
          const body: any = { action: 'update_user', user_id: u.id, full_name: form.full_name, email: form.email, department: form.department, position: form.position, office_code: form.office_code };
          if (editMembership && !sameSet(form.provinces ?? [], u.provinces ?? [])) body.provinces = form.provinces;
          if (editMembership && !sameSet(form.groups ?? [], u.groups ?? [])) body.groups = form.groups;
          post(body);
        }}>
          <Field label="Full name" required htmlFor="ueN"><input id="ueN" required value={form.full_name ?? ''} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></Field>
          <Field label="Email" htmlFor="ueE"><input id="ueE" type="email" value={form.email ?? ''} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Office" htmlFor="ueO"><select id="ueO" value={form.office_code ?? ''} onChange={(e) => setForm({ ...form, office_code: e.target.value })}>
            <option value="">—</option>{offices.map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}</select></Field>
          <Field label="Department" htmlFor="ueD"><input id="ueD" value={form.department ?? ''} onChange={(e) => setForm({ ...form, department: e.target.value })} /></Field>
          <Field label="Position" htmlFor="ueP"><input id="ueP" value={form.position ?? ''} onChange={(e) => setForm({ ...form, position: e.target.value })} /></Field>
          {editMembership ? (<>
            <Field label="Provinces" htmlFor="uePr" hint="Only provinces you hold can be added or removed."><select id="uePr" multiple value={form.provinces ?? []} onChange={(e) => setForm({ ...form, provinces: multi(e) })}>
              {provinceOptions.map((p) => <option key={p.code} value={p.code} disabled={!p.ok}>{p.name}</option>)}</select></Field>
            <Field label="Approval positions" full htmlFor="ueG" hint={editIsAdmin ? 'A system administrator cannot hold an approval position (separation of duties).' : undefined}>
              <select id="ueG" multiple value={form.groups ?? []} onChange={(e) => setForm({ ...form, groups: multi(e) })}>
                {groups.map((g) => <option key={g.code} value={g.code} disabled={editIsAdmin && g.is_position && !(u?.groups ?? []).includes(g.code)}>{g.name}{g.is_position ? ' (approval position)' : ''}</option>)}</select></Field>
          </>) : (
            <div className="fg full">
              <p className="note">Provinces: {(u?.provinces ?? []).join(', ') || '—'} · Positions: {(u?.groups ?? []).join(', ') || '—'}</p>
              <p className="note">{editSelf ? 'You cannot change your own province access or approval positions.' : 'Changing province access or approval positions needs users:assign.'}</p>
            </div>
          )}
        </form>
      </Modal>

      <Modal open={dialog?.kind === 'status'} size="sm" icon="lock" title={`Account status — ${u?.username ?? ''}`} onClose={close} footer={footer('usForm', 'Save', 'btn-w')}>
        <form id="usForm" onSubmit={(e) => { e.preventDefault(); post({ action: 'set_status', user_id: u.id, status: form.status, reason: form.reason }); }}>
          <p className="note u-mb-10">Suspending or deactivating signs the person out everywhere. Deactivation is permanent. The last active administrator cannot be suspended or deactivated.</p>
          <Field label="Status" required htmlFor="usS"><RefSelect id="usS" required source="enum:app_user.status" value={form.status ?? ''} onChange={(v) => setForm({ ...form, status: v })} /></Field>
          <Field label="Reason" required htmlFor="usR"><textarea id="usR" required minLength={5} value={form.reason ?? ''} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
        </form>
      </Modal>

      <Modal open={dialog?.kind === 'mfa'} size="sm" icon="shield" title={`Reset two-step verification — ${u?.username ?? ''}`} onClose={close} footer={footer('umForm', 'Reset', 'btn-d')}>
        <form id="umForm" onSubmit={(e) => { e.preventDefault(); post({ action: 'reset_mfa', user_id: u.id, justification: form.justification }); }}>
          <p className="note u-mb-10">Removes their authenticator, passkeys and recovery codes; if their role requires it they must enrol again at next sign-in.</p>
          <Field label="Justification" required htmlFor="umJ" hint="e.g. the help-desk ticket and how identity was verified"><textarea id="umJ" required minLength={10} value={form.justification ?? ''} onChange={(e) => setForm({ ...form, justification: e.target.value })} /></Field>
        </form>
      </Modal>

      {dialog?.kind === 'access' && (
        <UserAccess user={users.find((x) => x.id === dialog.u.id) ?? dialog.u} self={dialog.u.id === currentUser?.id} roles={roles}
          assignments={assignments} identities={identities}
          grantableProvinces={grantable} onClose={close}
          can={{ assign: can('assign'), update: can('update'), delete: can('delete'), breakGlass: allowed('identity_settings:configure') }} />
      )}

      {dialog?.kind === 'bulk' && (
        <BulkRoleDialog users={users.filter((x) => picked.includes(x.id))} roles={roles} grantableProvinces={grantable} onClose={close}
          onDone={(m) => { setPicked([]); setDialog(null); setNotice(m); }} />
      )}

      <Modal open={dialog?.kind === 'shown'} size="sm" icon="send" title={dialog?.kind === 'shown' ? dialog.title : ''} onClose={close}
        footer={<button type="button" className="btn btn-p" onClick={close}>Done</button>}>
        {dialog?.kind === 'shown' && (<>
          <p className="u-mb-10">Give this link to the person through a channel you trust. It works once{dialog.expires ? ` and expires ${new Date(dialog.expires).toLocaleString('en-GB')}` : ''}. It is not shown again.</p>
          <div className="fg"><input readOnly className="mono" value={dialog.url} onFocus={(e) => e.target.select()} aria-label="Link" /></div>
          <button type="button" className="btn btn-s btn-sm" onClick={() => navigator.clipboard?.writeText(dialog.url)}>Copy</button>
        </>)}
      </Modal>
    </>
  );
}
