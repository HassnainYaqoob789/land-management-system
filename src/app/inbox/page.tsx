'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import Shell from '@/components/layout/Shell';
import { Card, Modal, Field, Stage, Table, Toolbar, SearchBox, Count, Tabs, Loading, ErrorNote, Kpi, fmtNum } from '@/components/legacy/ui';
import { useList } from '@/components/legacy/data';
import { LoadError } from '@/components/auth/PageGuard';
import { send } from '@/lib/client/api';
import { routePermission, useCan } from '@/lib/client/permissions';

export default function InboxPage() {
  return <Shell><InboxContent /></Shell>;
}

// Where each workflow's records are worked on. Workflow codes are also the
// permission resources of their modules (cases → cases:read, cases:update …).
const SCREEN: Record<string, string> = {
  cases: '/cases', acquisitions: '/acquisitions', mutations: '/mutations', leases: '/leases', rows: '/rows',
  payments: '/payments', dbpfc: '/dbpfc', grievances: '/grievances', encroachments: '/encroachments',
};

/**
 * Commenting is a write on the record's approval discussion (UI-02): it needs
 * the record's module :update permission (or a dedicated inbox:comment), never
 * just inbox:read. The server enforces the same rule.
 */
const commentNeed = (workflow: string) => [`${workflow}:update`, 'inbox:comment'];

function InboxContent() {
  const list = useList('/api/inbox', 'assignments');
  const { body, loading, error } = list;
  const can = useCan();
  // Only what the user's modules allow (UI-09): the server filters too; this keeps a
  // queue row, comment or bottleneck of an unreadable module off the screen regardless.
  const readable = (a: { workflow_code?: string }) => !!a.workflow_code && can(`${a.workflow_code}:read`);
  const allAssignments: any[] = body?.assignments ?? [], notifications: any[] = body?.notifications ?? [];
  const assignments = allAssignments.filter(readable);
  const bottlenecks: any[] = (body?.bottlenecks ?? []).filter(readable), comments: any[] = (body?.comments ?? []).filter(readable);
  const mine = new Set<string>(body?.user_groups ?? []);
  const [tab, setTab] = useState<'mine' | 'all' | 'notifications' | 'bottlenecks'>('mine');
  const [q, setQ] = useState('');
  const [commentOn, setCommentOn] = useState<any | null>(null);
  const [text, setText] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const needle = q.trim().toLowerCase();
  const match = (a: any) => !needle || [a.record_code, a.workflow_code, a.stage_code, a.assigned_group, a.summary].join(' ').toLowerCase().includes(needle);
  const allMine: any[] = body?.mine ?? [];   // routed to this user's positions, by the server
  const forMe = allMine.filter(readable);
  // Server totals cover every page of the queue; if rows were withheld here, count only what is shown.
  const mineTotal = forMe.length === allMine.length ? (body?.mine_total ?? forMe.length) : forMe.length;
  const openTotal = assignments.length === allAssignments.length ? (body?.assignments_total ?? assignments.length) : assignments.length;
  const rows = (tab === 'mine' ? forMe : assignments).filter(match);
  const screenFor = (wf: string) => { const href = SCREEN[wf]; const need = href ? routePermission(href) : null; return href && (!need || can(need)) ? href : null; };
  const unread = notifications.filter((n) => !n.read_at);
  const act = async (b: object) => { setFormError(null); try { await send('POST', '/api/inbox', b); } catch (e: any) { setFormError(e.message); } };

  const comment = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setFormError(null);
    try { await send('POST', '/api/inbox', { action: 'comment', workflow_code: commentOn.workflow_code, record_id: commentOn.record_id, body: text }); setCommentOn(null); setText(''); }
    catch (err: any) { setFormError(err.message); } finally { setBusy(false); }
  };

  return (
    <>
      {/* No tiles until the queue has loaded: a refused or failed load never shows as zeroes. */}
      {body && (
        <div className="kpis">
          <Kpi label="Waiting on you" value={fmtNum(mineTotal)} sub={mine.size ? `positions: ${[...mine].join(', ')}` : 'you hold no approval position'} tone={forMe.length ? 'w' : 'g'} />
          <Kpi label="Open approvals" value={fmtNum(openTotal)} sub="all queues you can see" />
          <Kpi label="Overdue" value={fmtNum(bottlenecks.reduce((n, b) => n + Number(b.overdue_count || 0), 0))} sub="past their step's time limit" tone="d" />
          <Kpi label="Unread notifications" value={fmtNum(unread.length)} sub="for you" tone={unread.length ? 'w' : 'g'} />
        </div>
      )}
      <Card icon="bell" title="Approvals & Alerts" sub="Records waiting for an approval position, notifications, and where approvals are stuck">
        <LoadError {...list} what="the approval queue" />
        {formError && !commentOn && <ErrorNote>{formError}</ErrorNote>}
        {body && <Tabs label="Inbox" value={tab} onChange={setTab} tabs={[
          ['mine', `Waiting on you (${fmtNum(mineTotal)})`], ['all', `All open (${fmtNum(openTotal)})`],
          ['notifications', `Notifications (${unread.length})`], ['bottlenecks', `Bottlenecks (${bottlenecks.length})`],
        ]} />}
        {loading ? <Loading what="inbox" /> : error && !body ? null : (<>
          {(tab === 'mine' || tab === 'all') && (<>
            <Toolbar><SearchBox value={q} onChange={setQ} placeholder="Search record, workflow, stage or position…" /><Count n={rows.length} /></Toolbar>
            <Table caption="Approval queue"
              head={<><th>Record</th><th>Workflow</th><th>Waiting for</th><th>Position</th><th>Summary</th><th className="num">Days</th><th>Actions</th></>}
              empty={rows.length ? false : tab === 'mine' ? 'Nothing is waiting on you.' : 'No open approvals.'} colSpan={7}>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td><span className="code">{a.record_code}</span>{a.province_code && <><br /><span className="pill">{a.province_code}</span></>}</td>
                  <td>{a.workflow_code}</td>
                  <td><Stage value={a.stage_code} /></td>
                  <td>{a.assigned_group}{a.assigned_user_name && <><br /><small className="note">{a.assigned_user_name}</small></>}</td>
                  <td>{a.summary || <span className="note">—</span>}</td>
                  <td className="num"><span className={`b ${a.days_waiting > 7 ? 'b-d' : a.days_waiting > 3 ? 'b-w' : 'b-n'}`}>{a.days_waiting}</span></td>
                  <td><div className="acts">
                    {screenFor(a.workflow_code) && <Link href={screenFor(a.workflow_code)!}>Open</Link>}
                    {can(commentNeed(a.workflow_code), 'any') && (
                      <button onClick={() => { setFormError(null); setText(''); setCommentOn(a); }}>Comment</button>
                    )}
                  </div></td>
                </tr>
              ))}
            </Table>
            {comments.length > 0 && (<>
              <div className="sec-t u-mt-16">Latest comments</div>
              <div className="tl u-mt-8">
                {comments.slice(0, 10).map((c) => (
                  <div key={c.id}><b>{c.author_name || '—'}</b> on {c.workflow_code}<br /><small>{new Date(c.created_at).toLocaleString('en-GB')} — {c.body}</small></div>
                ))}
              </div>
            </>)}
          </>)}
          {tab === 'notifications' && (<>
            {unread.length > 0 && <div className="bar"><button className="btn btn-s btn-sm" onClick={() => act({ action: 'mark_all_read' })}>Mark all read</button></div>}
            {notifications.length === 0 && <div className="empty">No notifications.</div>}
            {notifications.map((n) => (
              <div key={n.id} className={`al ${n.urgency === 'urgent' || n.urgency === 'high' ? 'd' : n.read_at ? 'i' : 'w'}`}>
                <span className="i" />
                <div className="tx"><b>{n.title}</b>{n.record_code && <> · <span className="code">{n.record_code}</span></>}
                  <small>{new Date(n.created_at).toLocaleString('en-GB')}{n.body ? ` — ${n.body}` : ''}</small></div>
                {!n.read_at && <button className="btn btn-s btn-sm" onClick={() => act({ action: 'mark_read', notification_id: n.id })}>Mark read</button>}
              </div>
            ))}
          </>)}
          {tab === 'bottlenecks' && (
            <Table caption="Approval bottlenecks" head={<><th>Workflow</th><th>Stage</th><th>Position</th><th>Prov.</th><th className="num">Waiting</th><th className="num">Avg days</th><th className="num">Max days</th><th className="num">Overdue</th></>}
              empty={bottlenecks.length ? false : 'No approvals waiting.'} colSpan={8}>
              {bottlenecks.map((b, i) => (
                <tr key={i}><td>{b.workflow_label}</td><td><Stage value={b.stage_code} /></td><td>{b.assigned_group}</td><td><span className="pill">{b.province_code}</span></td>
                  <td className="num">{fmtNum(b.waiting_count)}</td><td className="num">{fmtNum(b.avg_days_waiting, 1)}</td><td className="num">{fmtNum(b.max_days_waiting)}</td>
                  <td className="num">{Number(b.overdue_count) > 0 ? <span className="b b-d">{b.overdue_count}</span> : '0'}</td></tr>
              ))}
            </Table>
          )}
        </>)}
      </Card>

      <Modal open={!!commentOn} size="sm" icon="send" title={`Comment on ${commentOn?.record_code ?? ''}`} onClose={() => setCommentOn(null)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setCommentOn(null)}>Cancel</button>
          <button type="submit" form="cmForm" className="btn btn-p" disabled={busy || !text.trim()}>Post</button>
        </>}>
        <form id="cmForm" onSubmit={comment}>
          <Field label="Comment" required htmlFor="cmText" hint="Visible to everyone who can see this record"><textarea id="cmText" required value={text} onChange={(e) => setText(e.target.value)} /></Field>
        </form>
      </Modal>
    </>
  );
}
