'use client';

import React, { useState, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import Shell from '@/components/layout/Shell';
import { Card, Kpi, Stage, Table, Loading, fmtNum, fmtRsM, fmtDate } from '@/components/legacy/ui';
import { LoadError } from '@/components/auth/PageGuard';
import { useApi } from '@/lib/client/api';
import { routePermission, useCan } from '@/lib/client/permissions';

export default function ProjectDashboardPage() {
  return (
    <Shell>
      <Suspense fallback={<Card title="Project Dashboard"><Loading what="project dashboard" /></Card>}>
        <ProjectDashboardContent />
      </Suspense>
    </Shell>
  );
}

// One project, drawn from several modules: each section loads and shows only
// when the user may read its module (UI-09), and links only to pages they can
// open (UI-13). The page itself needs projects:read.
function ProjectDashboardContent() {
  const searchParams = useSearchParams();
  const can = useCan();
  const [selectedId, setSelectedId] = useState<string>(searchParams.get('id') || '');
  const may = { surveys: can('surveys:read'), cases: can('cases:read'), leases: can('leases:read'), budgets: can('budgets:read'),
    payments: can('payments:read'), gis: can('gis:read') };
  const to = (href: string) => { const need = routePermission(href); return !need || can(need) ? href : undefined; };

  const projectsLoad = useApi<any>('/api/projects');
  const projects: any[] = projectsLoad.data?.projects || [];
  const pid = selectedId || projects[0]?.project_id || '';
  const code = projects.find((x) => x.project_id === pid)?.project_code ?? '';
  const detailLoad = useApi<any>(pid ? `/api/projects?id=${encodeURIComponent(pid)}` : null);
  // This project's cases and leases only, filtered in the database (at most 500 of each shown).
  const casesLoad = useApi<any>(may.cases && code ? `/api/cases?project=${encodeURIComponent(code)}&limit=500` : null);
  const leasesLoad = useApi<any>(may.leases && code ? `/api/leases?project=${encodeURIComponent(code)}&limit=500` : null);
  const budgetsLoad = useApi<any>(may.budgets && pid ? `/api/budgets?project_id=${encodeURIComponent(pid)}` : null);
  const detail = detailLoad.data;
  const cases: any[] = casesLoad.data?.cases || [];
  const leases: any[] = leasesLoad.data?.leases || [];
  const budgets: any[] = budgetsLoad.data?.budgets || [];
  const loading = (projectsLoad.loading && !projectsLoad.data) || (!!pid && detailLoad.loading && !detail);

  const p = detail?.project || projects.find((x) => x.project_id === pid) || {};
  const linkedSurveys: any[] = detail?.surveys || [];

  return (
    <>
      <Card
        icon="target"
        title={p.project_name ? `${p.project_code} — ${p.project_name}` : 'Project Drill-Down Dashboard'}
        sub="Single-project operational view: linked khasra/survey parcels, compensation cases, surface leases, and budget utilisation"
        actions={
          <label className="gl-field">
            <span className="note">Project </span>
            <select
              className="sel"
              aria-label="Select project"
              value={pid}
              onChange={(e) => setSelectedId(e.target.value)}
            >
              {projects.map((proj) => (
                <option key={proj.project_id} value={proj.project_id}>
                  {proj.project_code} — {proj.project_name} ({proj.province_code})
                </option>
              ))}
            </select>
          </label>
        }
      >
        <LoadError {...projectsLoad} what="projects" />
        {!projectsLoad.error && <LoadError {...detailLoad} what="this project" />}
        {loading ? (
          <Loading what="project drill-down" />
        ) : !projectsLoad.error && !projects.length ? (
          <div className="empty">No projects in your provinces.</div>
        ) : detail && (
          <div className="kpis kpis-5">
            {may.surveys && <Kpi label="Survey Parcels" value={fmtNum(p.survey_count ?? p.linked_parcels ?? linkedSurveys.length)} sub={`${fmtNum(p.total_acres ?? p.linked_area ?? 0, 2)} acres`} />}
            {may.cases && casesLoad.data && <Kpi label="Compensation Cases" value={fmtNum(casesLoad.data?.page?.total ?? cases.length)} sub={fmtRsM(p.approved_compensation ?? 0)} tone="g" />}
            {may.payments && <Kpi label="Paid Compensation" value={fmtRsM(p.total_released ?? p.released_amount ?? 0)} sub="net cheque disbursements" tone="g" />}
            {may.leases && leasesLoad.data && <Kpi label="Surface Leases" value={fmtNum(leasesLoad.data?.page?.total ?? leases.length)} sub={`${fmtNum(p.active_leases ?? leases.filter((l: any) => l.status_code !== 'expired').length)} active`} />}
            {may.gis && <Kpi label="Spatial Features" value={fmtNum(p.spatial_feature_count ?? p.gis_feature_count ?? 0)} sub="KML / GIS geometries" href={to('/gis')} />}
          </div>
        )}
      </Card>

      {detail && <div className="grid2">
        {may.surveys && <Card icon="map" title={`Linked Survey / Khasra Parcels (${linkedSurveys.length})`} sub="Cadastral parcels mapped to this project">
          <Table
            caption="Project survey parcels"
            head={<><th>Code</th><th>Survey / Khasra</th><th>Hierarchy</th><th className="num">Acres</th><th>Status</th></>}
            empty={linkedSurveys.length ? false : 'No survey parcels linked to this project.'}
            colSpan={5}
          >
            {linkedSurveys.map((s: any) => (
              <tr key={s.survey_id}>
                <td>
                  {to('/surveys')
                    ? <Link href="/surveys" className="code" aria-label={`Survey ${s.survey_code}`}>{s.survey_code}</Link>
                    : <span className="code">{s.survey_code}</span>}
                </td>
                <td>{s.survey_no || '—'}</td>
                <td>{s.location_path || '—'}</td>
                <td className="num">{fmtNum(s.total_area, 2)}</td>
                <td><Stage value={s.status_code} /></td>
              </tr>
            ))}
          </Table>
        </Card>}

        {may.budgets && <Card icon="trend" title={`Fiscal Budgets (${budgets.length})`} sub="Allocated, committed, and spent compensation budget">
          <LoadError {...budgetsLoad} what="budgets" />
          <Table
            caption="Project budgets"
            head={<><th>Fiscal Year</th><th className="num">Allocated (Rs)</th><th className="num">Committed (Rs)</th><th className="num">Spent (Rs)</th><th className="num">Used</th></>}
            empty={budgets.length || budgetsLoad.error ? false : budgetsLoad.loading ? 'Loading budgets…' : 'No budget lines allocated for this project.'}
            colSpan={5}
          >
            {budgets.map((b: any) => (
              <tr key={b.budget_id}>
                <td><span className="code">{b.fiscal_year}</span></td>
                <td className="num">{fmtNum(b.allocated_amount)}</td>
                <td className="num">{fmtNum(b.committed_amount)}</td>
                <td className="num">{fmtNum(b.spent_amount)}</td>
                <td className="num"><span className="pill">{fmtNum(b.utilization_pct, 1)}%</span></td>
              </tr>
            ))}
          </Table>
        </Card>}
      </div>}

      {detail && <div className="grid2">
        {may.cases && <Card icon="doc" title={`Compensation Cases (${cases.length})`} sub="Project compensation awards and workflow status">
          <LoadError {...casesLoad} what="compensation cases" />
          <Table
            caption="Project compensation cases"
            head={<><th>Case no.</th><th>Land use</th><th className="num">Total (Rs)</th><th>Stage</th><th>Waiting on</th></>}
            empty={cases.length || casesLoad.error ? false : casesLoad.loading ? 'Loading cases…' : 'No compensation cases for this project.'}
            colSpan={5}
          >
            {cases.map((c: any) => (
              <tr key={c.case_id}>
                <td><Link href="/cases" className="code">{c.case_code}</Link></td>
                <td>{c.land_use_code}</td>
                <td className="num">{fmtNum(c.total_amount)}</td>
                <td><Stage value={c.stage_code} /></td>
                <td>{c.waiting_on_group || '—'}</td>
              </tr>
            ))}
          </Table>
        </Card>}

        {may.leases && <Card icon="cal" title={`Surface Leases (${leases.length})`} sub="Registered lease agreements and expiry schedule">
          <LoadError {...leasesLoad} what="leases" />
          <Table
            caption="Project leases"
            head={<><th>Lease no.</th><th>Lessor(s)</th><th className="num">Area (ac)</th><th className="num">Annual rent (Rs)</th><th>Expiry</th><th>Status</th></>}
            empty={leases.length || leasesLoad.error ? false : leasesLoad.loading ? 'Loading leases…' : 'No leases for this project.'}
            colSpan={6}
          >
            {leases.map((l: any) => (
              <tr key={l.lease_id}>
                <td><Link href="/leases" className="code">{l.lease_code}</Link></td>
                <td>{l.lessors || '—'}</td>
                <td className="num">{fmtNum(l.current_area || l.initial_area, 2)}</td>
                <td className="num">{fmtNum(l.annual_rent)}</td>
                <td>{fmtDate(l.end_date)}</td>
                <td><Stage value={l.lease_status} /></td>
              </tr>
            ))}
          </Table>
        </Card>}
      </div>}
    </>
  );
}

