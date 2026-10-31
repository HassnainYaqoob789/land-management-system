'use client';

// Reports: quick reports, the report builder, saved templates and the
// person / CNIC statement. Everything comes from the reporting engine
// (src/lib/reporting, /api/reports/*): datasets, fields, operators, units and
// quick reports from the catalogue; rows, totals, flags, scope and the
// applied filters from each run; files and the print view from the server.
// Nothing is filtered or totalled in the browser, so what is on screen, in a
// file and on paper always agree (UX-12).

import React, { useEffect, useMemo, useState } from 'react';
import Shell, { useLMS } from '@/components/layout/Shell';
import { useApi } from '@/lib/client/api';
import { useCan } from '@/lib/client/permissions';
import { useDebounced } from '@/components/legacy/data';
import { Card, Loading } from '@/components/legacy/ui';
import type { CatalogResult, ReportConfig, TemplateInfo } from '@/lib/reporting/types';
import ReportBuilder, { blankDraft, configOf, draftOf, type Draft } from '@/components/reports/ReportBuilder';
import ResultsView from '@/components/reports/ResultsView';
import TemplatesPanel, { templatesOf } from '@/components/reports/TemplatesPanel';
import ExportActions from '@/components/reports/ExportActions';
import PersonStatement from '@/components/reports/PersonStatement';
import { Landing, ReportNav, type Quick } from '@/components/reports/QuickReports';
import { useReportRun } from '@/components/reports/client';

type Source = { kind: 'quick'; key: string; label: string } | { kind: 'template'; id: string } | { kind: 'blank' };
type View = 'landing' | 'report' | 'person';

const DEFAULT_PAGE = 100;

function ReportsScreen() {
  const can = useCan();
  const { currentUser } = useLMS();
  const cat = useApi<CatalogResult>('/api/reports/catalog', { ttl: 60_000 });
  const tpl = useApi<unknown>('/api/reports/templates');
  const templates = useMemo(() => templatesOf(tpl.data), [tpl.data]);
  const catalog = cat.data;

  const [view, setView] = useState<View>('landing');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [source, setSource] = useState<Source>({ kind: 'blank' });
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE);
  // The page position belongs to one configuration; any other change starts again at the first page.
  const [pos, setPos] = useState<{ key: string; offset: number }>({ key: '', offset: 0 });

  const ds = catalog?.datasets.find((d) => d.key === draft?.dataset);
  const { config: base, problems } = useMemo(
    () => (draft ? configOf({ ...draft, page: undefined }, ds) : { config: null, problems: [] as string[] }), [draft, ds]);
  const baseKey = base ? JSON.stringify(base) : '';
  const offset = pos.key === baseKey ? pos.offset : 0;
  const wanted = base ? JSON.stringify({ ...base, page: { limit: pageSize, offset } }) : '';
  // While the draft is incomplete (a filter without a value) the last complete configuration stays applied,
  // and the screen says so; an incomplete filter is never dropped silently.
  const [applied, setApplied] = useState('');
  useEffect(() => { if (wanted) setApplied(wanted); }, [wanted]);
  // Settle rapid edits (typing a filter value) before running; the run itself aborts anything older.
  const runKey = useDebounced(view === 'report' ? applied : '', 300);
  const runConfig = useMemo(() => (runKey ? JSON.parse(runKey) as ReportConfig : null), [runKey]);

  const current: TemplateInfo | null = source.kind === 'template' ? templates.find((t) => t.id === source.id) ?? null : null;
  const title = source.kind === 'quick' ? source.label : current ? current.name : ds?.label ?? 'Report';
  const run = useReportRun(runConfig, runKey);
  const result = run.status === 'ok' ? run.result : undefined;

  const openQuick = (q: Quick) => { setDraft(draftOf(q.config)); setSource({ kind: 'quick', key: q.key, label: q.label }); setView('report'); };
  const openTemplate = (t: TemplateInfo) => { setDraft(draftOf(t.config)); setSource({ kind: 'template', id: t.id }); setView('report'); };
  const startBlank = (datasetKey?: string) => {
    if (!catalog?.datasets.length) return;
    const d = catalog.datasets.find((x) => x.key === datasetKey) ?? catalog.datasets[0];
    // The user's default template for this dataset, if any, is where a blank report starts.
    const def = templates.find((t) => t.mine && t.isDefault && t.dataset === d.key);
    if (def) openTemplate(def);
    else { setDraft(blankDraft(d)); setSource({ kind: 'blank' }); setView('report'); }
  };
  const onBuilderChange = (d: Draft) => {
    if (draft && d.dataset !== draft.dataset) { startBlank(d.dataset); return; }
    setDraft(d);
  };

  if (cat.loading && !catalog) return <Card title="Reports"><Loading what="report catalogue" /></Card>;
  if (cat.status === 403 || cat.status === 401) {
    return <Card title="Reports"><div className="al d" role="alert"><span className="i" /><div className="tx"><b>You do not have access to reports.</b><small>{cat.error}</small></div></div></Card>;
  }
  if (!catalog) {
    return (
      <Card title="Reports">
        <div className="al d" role="alert"><span className="i" /><div className="tx"><b>The report catalogue could not be loaded.</b>
          <small>{cat.error ?? 'No answer from the server.'}</small>
          <button type="button" className="btn btn-s btn-sm u-mt-6" onClick={cat.reload}>Try again</button></div></div>
      </Card>
    );
  }

  const active = view === 'person' ? 'person' : view === 'landing' ? '' : source.kind === 'quick' ? `q-${source.key}` : source.kind === 'template' ? `tpl-${source.id}` : 'builder';
  const quick = source.kind === 'quick' ? catalog.quickReports.find((q) => q.key === source.key) : undefined;
  const canPick = (resource: string) => (resource === '/api/projects' ? can('projects:read') : true);

  return (
    <div className="split">
      <ReportNav catalog={catalog} templates={templates} active={active} showPerson={can('landowners:read')}
        onQuick={openQuick} onTemplate={openTemplate} onBuilder={() => startBlank()} onPerson={() => setView('person')} />

      <div>
        {view === 'landing' && (
          <Card title="Reports" sub="Choose a quick report, start from one of your saved templates, or build your own.">
            <Landing catalog={catalog} onQuick={openQuick} />
            {tpl.error && tpl.status !== 404 && <p className="note u-mt-8" role="status">Saved templates could not be loaded: {tpl.error}</p>}
          </Card>
        )}

        {view === 'person' && (
          <Card title="Person / CNIC statement" sub="Land, shares, cases, payments, adjustments and balance for one person.">
            <PersonStatement canReadLandowners={can('landowners:read')} />
          </Card>
        )}

        {view === 'report' && draft && (
          <>
            <Card title={title}
              sub={<>{quick?.description ?? current?.description ?? ds?.description}{result ? ` · ${result.meta.scope}` : ''}</>}
              actions={catalog.can.export ? (
                <ExportActions config={run.status === 'ok' ? runConfig : null} title={title} preferred={current?.exportFormat}
                  limits={catalog.exportLimits} total={result?.page.total} />
              ) : undefined}>
              <TemplatesPanel config={base} current={current} canShare={catalog.can.share} department={currentUser?.department ?? null}
                onSaved={(t) => { tpl.reload(); if (t) setSource({ kind: 'template', id: t.id }); }}
                onDeleted={() => { tpl.reload(); setSource({ kind: 'blank' }); }} />
              <details open={source.kind !== 'quick'}>
                <summary className="sec-t" style={{ cursor: 'pointer' }}>Customise: columns, filters, grouping, sorting and units</summary>
                <div className="u-mt-8">
                  <ReportBuilder catalog={catalog} draft={draft} onChange={onBuilderChange} canPick={canPick} />
                </div>
              </details>
              {problems.length > 0 && (
                <div className="al w u-mt-8" role="alert"><span className="i" /><div className="tx">
                  <b>The results below do not reflect your latest changes yet.</b>
                  <small>{problems.join(' ')}</small>
                </div></div>
              )}
            </Card>
            <Card title="Results" sub={result ? `One row per ${result.meta.grain.replace(/^one row per /, '')}` : undefined}>
              <ResultsView state={run} caption={title} pageSize={pageSize} onRetry={run.retry}
                onPageSize={(n) => { setPageSize(n); setPos({ key: baseKey, offset: 0 }); }}
                onOffset={(o) => setPos({ key: baseKey, offset: o })} />
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

export default function ReportsPage() {
  return <Shell><ReportsScreen /></Shell>;
}
