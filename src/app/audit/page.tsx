'use client';

import React, { useState } from 'react';
import Shell from '@/components/layout/Shell';
import { Card, Table, Toolbar, SearchBox, Select, Count, Tabs, Loading } from '@/components/legacy/ui';
import { LoadError } from '@/components/auth/PageGuard';
import { useApi } from '@/lib/client/api';

export default function AuditPage() {
  return (
    <Shell>
      <AuditContent />
    </Shell>
  );
}

type AuditTab = 'events' | 'versions' | 'auth' | 'docs';

function AuditContent() {
  const [tab, setTab] = useState<AuditTab>('events');
  const [entityFilter, setEntityFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [search, setSearch] = useState('');

  // Through useApi so a refusal shows as "no access", never as an empty trail (UI-08).
  const params = new URLSearchParams();
  if (entityFilter) params.append('entity', entityFilter);
  if (actionFilter) params.append('action', actionFilter);
  params.append('limit', '100');
  const audit = useApi<any>(`/api/audit?${params.toString()}`);
  const data = audit.data;
  const loading = audit.loading;
  const events: any[] = data?.auditEvents ?? [];
  const versions: any[] = data?.recordVersions ?? [];
  const authEvents: any[] = data?.authEvents ?? [];
  const docLogs: any[] = data?.documentAccessLogs ?? [];
  const distinctEntities: string[] = data?.distinctEntities ?? [];

  const needle = search.toLowerCase();
  const filtered = events.filter((e) =>
    [e.record_code, e.actor_username, e.note, e.entity].some((v) => String(v ?? '').toLowerCase().includes(needle)));

  const entityOptions = distinctEntities.length > 0
    ? distinctEntities
    : ['compensation_case', 'survey', 'landowner', 'lease', 'payment_request', 'payment_release'];

  return (
    <Card icon="receipt" title="Audit Trail"
      sub="Append-only history written by database triggers: every change, workflow decision, version snapshot, and security event">
      <LoadError {...audit} what="the audit trail" />
      <Tabs<AuditTab>
        label="Audit views"
        value={tab}
        onChange={setTab}
        tabs={[
          ['events', data ? `Business Events (${events.length})` : 'Business Events'],
          ['versions', data ? `Version Snapshots (${versions.length})` : 'Version Snapshots'],
          ['auth', data ? `Authentication Log (${authEvents.length})` : 'Authentication Log'],
          ['docs', data ? `Document Access (${docLogs.length})` : 'Document Access'],
        ]}
      />
      <Toolbar>
        <SearchBox value={search} onChange={setSearch} placeholder="Search record, user or note…" />
        {tab === 'events' && (
          <>
            <Select label="Entity" value={entityFilter} onChange={setEntityFilter} all="All records" options={entityOptions} />
            <Select label="Action" value={actionFilter} onChange={setActionFilter} all="All actions"
              options={['TRANSITION', 'INSERT', 'UPDATE', 'DELETE', 'EXECUTE']} />
          </>
        )}
        <Count n={tab === 'events' ? filtered.length : tab === 'versions' ? versions.length : tab === 'auth' ? authEvents.length : docLogs.length} />
      </Toolbar>
      {loading && !data ? <Loading what="audit events" /> : audit.error && !data ? null : (
        <>
          {tab === 'events' && (
            <Table caption="Audit events"
              head={<><th>When</th><th>User</th><th>Action</th><th>Record</th><th>Prov.</th><th>Note</th><th>Changes</th></>}
              empty={filtered.length ? false : 'No audit events match the filter.'} colSpan={7}>
              {filtered.map((e) => (
                <tr key={e.id}>
                  <td className="u-nowrap">{new Date(e.occurred_at).toLocaleString('en-GB')}</td>
                  <td>{e.actor_username || 'system'}{e.actor_role && <><br /><small className="note">{e.actor_role}</small></>}</td>
                  <td><span className={`b ${e.action === 'TRANSITION' ? 'b-i' : e.action === 'EXECUTE' ? 'b-g' : 'b-n'}`}>{e.action}</span></td>
                  <td><span className="code">{e.record_code || e.record_id?.slice(0, 8)}</span><br /><small className="note">{e.entity}</small></td>
                  <td>{e.province_code ? <span className="pill">{e.province_code}</span> : <span className="note">—</span>}</td>
                  <td title={e.note}>{e.note || <span className="note">—</span>}</td>
                  <td className="mono u-fs-11 u-mw-380 u-wrap-84" style={{ overflowWrap: 'anywhere' }} title={e.changes ? JSON.stringify(e.changes) : undefined}>
                    {e.changes ? JSON.stringify(e.changes).slice(0, 120) : e.changed_fields?.join(', ') || <span className="note">—</span>}
                  </td>
                </tr>
              ))}
            </Table>
          )}
          {tab === 'versions' && (
            <Table caption="Record version history"
              head={<><th>When</th><th>Table / Entity</th><th>Record</th><th>Operation</th><th>Version</th><th>Actor</th><th>Snapshot</th></>}
              empty={versions.length ? false : 'No version snapshots recorded.'} colSpan={7}>
              {versions.map((v: any, idx: number) => (
                <tr key={v.version_id || idx}>
                  <td className="u-nowrap">{v.captured_at ? new Date(v.captured_at).toLocaleString('en-GB') : '—'}</td>
                  <td><span className="pill">{v.table_name || v.entity}</span></td>
                  <td className="mono">{v.record_code || String(v.record_id || '').slice(0, 8)}</td>
                  <td><span className="b b-i">{v.operation || 'SNAPSHOT'}</span></td>
                  <td className="num">v{v.version_no || 1}</td>
                  <td>{v.actor_username || 'system'}</td>
                  <td className="mono u-fs-11">{v.row_snapshot ? JSON.stringify(v.row_snapshot).slice(0, 110) : '—'}</td>
                </tr>
              ))}
            </Table>
          )}
          {tab === 'auth' && (
            <Table caption="Authentication security log"
              head={<><th>When</th><th>Event</th><th>User</th><th>Outcome</th><th>Reason</th><th>IP Address</th></>}
              empty={authEvents.length ? false : 'No authentication events recorded.'} colSpan={6}>
              {authEvents.map((a: any) => (
                <tr key={a.id}>
                  <td className="u-nowrap">{new Date(a.occurred_at).toLocaleString('en-GB')}</td>
                  <td><span className="pill">{a.event_type}</span></td>
                  <td>{a.username || '—'}</td>
                  <td><span className={`b ${a.outcome === 'success' ? 'b-g' : 'b-d'}`}>{a.outcome}</span></td>
                  <td>{a.reason || '—'}</td>
                  <td className="mono">{a.ip_addr || '—'}</td>
                </tr>
              ))}
            </Table>
          )}
          {tab === 'docs' && (
            <Table caption="Document access log"
              head={<><th>When</th><th>Document</th><th>User</th><th>Action</th></>}
              empty={docLogs.length ? false : 'No document access events recorded.'} colSpan={4}>
              {docLogs.map((d: any) => (
                <tr key={d.id}>
                  <td className="u-nowrap">{new Date(d.accessed_at).toLocaleString('en-GB')}</td>
                  <td><span className="code">{d.doc_code}</span> — {d.doc_title}</td>
                  <td>{d.username || 'system'}</td>
                  <td><span className="b b-i">{d.action}</span></td>
                </tr>
              ))}
            </Table>
          )}
        </>
      )}
    </Card>
  );
}
