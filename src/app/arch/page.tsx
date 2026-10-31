'use client';

import React from 'react';
import Shell from '@/components/layout/Shell';
import { Card, Kpi, Table, Loading, fmtNum } from '@/components/legacy/ui';
import { useReference } from '@/lib/client/api';

// How the system is built and which rules the database itself enforces. The
// counts and the workflow table are read live from PostgreSQL (/api/reference);
// the prose names only mechanisms that exist in this codebase.

const LAYERS: [string, string][] = [
  ['Screens', 'Next.js App Router pages in the legacy-demo design system (src/styles/legacy), MapLibre GL 4.7.1 for the land map, Chart.js 4.4.0 for charts. Lists are cached per tab and refreshed after every change.'],
  ['API boundary', 'Route handlers wrapped by protect(): an opaque session cookie (only its SHA-256 is stored), a CSRF token plus Origin check on every write, the permission each action needs, and one transaction per request with the signed-in user set as the database actor.'],
  ['Database API', 'api.* views run with the caller\'s rights; api.* routines carry the rules — advance_workflow, request_payment, release_payment, apply_mutation, set_step_groups, convert_area.'],
  ['Data and rules', 'lms.* tables with row-level security by province, CHECK and foreign-key constraints, and triggers for share totals, locks, holds and history.'],
  ['Audit and identity', 'audit.* is append-only (every change, with before and after); iam.* holds roles, permissions, two-step verification (TOTP) and sessions. Directory sign-in (LDAP / OIDC) is not implemented.'],
];

const RULES: [string, string][] = [
  ['Shares total 100%', 'Deferred constraint triggers ownership_share_total_ck, case_owner_share_total_ck and mutation_heir_share_total_ck refuse a transaction that leaves a survey, case or succession off 100%.'],
  ['Separation of duties', 'Whoever prepared a record cannot approve it, and nobody approves two steps of the same record; each step is limited to the approval positions in the matrix (api.advance_workflow).'],
  ['One step at a time', 'Stages advance one at a time; cancelling or stopping is a separate, recorded exit; a record at its workflow\'s lock stage cannot change.'],
  ['Money', 'One release per voucher; a second voucher for the same payee, category and period is refused; any active hold (including a court stay) blocks release.'],
  ['Withholding tax', 'Set by api.request_payment, never by the request: finance.wht_pct for filers, times finance.wht_nonfiler_multiplier for non-filer landowners (migration 0035).'],
  ['Succession', 'A deceased owner is locked; an approved mutation moves the shares to the heirs inside the same transaction (api.apply_mutation).'],
  ['Documents', 'Files are stored by the SHA-256 of their bytes outside the database; the type is checked from the file itself and the hash is verified on every download.'],
];

export default function ArchPage() {
  return <Shell><ArchContent /></Shell>;
}

function ArchContent() {
  const ref = useReference();
  if (!ref) return <Loading what="system description" />;
  const workflows = Object.entries(ref.workflows);
  return (
    <>
      <div className="kpis">
        <Kpi label="Workflows" value={fmtNum(workflows.length)} sub="each with its approval matrix" />
        <Kpi label="Reference lists" value={fmtNum(Object.keys(ref.lookups).length)} sub="lookup tables" />
        <Kpi label="Constrained fields" value={fmtNum(Object.keys(ref.enums).length)} sub="values fixed by CHECK constraints" />
        <Kpi label="Land units" value={fmtNum(ref.lookups.measurement_unit?.length ?? 0)} sub="convertible by lms.convert_area" tone="g" />
      </div>
      <div className="grid2">
        <Card icon="layers" title="How it is built">
          <Table caption="Layers" head={<><th>Layer</th><th>What it does</th></>} colSpan={2}>
            {LAYERS.map(([k, v]) => <tr key={k}><td><b>{k}</b></td><td>{v}</td></tr>)}
          </Table>
        </Card>
        <Card icon="shield" title="Rules the database enforces">
          <Table caption="Rules" head={<><th>Rule</th><th>How</th></>} colSpan={2}>
            {RULES.map(([k, v]) => <tr key={k}><td><b>{k}</b></td><td>{v}</td></tr>)}
          </Table>
        </Card>
      </div>
      <Card icon="compass" title="Workflows" sub="Read from lms.workflow and lms.workflow_stage">
        <Table caption="Workflows" head={<><th>Workflow</th><th>Stages</th><th>Exits</th><th>Locks at</th></>} colSpan={4}>
          {workflows.map(([code, w]) => (
            <tr key={code}>
              <td><b>{w.label}</b><br /><small className="note mono">{code}</small></td>
              <td>{w.stages.filter((s) => !s.terminal).map((s) => s.code).join(' → ')}</td>
              <td>{[w.allowsCancel && 'Cancel', w.allowsStop && 'Stop'].filter(Boolean).join(', ') || '—'}</td>
              <td>{w.lockAt || '—'}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
