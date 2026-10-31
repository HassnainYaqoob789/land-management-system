'use client';

// Roles & Permissions: the roles with their status, database tier, members and
// system flag; create a custom role, edit it, set its permissions by resource
// and scope, activate / suspend / retire it; compare two roles; each role's
// members and history; and periodic access reviews. Controls show only what
// the signed-in user may do; the server and the database check every change
// again (delegation: nobody grants what they do not hold).

import React, { useCallback, useState } from 'react';
import Shell from '@/components/layout/Shell';
import { Card, Table, Toolbar, SearchBox, Count, Tabs, Loading, ErrorNote, Kpi, Select, fmtNum } from '@/components/legacy/ui';
import { useApi } from '@/lib/client/api';
import RoleForm from '@/components/roles/RoleForm';
import PermissionEditor from '@/components/roles/PermissionEditor';
import RoleStatusDialog from '@/components/roles/RoleStatusDialog';
import RoleDetail, { statusBadge } from '@/components/roles/RoleDetail';
import RoleCompare from '@/components/roles/RoleCompare';
import AccessReviews from '@/components/roles/AccessReviews';
import { statusTargets } from '@/components/roles/model';
import type { RolesPayload } from '@/components/roles/types';

export default function RolesPage() {
  return <Shell><RolesContent /></Shell>;
}

type Dialog = null | { kind: 'create' } | { kind: 'edit' | 'perms' | 'status' | 'view'; code: string };

function RolesContent() {
  const { data, loading, error } = useApi<RolesPayload>('/api/roles');
  const [tab, setTab] = useState<'roles' | 'compare' | 'reviews'>('roles');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = useCallback(() => setDialog(null), []);
  const openView = useCallback((code: string) => setDialog({ kind: 'view', code }), []);

  const roles = data?.roles ?? [];
  const can = data?.actor.can;
  const role = dialog && 'code' in dialog ? roles.find((r) => r.code === dialog.code) ?? null : null;
  const needle = q.trim().toLowerCase();
  const shown = roles.filter((r) => (!status || r.status === status)
    && (!needle || `${r.code} ${r.name} ${r.description}`.toLowerCase().includes(needle)));
  const tabs: [typeof tab, string][] = [['roles', `Roles (${roles.length})`], ['compare', 'Compare roles']];
  if (can?.reviewRead) tabs.push(['reviews', 'Access reviews']);

  return (
    <>
      <div className="kpis">
        <Kpi label="Roles" value={fmtNum(roles.length)} sub={`${fmtNum(roles.filter((r) => !r.is_system).length)} custom`} />
        <Kpi label="Active" value={fmtNum(roles.filter((r) => r.status === 'active').length)} tone="g" sub="grant their permissions" />
        <Kpi label="Suspended" value={fmtNum(roles.filter((r) => r.status === 'inactive').length)} tone="w" sub="assignments confer nothing" />
        <Kpi label="Retired" value={fmtNum(roles.filter((r) => r.status === 'retired').length)} sub="final" />
      </div>
      <Card icon="shield" title="Roles & Permissions"
        sub="Permissions are resource + action + scope · you can grant only what you hold · every change re-confirms your identity and is audited"
        actions={can?.create ? <button type="button" className="btn btn-p" onClick={() => setDialog({ kind: 'create' })}>+ New role</button> : undefined}>
        {error && <ErrorNote>{error}</ErrorNote>}
        <Tabs label="Role administration" value={tab} onChange={setTab} tabs={tabs} />
        {loading && !data ? <Loading what="roles" /> : data && (<>
          {tab === 'roles' && (<>
            <Toolbar>
              <SearchBox value={q} onChange={setQ} placeholder="Search role code, name or description…" />
              <Select label="Status" value={status} onChange={setStatus} all="All statuses"
                options={[['active', 'Active'], ['inactive', 'Suspended'], ['retired', 'Retired']]} />
              <Count n={shown.length} />
            </Toolbar>
            <Table caption="Roles" head={<><th>Role</th><th>Database tier</th><th>Status</th><th>Members</th><th>Permissions</th><th>Type</th><th>Actions</th></>}
              empty={shown.length ? false : 'No roles match.'} colSpan={7}>
              {shown.map((r) => {
                const editable = !r.is_system && r.status !== 'retired';
                const targets = statusTargets(r.status, r.is_system).filter((s) => (s === 'retired' ? can?.delete : can?.update));
                return (
                  <tr key={r.id}>
                    <td><b>{r.name}</b><br /><small className="note mono">{r.code}</small>{r.description && <><br /><small className="note">{r.description}</small></>}</td>
                    <td>{r.tier_name ?? r.db_role_code}</td>
                    <td>{statusBadge(r.status)}{r.status_reason && r.status !== 'active' && <><br /><small className="note">{r.status_reason}</small></>}</td>
                    <td>{fmtNum(r.member_count)}</td>
                    <td>{fmtNum(r.permissions.length)}</td>
                    <td>{r.is_system ? <span className="b b-i" title="Defined by migration; fixed">system</span> : <span className="b b-n">custom</span>}
                      {!r.grantable && <><br /><small className="note" title="It contains permissions you do not hold, or sits above your tier">beyond your authority</small></>}</td>
                    <td><div className="acts">
                      <button type="button" onClick={() => openView(r.code)}>View</button>
                      {can?.update && editable && <button type="button" onClick={() => setDialog({ kind: 'edit', code: r.code })}>Edit</button>}
                      {can?.managePermissions && editable && <button type="button" onClick={() => setDialog({ kind: 'perms', code: r.code })}>Permissions</button>}
                      {targets.length > 0 && (
                        <button type="button" disabled={!r.grantable} title={r.grantable ? undefined : 'You cannot change the status of a role containing permissions you do not hold'}
                          onClick={() => setDialog({ kind: 'status', code: r.code })}>Status</button>
                      )}
                    </div></td>
                  </tr>
                );
              })}
            </Table>
          </>)}
          {tab === 'compare' && <RoleCompare roles={roles} />}
        </>)}
      </Card>
      {tab === 'reviews' && can?.reviewRead && <AccessReviews roles={roles} />}

      {dialog?.kind === 'create' && data && (
        <RoleForm role={null} tiers={data.tiers} actorTierRank={data.actor.tierRank} onClose={close}
          onCreated={(code) => setDialog(data.actor.can.managePermissions ? { kind: 'perms', code } : null)} />
      )}
      {dialog?.kind === 'edit' && role && data && <RoleForm role={role} tiers={data.tiers} actorTierRank={data.actor.tierRank} onClose={close} />}
      {dialog?.kind === 'perms' && role && data && <PermissionEditor role={role} catalogue={data.catalogue} holds={data.actor.holds} onClose={close} />}
      {dialog?.kind === 'status' && role && can && <RoleStatusDialog role={role} can={can} onClose={close} />}
      {dialog?.kind === 'view' && <RoleDetail code={dialog.code} onClose={close} />}
    </>
  );
}
