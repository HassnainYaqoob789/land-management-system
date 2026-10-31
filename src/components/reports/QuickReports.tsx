'use client';

// Quick reports from the catalogue, grouped by category: the side list (as the
// legacy reports screen had it) and the landing page cards.

import React from 'react';
import type { CatalogResult, DatasetInfo, TemplateInfo } from '@/lib/reporting/types';
import { SharedBadge } from './TemplatesPanel';

export type Quick = CatalogResult['quickReports'][number];
export const CATEGORIES: DatasetInfo['category'][] = ['Executive', 'Land & ownership', 'Persons & CNIC', 'Acquisition', 'Compensation & payments'];

export function groupQuick(q: Quick[]): [string, Quick[]][] {
  const m = new Map<string, Quick[]>();
  for (const c of CATEGORIES) m.set(c, []);
  for (const r of q) m.set(r.category, [...(m.get(r.category) ?? []), r]);
  return [...m.entries()].filter(([, l]) => l.length > 0);
}

/** Runnable quick reports: those whose dataset the viewer may read (the catalogue lists only those). */
export const runnable = (c: CatalogResult) => c.quickReports.filter((q) => c.datasets.some((d) => d.key === q.config.dataset));

export function ReportNav({ catalog, templates, active, onQuick, onTemplate, onBuilder, onPerson, showPerson }: {
  catalog: CatalogResult; templates: TemplateInfo[]; active: string;
  onQuick: (q: Quick) => void; onTemplate: (t: TemplateInfo) => void; onBuilder: () => void; onPerson: () => void; showPerson: boolean;
}) {
  const link = (id: string, label: React.ReactNode, on: () => void, title?: string) => (
    <a key={id} href={`#${id}`} title={title} className={active === id ? 'active' : undefined} aria-current={active === id ? 'true' : undefined}
      onClick={(e) => { e.preventDefault(); on(); }}>{label}</a>
  );
  return (
    <nav className="card rlist" aria-label="Reports">
      <div className="g">Build</div>
      {link('builder', 'Build a report', onBuilder)}
      {showPerson && link('person', 'Person / CNIC statement', onPerson)}
      {templates.length > 0 && (
        <>
          <div className="g">Saved templates</div>
          {templates.map((t) => link(`tpl-${t.id}`, <>{t.name} <SharedBadge t={t} />{t.isDefault && t.mine ? <span className="b b-g">default</span> : null}</>, () => onTemplate(t), t.description ?? undefined))}
        </>
      )}
      {groupQuick(runnable(catalog)).map(([cat, list]) => (
        <React.Fragment key={cat}>
          <div className="g">{cat}</div>
          {list.map((q) => link(`q-${q.key}`, q.label, () => onQuick(q), q.description))}
        </React.Fragment>
      ))}
    </nav>
  );
}

export function Landing({ catalog, onQuick }: { catalog: CatalogResult; onQuick: (q: Quick) => void }) {
  const groups = groupQuick(runnable(catalog));
  if (groups.length === 0) return <div className="empty">No quick reports are available with your permissions. You can still build a report from the datasets you may read.</div>;
  return (
    <div className="grid2">
      {groups.map(([cat, list]) => (
        <section key={cat} className="card" aria-label={cat}>
          <div className="card-h"><div><h3>{cat}</h3><p>{list.length} report{list.length === 1 ? '' : 's'}</p></div></div>
          <ul className="u-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {list.map((q) => (
              <li key={q.key} style={{ padding: '6px 0', borderTop: '1px solid var(--border)' }}>
                <button type="button" className="as-link" onClick={() => onQuick(q)} style={{ fontWeight: 600, textAlign: 'left' }}>{q.label}</button>
                <div className="note">{q.description}</div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
