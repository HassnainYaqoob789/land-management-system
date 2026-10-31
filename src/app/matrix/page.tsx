'use client';

import React, { useMemo, useState } from 'react';
import Shell from '@/components/layout/Shell';
import { Card, Modal, Field, Table, Loading, Kpi, fmtNum } from '@/components/legacy/ui';
import { LoadError } from '@/components/auth/PageGuard';
import { send, useApi } from '@/lib/client/api';
import { useCan } from '@/lib/client/permissions';

export default function MatrixPage() {
  return <Shell><MatrixContent /></Shell>;
}

// The approval matrix as PostgreSQL holds it: for each workflow stage, the
// approval positions (lms.workflow_step_group) whose holders may move a record
// into it. Changes go through api.set_step_groups (migration 0034).
function MatrixContent() {
  const can = useCan();
  const settings = useApi<any>('/api/settings');
  const { data, loading, error } = settings;
  const workflows: any[] = data?.workflows ?? [], stages: any[] = data?.workflow_stages ?? [];
  const steps: any[] = data?.workflow_step_groups ?? [], groups: any[] = data?.approval_groups ?? [], history: any[] = data?.matrix_history ?? [];
  // Changing who approves is a settings change (settings:update); the server re-checks it.
  const canEdit = can('settings:update');
  const [edit, setEdit] = useState<{ wf: any; st: any } | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const groupName = useMemo(() => Object.fromEntries(groups.map((g) => [g.code, g.name])), [groups]);
  const groupsFor = (wf: string, st: string) => steps.filter((s) => s.workflow_code === wf && s.to_stage === st).map((s) => s.group_code);

  const save = async (e: React.FormEvent) => {
    e.preventDefault(); if (!edit) return; setBusy(true); setFormError(null);
    try {
      await send('PUT', '/api/settings', { action: 'set_step_groups', workflow_code: edit.wf.code, to_stage: edit.st.code, groups: chosen, note }, { also: ['/api/reference'] });
      setEdit(null);
    } catch (err: any) { setFormError(err.message); } finally { setBusy(false); }
  };

  return (
    <>
      {data && (
        <div className="kpis">
          <Kpi label="Workflows" value={fmtNum(workflows.length)} sub="with approval steps" />
          <Kpi label="Approval steps" value={fmtNum(new Set(steps.map((s) => `${s.workflow_code}/${s.to_stage}`)).size)} sub="stages that need a position" />
          <Kpi label="Positions" value={fmtNum(groups.length)} sub="approval groups" />
          <Kpi label="Matrix changes" value={fmtNum(history.length)} sub="recorded" tone="g" />
        </div>
      )}
      <LoadError {...settings} what="the approval matrix" />
      {loading && !data ? <Loading what="approval matrix" /> : workflows.map((wf) => {
        const wfStages = stages.filter((s) => s.workflow_code === wf.code).sort((a, b) => a.seq - b.seq);
        const first = wfStages.find((s) => !s.is_terminal);
        return (
          <Card key={wf.code} icon="compass" title={wf.label}
            sub={`Separation of duties: ${wf.sod_mode}${wf.lock_at_stage ? ` · locked at ${wf.lock_at_stage}` : ''}${wf.allows_cancel ? ' · can be cancelled' : ''}${wf.allows_stop ? ' · can be stopped' : ''}`}>
            <Table caption={`${wf.label} approval steps`} head={<><th>#</th><th>Stage</th><th>What it means</th><th>Approved by</th><th></th></>} colSpan={5}>
              {wfStages.filter((s) => !s.is_terminal).map((st) => {
                const g = groupsFor(wf.code, st.code);
                const isFirst = st.code === first?.code;
                return (
                  <tr key={st.code}>
                    <td className="num">{st.seq}</td>
                    <td><b>{st.label}</b></td>
                    <td>{st.step_note || <span className="note">—</span>}</td>
                    <td>{isFirst ? <span className="note">Created here</span> : g.length ? g.map((c) => <span key={c} className="pill">{groupName[c] ?? c}</span>)
                      : <span className="b b-w">No position — administrative override only</span>}</td>
                    <td><div className="acts">{canEdit && !isFirst && (
                      <button onClick={() => { setFormError(null); setChosen(g); setNote(''); setEdit({ wf, st }); }}>Change</button>
                    )}</div></td>
                  </tr>
                );
              })}
            </Table>
          </Card>
        );
      })}
      <Card icon="receipt" title="Matrix history" sub="Every position added to or removed from a step">
        <Table caption="Approval matrix history" head={<><th>When</th><th>Workflow</th><th>Stage</th><th>Change</th><th>Position</th><th>By</th></>}
          empty={history.length ? false : 'No changes recorded.'} colSpan={6}>
          {history.map((h) => (
            <tr key={h.id}><td>{new Date(h.changed_at).toLocaleString('en-GB')}</td><td>{h.workflow_code}</td><td>{h.to_stage}</td>
              <td><span className={`b ${h.action === 'added' ? 'b-g' : 'b-d'}`}>{h.action}</span></td><td>{groupName[h.group_code] ?? h.group_code}</td><td>{h.changed_by_name || '—'}</td></tr>
          ))}
        </Table>
      </Card>

      <Modal open={!!edit} size="sm" icon="compass" title={`Who approves “${edit?.st.label ?? ''}”`} onClose={() => setEdit(null)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setEdit(null)}>Cancel</button>
          <button type="submit" form="mxForm" className="btn btn-p" disabled={busy || chosen.length === 0}>{busy ? 'Saving…' : 'Save'}</button>
        </>}>
        <form id="mxForm" onSubmit={save}>
          <p className="note u-mb-10">{edit?.wf.label}. Anyone holding one of these positions may move a record into this stage — unless they prepared it or approved an earlier step.</p>
          <div className="fg checks">
            {groups.map((g) => (
              <label key={g.code}><input type="checkbox" checked={chosen.includes(g.code)}
                onChange={(e) => setChosen((c) => (e.target.checked ? [...c, g.code] : c.filter((x) => x !== g.code)))} /> {g.name}</label>
            ))}
          </div>
          <Field label="Reason" required htmlFor="mxNote"><input id="mxNote" required minLength={5} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. delegation order no. and date" /></Field>
        </form>
      </Modal>
    </>
  );
}
