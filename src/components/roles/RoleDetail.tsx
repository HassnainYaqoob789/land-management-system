'use client';

// One role: its permissions by resource, its members and its history (who
// changed what, when — from the audit trail of the role, its permissions and
// its assignments).

import React, { useEffect, useState } from 'react';
import { Modal, Table, Tabs, Loading, ErrorNote, fmtDate } from '@/components/legacy/ui';
import { useApi } from '@/lib/client/api';
import { groupByResource, scopeLabel, STATUS_LABEL, type RoleStatus } from './model';
import type { RoleSummary } from './types';

interface Detail {
  role: RoleSummary;
  permissions: { resource: string; action: string; scope_level: string; description: string; is_sensitive: boolean }[];
  members: { assignment_id: string; user_id: string; username: string | null; full_name: string | null; user_code: string | null;
             user_status: string | null; scope_province: string | null; granted_at: string; granted_by_name: string | null;
             expires_at: string | null; reason: string | null; expired: boolean }[];
}
interface HistoryPage { events: { id: string; at: string; actor: string; entity: string; action: string; summary: string }[]; next: string | null }

export function statusBadge(status: string) {
  const tone = status === 'active' ? 'b-g' : status === 'inactive' ? 'b-w' : 'b-n';
  return <span className={`b ${tone}`}>{STATUS_LABEL[status as RoleStatus] ?? status}</span>;
}

function History({ code }: { code: string }) {
  const [pages, setPages] = useState<HistoryPage['events']>([]);
  const [before, setBefore] = useState<string | null>(null);
  const url = `/api/roles/${code}/history?limit=50${before ? `&before=${before}` : ''}`;
  const { data, loading, error } = useApi<HistoryPage>(url, { ttl: 5_000 });
  useEffect(() => {
    if (!data) return;
    // Each page adds older events; the first page replaces what was there.
    setPages((p) => (before ? [...p.filter((e) => !data.events.some((x) => x.id === e.id)), ...data.events] : data.events));
  }, [data, before]);
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (loading && !pages.length) return <Loading what="history" />;
  return (<>
    <Table caption="Role history" head={<><th>When</th><th>Who</th><th>What</th></>} empty={pages.length ? false : 'Nothing recorded yet.'} colSpan={3}>
      {pages.map((e) => (
        <tr key={e.id}><td className="u-nowrap">{new Date(e.at).toLocaleString('en-GB')}</td><td>{e.actor}</td><td>{e.summary}</td></tr>
      ))}
    </Table>
    {data?.next && <div className="bar"><button type="button" className="btn btn-s btn-sm" disabled={loading} onClick={() => setBefore(data.next)}>Older…</button></div>}
  </>);
}

export default function RoleDetail({ code, onClose }: { code: string; onClose: () => void }) {
  const [tab, setTab] = useState<'permissions' | 'members' | 'history'>('permissions');
  const { data, loading, error } = useApi<Detail>(`/api/roles/${code}`, { ttl: 5_000 });
  const role = data?.role;
  return (
    <Modal open size="lg" icon="shield" title={role ? `${role.name} (${role.code})` : code} onClose={onClose}
      footer={<button type="button" className="btn btn-p" onClick={onClose}>Close</button>}>
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data ? <Loading what="role" /> : role && (<>
        <p className="u-mb-10">{statusBadge(role.status)} {role.is_system && <span className="b b-i">system</span>} Database tier <b>{role.tier_name ?? role.db_role_code}</b>
          {' · '}{role.member_count} member(s){role.created_by_name ? ` · created by ${role.created_by_name}` : ''}
          {role.description && <><br /><span className="note">{role.description}</span></>}</p>
        <Tabs label="Role detail" value={tab} onChange={setTab}
          tabs={[['permissions', `Permissions (${data!.permissions.length})`], ['members', `Members (${data!.members.length})`], ['history', 'History']]} />
        {tab === 'permissions' && (
          <Table caption="Permissions" head={<><th>Resource</th><th>Action</th><th>Scope</th></>} empty={data!.permissions.length ? false : 'This role grants nothing.'} colSpan={3}>
            {groupByResource(data!.permissions).flatMap(([resource, list]) => list.map((p, i) => (
              <tr key={`${resource}:${p.action}`}>
                <td>{i === 0 ? <b className="mono">{resource}</b> : ''}</td>
                <td>{p.action}{p.is_sensitive && <> <span className="b b-w">sensitive</span></>}<br /><small className="note">{p.description}</small></td>
                <td>{scopeLabel(p.scope_level)}</td>
              </tr>
            )))}
          </Table>
        )}
        {tab === 'members' && (
          <Table caption="Members" head={<><th>Member</th><th>Limited to</th><th>Granted</th><th>By</th><th>Expires</th><th>Reason</th></>}
            empty={data!.members.length ? false : 'Nobody holds this role.'} colSpan={6}>
            {data!.members.map((m) => (
              <tr key={m.assignment_id}>
                <td>{m.full_name ?? '—'}<br /><small className="note mono">{m.username ?? m.user_id}</small>
                  {m.user_status && m.user_status !== 'Active' && <> <span className="b b-d">{m.user_status}</span></>}</td>
                <td>{m.scope_province ?? 'all their provinces'}</td>
                <td>{fmtDate(m.granted_at)}</td><td>{m.granted_by_name ?? '—'}</td>
                <td>{m.expires_at ? <>{fmtDate(m.expires_at)}{m.expired && <> <span className="b b-d">expired</span></>}</> : '—'}</td>
                <td>{m.reason ?? '—'}</td>
              </tr>
            ))}
          </Table>
        )}
        {tab === 'history' && <History code={code} />}
      </>)}
    </Modal>
  );
}
