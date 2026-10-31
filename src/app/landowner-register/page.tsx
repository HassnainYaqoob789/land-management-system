'use client';

// Landowner Register (0056): every landowner with each parcel (khasra) they
// hold, filtered province-wise and by revenue location, owner status, tax
// status, owner type, land class and hold, in the province's unit, a common
// unit or as recorded, with totals and export. Read-only.
//
// Runs the report engine's `landowner_register` dataset (api.rpt_ownership),
// which needs only landowner_report:read — so the system administrator can
// read it without the registers' own permissions (0047 keeps those away from
// the administrator). The CNIC is masked without pii:read, and row-level
// security keeps every reader to their provinces; the engine also audits
// every run of a personal dataset.

import React, { useEffect, useMemo, useState } from 'react';
import Shell, { useLMS } from '@/components/layout/Shell';
import { useApi } from '@/lib/client/api';
import { useDebounced } from '@/components/legacy/data';
import { Card, Field, Loading } from '@/components/legacy/ui';
import ResultsView from '@/components/reports/ResultsView';
import ExportActions from '@/components/reports/ExportActions';
import { useReportRun } from '@/components/reports/client';
import type { CatalogResult, FilterSpec, ReportConfig } from '@/lib/reporting/types';

const DATASET = 'landowner_register';
const PROVINCES: [string, string][] = [['SND', 'Sindh'], ['BAL', 'Balochistan'], ['PNJ', 'Punjab'], ['KPK', 'Khyber Pakhtunkhwa']];
const DETAIL_COLUMNS = ['owner_code', 'owner_name', 'father_name', 'cnic', 'province_code', 'district', 'tehsil', 'village',
  'survey_no', 'land_class', 'share_pct', 'parcel_area', 'owned_area', 'owner_type', 'owner_status', 'tax_status', 'owner_on_hold'];
const GROUPINGS: Record<string, { label: string; groupBy: string[]; columns: string[] }> = {
  none: { label: 'No grouping — one row per owner per khasra', groupBy: [], columns: DETAIL_COLUMNS },
  province: { label: 'Province totals', groupBy: ['province_code'], columns: ['province_code', 'owned_area', 'parcel_area'] },
  district: { label: 'Province and district totals', groupBy: ['province_code', 'district'], columns: ['province_code', 'district', 'owned_area', 'parcel_area'] },
  owner: { label: 'One row per owner (land held)', groupBy: ['province_code', 'owner_code', 'owner_name'], columns: ['province_code', 'owner_code', 'owner_name', 'owned_area'] },
};

interface Unit { id: string; province_code: string; level: number; name: string; parent_id: string | null }
interface Level { province_code: string; depth: number }

const EMPTY = { province: '', district: '', tehsil: '', village: '', status: '', type: '', tax: '', landClass: '', hold: '',
  name: '', code: '', khasra: '', unit: 'province', grouping: 'none' };

function RegisterScreen() {
  const { activeProvince } = useLMS();
  const cat = useApi<CatalogResult>('/api/reports/catalog', { ttl: 60_000 });
  const units = useApi<{ admin_units: Unit[]; province_levels: Level[] }>('/api/units', { ttl: 300_000 });
  const catalog = cat.data;
  const allowed = !!catalog?.datasets.some((d) => d.key === DATASET);

  const [f, setF] = useState({ ...EMPTY, province: activeProvince && activeProvince !== 'ALL' ? activeProvince : '' });
  // The header's province chip narrows this screen too.
  useEffect(() => { setF((s) => ({ ...s, province: activeProvince && activeProvince !== 'ALL' ? activeProvince : '', district: '', tehsil: '', village: '' })); }, [activeProvince]);
  const set = (k: keyof typeof EMPTY) => (v: string) => setF((s) => {
    const next = { ...s, [k]: v };
    // A narrower place belongs to the wider one chosen above it.
    if (k === 'province') { next.district = ''; next.tehsil = ''; next.village = ''; }
    if (k === 'district') { next.tehsil = ''; next.village = ''; }
    if (k === 'tehsil') next.village = '';
    return next;
  });

  // Revenue locations for the dropdowns: district (level 0), tehsil/taluka (level 1), and the
  // province's lowest level (deh / mouza) beneath the chosen tehsil.
  const all = units.data?.admin_units ?? [];
  const leafDepth = (p: string) => Math.max(0, ...(units.data?.province_levels ?? []).filter((l) => l.province_code === p).map((l) => l.depth));
  const byId = useMemo(() => new Map(all.map((u) => [u.id, u])), [all]);
  const under = (u: Unit, ancestorId: string) => { for (let x: Unit | undefined = u; x; x = x.parent_id ? byId.get(x.parent_id) : undefined) if (x.id === ancestorId) return true; return false; };
  const districts = all.filter((u) => u.level === 0 && (!f.province || u.province_code === f.province));
  const districtId = districts.find((u) => u.name === f.district)?.id;
  const tehsils = districtId ? all.filter((u) => u.level === 1 && u.parent_id === districtId) : [];
  const tehsilId = tehsils.find((u) => u.name === f.tehsil)?.id;
  const villages = tehsilId ? all.filter((u) => u.level === leafDepth(u.province_code) && u.level > 1 && under(u, tehsilId)) : [];
  const uniq = (xs: Unit[]) => [...new Set(xs.map((u) => u.name))].sort();

  // The report configuration from the filters.
  const config = useMemo<ReportConfig | null>(() => {
    if (!allowed) return null;
    const filters: FilterSpec[] = [];
    const eq = (field: string, value: string) => { if (value) filters.push({ field, op: 'eq', value }); };
    eq('province_code', f.province); eq('district', f.district); eq('tehsil', f.tehsil); eq('village', f.village);
    eq('owner_status', f.status); eq('owner_type', f.type); eq('tax_status', f.tax); eq('land_class', f.landClass);
    if (f.hold) filters.push({ field: 'owner_on_hold', op: 'eq', value: f.hold === 'yes' });
    if (f.name.trim()) filters.push({ field: 'owner_name', op: 'contains', value: f.name.trim() });
    if (f.code.trim()) filters.push({ field: 'owner_code', op: 'starts', value: f.code.trim().toUpperCase() });
    if (f.khasra.trim()) filters.push({ field: 'survey_no', op: 'contains', value: f.khasra.trim() });
    const g = GROUPINGS[f.grouping] ?? GROUPINGS.none;
    const uom = f.unit === 'province' || f.unit === 'original' ? { mode: f.unit as 'province' | 'original' } : { mode: 'common' as const, unit: f.unit };
    return {
      dataset: DATASET, columns: g.columns, filters, groupBy: g.groupBy, summaryOnly: g.groupBy.length > 0, totals: true,
      sort: g.groupBy.length ? g.groupBy.map((field) => ({ field, dir: 'asc' as const }))
        : [{ field: 'province_code', dir: 'asc' }, { field: 'owner_code', dir: 'asc' }, { field: 'parcel_code', dir: 'asc' }],
      uom,
    };
  }, [allowed, f]);

  const [pageSize, setPageSize] = useState(100);
  const baseKey = config ? JSON.stringify(config) : '';
  const [pos, setPos] = useState<{ key: string; offset: number }>({ key: '', offset: 0 });
  const offset = pos.key === baseKey ? pos.offset : 0;
  // Typing in a search box settles before the report runs; the run itself aborts anything older.
  const runKey = useDebounced(config ? JSON.stringify({ ...config, page: { limit: pageSize, offset } }) : '', 350);
  const runConfig = useMemo(() => (runKey ? JSON.parse(runKey) as ReportConfig : null), [runKey]);
  const run = useReportRun(runConfig, runKey);
  const result = run.status === 'ok' ? run.result : undefined;

  if (cat.loading && !catalog) return <Card title="Landowner Register"><Loading what="landowner register" /></Card>;
  if (catalog && !allowed) {
    return <Card title="Landowner Register"><p className="note">This register needs the landowner_report:read permission together with reports:read.</p></Card>;
  }
  const title = `Landowner Register${f.province ? ` — ${PROVINCES.find(([c]) => c === f.province)?.[1] ?? f.province}` : ' — all provinces in your access'}`;
  const sel = (id: string, value: string, onChange: (v: string) => void, options: (string | [string, string])[], any = 'All') => (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{any}</option>
      {options.map((o) => (Array.isArray(o) ? <option key={o[0]} value={o[0]}>{o[1]}</option> : <option key={o} value={o}>{o}</option>))}
    </select>
  );

  return (
    <>
      <Card icon="user" title="Landowner Register"
        sub="Every landowner and each khasra they hold, province-wise, with the area of their share. Read-only; CNIC is shown in full only to holders of the personal-data permission."
        actions={catalog?.can.export ? <ExportActions config={run.status === 'ok' ? runConfig : null} title={title} limits={catalog.exportLimits} total={result?.page.total} /> : undefined}>
        <div className="fgrid fgrid-4" role="group" aria-label="Filters">
          <Field label="Province" htmlFor="lrProv">{sel('lrProv', f.province, set('province'), PROVINCES, 'All provinces')}</Field>
          <Field label="District" htmlFor="lrDist">{sel('lrDist', f.district, set('district'), uniq(districts), districts.length ? 'All districts' : '—')}</Field>
          <Field label="Taluka / tehsil" htmlFor="lrTeh" hint={!f.district ? 'Choose a district first' : undefined}>{sel('lrTeh', f.tehsil, set('tehsil'), uniq(tehsils))}</Field>
          <Field label="Deh / mouza" htmlFor="lrVil" hint={!f.tehsil ? 'Choose a taluka / tehsil first' : undefined}>{sel('lrVil', f.village, set('village'), uniq(villages))}</Field>
          <Field label="Owner status" htmlFor="lrSt">{sel('lrSt', f.status, set('status'), ['Active', 'Deceased', 'Inactive'])}</Field>
          <Field label="Owner type" htmlFor="lrTy">{sel('lrTy', f.type, set('type'), [['O', 'Owner'], ['B', 'Owner and attorney'], ['A', 'Attorney']])}</Field>
          <Field label="Tax status" htmlFor="lrTax">{sel('lrTax', f.tax, set('tax'), ['Filer', 'Non-Filer'])}</Field>
          <Field label="Land class" htmlFor="lrLc">{sel('lrLc', f.landClass, set('landClass'), ['Private', 'Government'])}</Field>
          <Field label="Payment hold on owner" htmlFor="lrHold">{sel('lrHold', f.hold, set('hold'), [['yes', 'On hold (stay order)'], ['no', 'Not on hold']], 'Any')}</Field>
          <Field label="Owner name" htmlFor="lrName"><input id="lrName" value={f.name} onChange={(e) => set('name')(e.target.value)} placeholder="Part of the name" /></Field>
          <Field label="Owner code" htmlFor="lrCode"><input id="lrCode" className="mono" value={f.code} onChange={(e) => set('code')(e.target.value)} placeholder="e.g. SND-0000" /></Field>
          <Field label="Survey / khasra no." htmlFor="lrKh"><input id="lrKh" value={f.khasra} onChange={(e) => set('khasra')(e.target.value)} placeholder="e.g. 999/1" /></Field>
          <Field label="Area unit" htmlFor="lrUnit" hint="Province unit: each row in its province's reporting unit">
            <select id="lrUnit" value={f.unit} onChange={(e) => set('unit')(e.target.value)}>
              <option value="province">Province unit (default)</option>
              <option value="original">As recorded in the revenue record</option>
              {(catalog?.units ?? []).map((u) => <option key={u.code} value={u.code}>All in {u.name}{u.confirmed ? '' : ' (provisional factor)'}</option>)}
            </select>
          </Field>
          <Field label="Show" htmlFor="lrGrp">
            <select id="lrGrp" value={f.grouping} onChange={(e) => set('grouping')(e.target.value)}>
              {Object.entries(GROUPINGS).map(([k, g]) => <option key={k} value={k}>{g.label}</option>)}
            </select>
          </Field>
        </div>
        <div className="bar u-mt-12"><button type="button" className="btn btn-s" onClick={() => setF({ ...EMPTY })}>Clear filters</button></div>
      </Card>
      <Card title="Results" sub={result ? `${result.meta.scope}` : undefined}>
        <ResultsView state={run} caption={title} pageSize={pageSize} onRetry={run.retry}
          onPageSize={(n) => { setPageSize(n); setPos({ key: baseKey, offset: 0 }); }}
          onOffset={(o) => setPos({ key: baseKey, offset: o })} />
      </Card>
    </>
  );
}

export default function LandownerRegisterPage() {
  return <Shell><RegisterScreen /></Shell>;
}
