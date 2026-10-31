'use client';

import React from 'react';
import Link from 'next/link';
import Shell, { useLMS } from '@/components/layout/Shell';
import { PROVINCES } from '@/components/layout/nav';
import { Card, Kpi, Table, Loading, fmtNum, fmtRsM } from '@/components/legacy/ui';
import { LoadError } from '@/components/auth/PageGuard';
import { useApi } from '@/lib/client/api';
import { useCan } from '@/lib/client/permissions';

export default function ProvincePage() {
  return (
    <Shell>
      <ProvinceContent />
    </Shell>
  );
}

// The revenue systems themselves (levels, parcel identifiers, units) are reference
// information for every province. The figures are shown only for the user's own
// provinces and only for modules they may read (UI-09): area and parcels need
// surveys:read, approved compensation cases:read. A figure that is not the user's
// to see is left blank, never shown as zero.
function ProvinceContent() {
  const { provinces } = useLMS();
  const can = useCan();
  const kpiLoad = useApi<any>('/api/analytics/kpis');
  const unitLoad = useApi<any>('/api/units');
  const loading = kpiLoad.loading && !kpiLoad.data;
  const breakdown: any[] = kpiLoad.data?.provincial_breakdown || [];
  const adminUnits: any[] = unitLoad.data?.admin_units || [];
  const mine = (code: string) => provinces.includes(code);
  const showArea = can('surveys:read') && !!kpiLoad.data, showComp = can('cases:read') && !!kpiLoad.data;
  const cols = 5 + (showArea ? 2 : 0) + (showComp ? 1 : 0);
  const outside = <span className="note" title="Outside your province access">—</span>;

  return (
    <>
      <Card
        icon="bank"
        title="Provincial Revenue Systems (Sindh · Balochistan · Punjab · KPK)"
        sub="Comparison of provincial Boards of Revenue hierarchies, cadastral parcel identifiers, and area measurement units"
      >
        <LoadError {...kpiLoad} what="the provincial figures" />
        {loading ? (
          <Loading what="provincial revenue systems" />
        ) : (
          <Table
            caption="Provincial revenue systems"
            head={<><th>Code</th><th>Province</th><th>Revenue Hierarchy Levels</th><th>Parcel Identifier</th><th>Authorized Units</th>
              {showArea && <><th className="num">Parcels</th><th className="num">Area (acres)</th></>}{showComp && <th className="num">Approved (Rs)</th>}</>}
            colSpan={cols}
          >
            {Object.entries(PROVINCES).map(([code, meta]) => {
              const row = breakdown.find((b: any) => b.province_code === code) || {};
              return (
                <tr key={code}>
                  <td><span className="pill">{code}</span></td>
                  <td><b>{meta.name}</b></td>
                  <td>{meta.levels.join(' → ')}</td>
                  <td><span className="code">{meta.rev}</span></td>
                  <td>{meta.units.join(', ')}</td>
                  {showArea && (mine(code)
                    ? <><td className="num">{fmtNum(row.survey_count || 0)}</td><td className="num">{fmtNum(row.acres || 0, 2)}</td></>
                    : <><td className="num">{outside}</td><td className="num">{outside}</td></>)}
                  {showComp && <td className="num">{mine(code) ? fmtRsM(row.comp_pkr || 0) : outside}</td>}
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <div className="grid2">
        {Object.entries(PROVINCES).map(([code, meta]) => {
          const row = breakdown.find((b: any) => b.province_code === code) || {};
          const unitsInProv = adminUnits.filter((u: any) => u.province_code === code);
          const inScope = mine(code);
          return (
            <Card
              key={code}
              icon="map"
              title={`${meta.name} (${code}) — Board of Revenue`}
              sub={`${meta.rev} · Units: ${meta.units.join(' / ')}`}
              actions={inScope && can('surveys:read') && <Link className="btn btn-s btn-sm" href="/surveys">Open Parcels</Link>}
            >
              {inScope ? (
                <div className="kpis u-mb-12">
                  {showArea && <Kpi label="Surveyed Area" value={`${fmtNum(row.acres || 0, 1)} ac`} sub={`${fmtNum(row.survey_count || 0)} parcels`} />}
                  {showComp && <Kpi label="Approved Compensation" value={fmtRsM(row.comp_pkr || 0)} sub="HO-approved awards" tone="g" />}
                  {unitLoad.data && <Kpi label="Admin Units" value={fmtNum(unitsInProv.length)} sub={meta.levels.join(' / ')} />}
                </div>
              ) : <p className="note u-mb-10">Outside your province access: only the revenue system is shown.</p>}
              {inScope && <Table
                caption={`${meta.name} revenue units`}
                head={<><th>Level</th><th>Name</th><th>Full Path</th></>}
                empty={unitsInProv.length ? false : unitLoad.error ? unitLoad.error : unitLoad.loading ? 'Loading units…' : 'No units registered.'}
                colSpan={3}
              >
                {unitsInProv.slice(0, 6).map((u: any) => (
                  <tr key={u.id}>
                    <td><span className="pill">L{u.level_no} · {u.level_name}</span></td>
                    <td><b>{u.name}</b></td>
                    <td>{u.full_path}</td>
                  </tr>
                ))}
              </Table>}
            </Card>
          );
        })}
      </div>
    </>
  );
}

