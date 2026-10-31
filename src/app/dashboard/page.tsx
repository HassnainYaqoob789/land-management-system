'use client';

// Executive dashboard in the reference's layout (legacy-demo/assets/js/app/dashboard.js:
// 3-tab role views Executive / Director / Field, 5-column KPI row, Chart.js 4
// canvases with hidden sr-only tables, recent-records tables).

import React, { useState } from 'react';
import Link from 'next/link';
import Shell, { useLMS } from '@/components/layout/Shell';
import { Card, Kpi, Stage, Table, Tabs, Loading, fmtNum, fmtRsM, fmtDate } from '@/components/legacy/ui';
import ChartBox, { PAL } from '@/components/legacy/ChartBox';
import { LoadError } from '@/components/auth/PageGuard';
import { navFor, showInMenu } from '@/components/layout/nav';
import { useApi } from '@/lib/client/api';
import { routePermission, useCan } from '@/lib/client/permissions';

export default function DashboardPage() {
  return (
    <Shell>
      <DashboardContent />
    </Shell>
  );
}

type View = 'exec' | 'dir' | 'field';

// Every section reads one module's data and is shown only to users who may read
// that module (UI-09): a denied section is left out, never shown as zero. Links
// go only to pages the user can open (UI-13).
function DashboardContent() {
  const { activeProvince, permissions, provinces } = useLMS();
  const can = useCan();
  const [view, setView] = useState<View>('exec');
  const pq = activeProvince !== 'ALL' ? `?province=${activeProvince}` : '';
  const kpiLoad = useApi<any>(`/api/analytics/kpis${pq}`);
  const casesLoad = useApi<any>(can('cases:read') ? `/api/cases${pq ? `${pq}&` : '?'}limit=8` : null);
  const kpiData = kpiLoad.data;
  const cases: any[] = casesLoad.data?.cases ?? [];                     // the eight most recent
  const caseTotals: Record<string, number> = casesLoad.data?.summary ?? {};   // over every case in scope
  const may = {
    surveys: can('surveys:read'), projects: can('projects:read'), cases: can('cases:read'), payments: can('payments:read'),
    leases: can('leases:read'), gis: can('gis:read'), inbox: can('inbox:read'),
  };
  const isAdminOnly = can('users:read') && !may.surveys && !may.cases && !may.payments;
  /** A link target only when the user can open it and see it in the menu. */
  const to = (href: string) => {
    const need = routePermission(href);
    const nav = navFor(href);
    if (nav && !showInMenu(nav.item, permissions, provinces)) return undefined;
    return !need || can(need) ? href : undefined;
  };

  if (kpiLoad.loading && !kpiData) return <Loading what="dashboard" />;
  if (kpiLoad.error && !kpiData) return <LoadError {...kpiLoad} what="the dashboard figures" />;

  // /api/analytics/kpis: kpis.executive (totals), kpis.portfolio (one row per
  // project), kpis.aging, kpis.bottlenecks (per workflow stage and position),
  // kpis.lease_alerts. The tiles below read those names exactly.
  const ex = kpiData?.kpis?.executive || {};
  const kpis = {
    total_acres: ex.total_area_acres, total_surveys: ex.total_parcels, total_projects: ex.total_projects,
    total_cases: ex.total_cases, active_leases: ex.total_leases == null ? undefined : Number(ex.total_leases) - Number(ex.expired_leases || 0),
    expiring_leases_90d: ex.expiring_90d_leases, leases_on_hold: ex.hold_leases,
  };
  const aging = may.payments ? kpiData?.kpis?.aging || [] : [];
  const projects = may.projects ? kpiData?.kpis?.portfolio || [] : [];
  const bottlenecks = (kpiData?.kpis?.bottlenecks || []).filter((b: any) => !b.workflow_code || can(`${b.workflow_code}:read`));
  const leaseAlerts = may.leases ? kpiData?.kpis?.lease_alerts || [] : [];
  // Area and approved compensation by province, from the registers (RPT-20): summing the
  // per-project portfolio dropped parcels with no project and counted shared parcels twice.
  const provBreakdown = ((kpiData?.provincial_breakdown || []) as any[])
    .map((p) => ({ province_code: p.province_code, acres: Number(p.acres || 0), comp_pkr: Number(p.comp_pkr || 0) }));

  const totalGross = Number(ex.total_approved_compensation || 0);
  const totalReleased = Number(ex.total_released || 0);
  const totalPending = Number(ex.outstanding_liability || 0);
  const execPct = totalGross > 0 ? Math.min(100, Math.round((totalReleased / totalGross) * 100)) : 0;

  if (isAdminOnly) {
    return (
      <>
        <div className="kpis kpis-4">
          <Kpi label="Users & Accounts" value="Manage" sub="accounts, sessions, MFA & province scope" href="/users" />
          <Kpi label="Roles & Permissions" value="RBAC" sub="system roles, custom roles & access reviews" href="/roles" />
          <Kpi label="Approval Matrix" value="SoD" sub="workflow stage approval positions" href="/matrix" />
          <Kpi label="Audit Trail" value="Immutable" sub="security events & record change history" tone="g" href="/audit" />
        </div>
        <div className="grid2">
          <Card icon="shield" title="Identity & Access Administration" sub="Strict Separation of Duties (SoD) — System Administrators manage governance, not land or payment records">
            <div className="bar">
              <Link className="btn btn-p" href="/users">Open Users &amp; Roles</Link>
              <Link className="btn btn-s" href="/roles">Open Roles &amp; Permissions</Link>
              <Link className="btn btn-s" href="/audit">Open Audit Trail</Link>
            </div>
          </Card>
          <Card icon="gear" title="System & Workflow Configuration" sub="Configure approval step positions, security policies, sign-in methods, and revenue unit hierarchy">
            <div className="bar">
              <Link className="btn btn-p" href="/settings">Open Settings</Link>
              <Link className="btn btn-s" href="/matrix">Approval Matrix</Link>
              <Link className="btn btn-s" href="/units">Administrative Hierarchy</Link>
              <Link className="btn btn-s" href="/arch">Architecture &amp; Security</Link>
            </div>
          </Card>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="bar u-mt-0 u-mb-12">
        <Tabs<View>
          label="Dashboard perspective"
          value={view}
          onChange={setView}
          tabs={[
            ['exec', 'Executive (MD / CFO)'],
            ['dir', 'Director Operations'],
            ['field', 'Field Operations'],
          ]}
        />
        <span className="grow" />
        {to('/inbox') && <Link className="btn btn-s btn-sm" href="/inbox">Approvals Inbox</Link>}
        {to('/calendar') && <Link className="btn btn-s btn-sm" href="/calendar">Expiry &amp; Hearing Calendar</Link>}
        {to('/reports') && <Link className="btn btn-s btn-sm" href="/reports">Open reports</Link>}
      </div>

      {view === 'exec' && (
        <>
          <div className="kpis kpis-5">
            {may.surveys && <Kpi label="Total Land Managed" value={`${fmtNum(kpis.total_acres, 1)} ac`}
              sub={`${fmtNum(kpis.total_surveys)} parcels${may.projects ? ` · ${fmtNum(kpis.total_projects)} projects` : ''}`} href={to('/surveys')} />}
            {may.cases && <Kpi label="Gross Compensation" value={fmtRsM(totalGross)}
              sub={`${fmtNum(kpis.total_cases)} cases`} href={to('/cases')} />}
            {may.payments && <Kpi label="Paid (Net Released)" value={fmtRsM(totalReleased)}
              sub={may.cases ? `${execPct}% of gross` : 'net of withholding tax'} tone="g" href={to('/payments')} />}
            {may.payments && <Kpi label="Outstanding Liability" value={fmtRsM(totalPending)}
              sub="approved, awaiting cheque" tone={totalPending > 0 ? 'w' : 'g'} href={to('/payments')} />}
            {may.leases && <Kpi label="Active Leases" value={fmtNum(kpis.active_leases)}
              sub={`${fmtNum(kpis.expiring_leases_90d)} expiring ≤ 90d · ${fmtNum(kpis.leases_on_hold)} on hold`}
              tone={Number(kpis.leases_on_hold) > 0 ? 'd' : Number(kpis.expiring_leases_90d) > 0 ? 'w' : 'g'} href={to('/leases')} />}
          </div>

          <div className="grid2">
            {may.projects && <Card icon="map" title={may.cases ? 'Provincial portfolio — area & compensation' : 'Provincial portfolio — area'}
              sub={may.cases ? 'Standardized acres and approved compensation by province' : 'Standardized acres by province'}>
              <ChartBox
                label="Provincial area and compensation"
                summary={provBreakdown.map((p: any) => [p.province_code, `${fmtNum(p.acres, 1)} ac${may.cases ? ` · ${fmtRsM(p.comp_pkr)}` : ''}`])}
                config={{
                  type: 'bar',
                  data: {
                    labels: provBreakdown.map((p: any) => p.province_code),
                    datasets: [
                      { label: 'Area (acres)', data: provBreakdown.map((p: any) => Number(p.acres || 0)), backgroundColor: PAL.teal, borderRadius: 4, yAxisID: 'y' },
                      ...(may.cases ? [{ label: 'Compensation (Rs M)', data: provBreakdown.map((p: any) => Number(p.comp_pkr || 0) / 1e6), backgroundColor: PAL.blue, borderRadius: 4, yAxisID: 'y1' }] : []),
                    ],
                  },
                  options: {
                    scales: {
                      x: { grid: { display: false } },
                      y: { position: 'left', title: { display: true, text: 'Acres' } },
                      ...(may.cases ? { y1: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Rs M' } } } : {}),
                    },
                  },
                }}
              />
            </Card>}

            {may.payments && <Card icon="wallet" title="Unpaid voucher aging" sub="Approved payment requests by days outstanding">
              <ChartBox
                label="Unpaid voucher aging brackets"
                summary={aging.map((b: any) => [b.aging_bracket, `${b.voucher_count ?? b.count} voucher(s) · ${fmtRsM(b.total_net_liability ?? b.net_amount)}`])}
                config={{
                  type: 'bar',
                  data: {
                    labels: aging.map((b: any) => b.aging_bracket),
                    datasets: [{
                      label: 'Net liability (Rs M)',
                      data: aging.map((b: any) => Number(b.total_net_liability ?? b.net_amount ?? 0) / 1e6),
                      backgroundColor: aging.map((b: any) => {
                        const br = String(b.aging_bracket);
                        return br.includes('>90') || br.includes('Over 90')
                          ? PAL.red
                          : br.includes('61')
                            ? PAL.amber
                            : PAL.teal;
                      }),
                      borderRadius: 4,
                    }],
                  },
                  options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { title: { display: true, text: 'Rs M' } }, y: { grid: { display: false } } } },
                }}
              />
            </Card>}
          </div>

          <div className="grid2">
            <Card icon="warn" title="Approval bottlenecks" sub="Records waiting, by workflow stage and approval position"
              actions={to('/inbox') && <Link className="btn btn-s btn-sm" href="/inbox">Approvals Inbox</Link>}>
              <Table
                caption="Approval bottlenecks"
                head={<><th>Workflow</th><th>Waiting for</th><th>Position</th><th>Prov.</th><th className="num">Waiting</th><th className="num">Max days</th><th className="num">Overdue</th></>}
                empty={bottlenecks.length ? false : 'Nothing is waiting for approval.'}
                colSpan={7}
              >
                {bottlenecks.slice(0, 6).map((b: any, i: number) => (
                  <tr key={`${b.workflow_code}-${b.stage_code}-${b.assigned_group}-${b.province_code}-${i}`}>
                    <td>{b.workflow_label}</td>
                    <td><Stage value={b.stage_code} /></td>
                    <td>{b.assigned_group}</td>
                    <td><span className="pill">{b.province_code}</span></td>
                    <td className="num">{fmtNum(b.waiting_count)}</td>
                    <td className="num"><span className={`b ${Number(b.max_days_waiting) > 30 ? 'b-d' : Number(b.max_days_waiting) > 7 ? 'b-w' : 'b-n'}`}>{fmtNum(b.max_days_waiting)}d</span></td>
                    <td className="num">{Number(b.overdue_count) > 0 ? <span className="b b-d">{b.overdue_count}</span> : '0'}</td>
                  </tr>
                ))}
              </Table>
            </Card>

            {may.leases && <Card icon="cal" title="Lease expiry alerts (≤ 90 days)" sub="Surface leases requiring renewal or escalation action">
              <Table
                caption="Lease expiry alerts"
                head={<><th>Lease no.</th><th>Prov.</th><th>Project</th><th>Lessor(s)</th><th>Expiry</th><th className="num">Days</th><th className="num">Annual rent (Rs)</th></>}
                empty={leaseAlerts.length ? false : 'No leases expiring within 90 days.'}
                colSpan={7}
              >
                {leaseAlerts.slice(0, 6).map((l: any) => (
                  <tr key={l.lease_id}>
                    <td>{to('/leases') ? <Link href="/leases" className="code">{l.lease_code}</Link> : <span className="code">{l.lease_code}</span>}</td>
                    <td><span className="pill">{l.province_code}</span></td>
                    <td>{l.project_code}</td>
                    <td>{l.lessors || '—'}</td>
                    <td>{fmtDate(l.end_date)}</td>
                    <td className="num"><span className={`b ${Number(l.days_to_expiry) <= 30 ? 'b-d' : 'b-w'}`}>{fmtNum(l.days_to_expiry)}d</span></td>
                    <td className="num">{fmtNum(l.annual_rent)}</td>
                  </tr>
                ))}
              </Table>
            </Card>}
          </div>
        </>
      )}

      {view === 'dir' && (
        <>
          <div className="kpis">
            {may.projects && <Kpi label="Operational Projects" value={fmtNum(kpis.total_projects)} sub="well pads, fields & blocks" href={to('/projects')} />}
            {may.cases && casesLoad.data && <Kpi label="Cases in Workflow" value={fmtNum(caseTotals.in_workflow)} sub="awaiting review or approval" tone="w" href={to('/cases')} />}
            {may.cases && casesLoad.data && <Kpi label="HO Approved Cases" value={fmtNum(caseTotals.ho_approved)} sub="locked against edits" tone="g" href={to('/cases')} />}
            {may.leases && <Kpi label="Leases On Hold" value={fmtNum(kpis.leases_on_hold)} sub="payments & renewals blocked" tone={Number(kpis.leases_on_hold) > 0 ? 'd' : 'g'} href={to('/leases')} />}
          </div>
          {may.projects && <Card icon="rig" title="Project portfolio" sub="Surveyed land, cases and financial exposure per project — click a project for its drill-down dashboard"
            actions={to('/projects') && <Link className="btn btn-s btn-sm" href="/projects">All projects</Link>}>
            <Table caption="Project portfolio"
              head={<><th>Code</th><th>Project</th><th>Prov.</th><th className="num">Parcels</th><th className="num">Acres</th>
                {may.cases && <><th className="num">Cases</th><th className="num">Approved (Rs)</th></>}{may.payments && <th className="num">Paid (Rs)</th>}<th>Status</th><th>Drill-down</th></>}
              empty={projects.length ? false : 'No projects.'} colSpan={7 + (may.cases ? 2 : 0) + (may.payments ? 1 : 0)}>
              {projects.map((p: any) => (
                <tr key={p.project_id}>
                  <td><Link href={`/projdash?id=${p.project_id}`} className="code">{p.project_code}</Link></td>
                  <td><Link href={`/projdash?id=${p.project_id}`}>{p.project_name}</Link></td>
                  <td><span className="pill">{p.province_code}</span></td>
                  <td className="num">{fmtNum(p.parcel_count)}</td>
                  <td className="num">{fmtNum(p.total_area_acres, 1)}</td>
                  {may.cases && <><td className="num">{fmtNum(p.case_count)}</td><td className="num">{fmtNum(p.approved_compensation)}</td></>}
                  {may.payments && <td className="num">{fmtNum(p.paid_compensation ?? p.total_released)}</td>}
                  <td><Stage value={p.project_status ?? p.status} /></td>
                  <td><Link className="btn btn-s btn-sm" href={`/projdash?id=${p.project_id}`}>Open</Link></td>
                </tr>
              ))}
            </Table>
          </Card>}
        </>
      )}

      {view === 'field' && (
        <div className="kpis">
          {may.surveys && <Kpi label="Survey Parcels" value={fmtNum(kpis.total_surveys)} sub="khasra / survey register" href={to('/surveys')} />}
          {may.cases && casesLoad.data && <Kpi label="Draft Cases (Prepared)" value={fmtNum(caseTotals.prepared)} sub="field officer stage" href={to('/cases')} />}
          {may.leases && <Kpi label="Expiring Leases (90d)" value={fmtNum(kpis.expiring_leases_90d)} sub="renewal notice needed" tone="w" href={to('/leases')} />}
          {may.gis && <Kpi label="GIS Land Map" value="Open" sub="parcels & KML layers" href={to('/gis')} />}
        </div>
      )}

      {may.cases && <Card icon="doc" title="Recent compensation cases" sub="Six-stage approval workflow with segregation of duties"
        actions={to('/cases') && <Link className="btn btn-p btn-sm" href="/cases">Compensation Cases</Link>}>
        <LoadError {...casesLoad} what="compensation cases" />
        <Table caption="Recent compensation cases"
          head={<><th>Case no.</th><th>Prov.</th><th>Project</th><th>Land use</th><th className="num">Gross (Rs)</th><th>Stage</th><th>Waiting on</th></>}
          empty={cases.length || casesLoad.error ? false : casesLoad.loading ? 'Loading cases…' : 'No compensation cases yet.'} colSpan={7}>
          {cases.slice(0, 8).map((c) => (
            <tr key={c.case_id}>
              <td><Link href="/cases" className="code">{c.case_code}</Link></td>
              <td><span className="pill">{c.province_code}</span></td>
              <td>{c.project_name}</td>
              <td>{c.land_use_code}</td>
              <td className="num">{fmtNum(c.total_amount ?? c.gross_amount)}</td>
              <td><Stage value={c.stage_code} /></td>
              <td>{c.waiting_on_group || <span className="note">—</span>}</td>
            </tr>
          ))}
        </Table>
      </Card>}
    </>
  );
}
