'use client';

// The result of a report run: what was applied (scope, filters, unit), the
// table with labelled subtotal and total rows, the unit beside every land
// quantity, data-quality flags with a legend, drill-down links, pagination
// and distinct loading / empty / error / denied states.

import React from 'react';
import Link from 'next/link';
import { Icon, Pager } from '@/components/legacy/ui';
import type { ColumnOut, ReportResult, RowOut } from '@/lib/reporting/types';
import type { RunState } from './client';
import { cellText, flagLong, flagShort, fmtWhen, headerText, isNumeric, rowLabel, safeHref } from './format';

export const PAGE_SIZES = [25, 50, 100, 250, 500];

const SUB_STYLE: React.CSSProperties = { background: 'var(--surface-2)', fontWeight: 600 };
const TOTAL_STYLE: React.CSSProperties = { background: 'var(--surface-3)', fontWeight: 700, borderTop: '2px solid var(--border-strong)' };

function unitText(r: ReportResult): string {
  const u = r.meta.uom;
  if (u.mode === 'common') return `All areas converted to ${u.unit}`;
  if (u.mode === 'original') return 'As originally recorded (acres where the recorded unit was not kept)';
  const list = (u.provinceUnits ?? []).map((p) => `${p.province}${p.landClass ? ` ${p.landClass}` : ''}: ${p.unit}${p.approved ? '' : ' (proposed)'}`);
  return `Each province in its reporting unit${list.length ? ` — ${list.join(', ')}` : ''}`;
}

/** What the report covers. Printed with the page too (it is not inside a toolbar), so a printout always says what it shows. */
export function AppliedSummary({ r }: { r: ReportResult }) {
  const hasArea = r.columns.some((c) => c.type === 'area');
  return (
    <div className="dl" aria-label="What this report covers">
      <div><small>Scope</small><span>{r.meta.scope}</span></div>
      <div><small>Filters</small><span>{r.meta.filtersApplied.length ? r.meta.filtersApplied.join('; ') : 'None'}</span></div>
      {hasArea && <div><small>Unit of measure</small><span>{unitText(r)}</span></div>}
      <div><small>Generated</small><span>{fmtWhen(r.meta.generatedAt)}{r.meta.reference ? ` · ${r.meta.reference}` : ''}</span></div>
      {r.columns.some((c) => c.sensitive) && <div><small>Personal data</small><span>{r.meta.piiMasked ? 'CNICs masked' : 'Shown in full (authorised)'}</span></div>}
    </div>
  );
}

function FlagCell({ flags, text }: { flags?: string[]; text?: Record<string, string> }) {
  if (!flags?.length) return <td />;
  return (
    <td>
      {flags.map((k) => (
        <span key={k} className="b b-w" title={flagLong(k, text)} style={{ marginRight: 4, whiteSpace: 'nowrap' }}>
          <Icon name="warn" size={12} /> {flagShort(k)}
        </span>
      ))}
    </td>
  );
}

function ResultTable({ r, caption }: { r: ReportResult; caption: string }) {
  const cols = r.columns;
  const firstAgg = !!cols[0]?.aggregate;
  const flagCol = r.rows.some((x) => x.flags?.length);
  const perRowUnit = cols.some((c) => c.type === 'area' && !c.unit);
  const flagText = r.meta.flagText;

  const cell = (c: ColumnOut, x: RowOut, i: number, labelHere: string | null) => {
    const v = x.cells[c.key];
    const num = isNumeric(c.type);
    let text = cellText(c, v);
    const unit = c.type === 'area' && !c.unit && v !== null && v !== undefined && x.unit ? x.unit : null;
    if (labelHere) {
      text = v === null || v === undefined ? labelHere : `${text} — ${labelHere.toLowerCase()}`;
      return <th key={c.key} scope="row" style={{ textAlign: 'left', fontWeight: 'inherit' }}>{text}</th>;
    }
    const body = <>{text}{unit && <span className="note"> {unit}</span>}</>;
    return (
      <td key={c.key} className={num ? 'num' : undefined}>
        {i === 0 && x.kind === 'detail' && safeHref(x.href) ? <Link className="code" href={safeHref(x.href)!}>{body}</Link> : body}
      </td>
    );
  };

  /** Which column carries a subtotal's / total's label: the innermost group value shown, else the first column. */
  const labelKey = (x: RowOut): string | null => {
    if (x.kind === 'detail' || firstAgg) return null;
    if (x.kind === 'subtotal') {
      let last: string | null = null;
      for (const c of cols) if (!c.aggregate && x.cells[c.key] !== null && x.cells[c.key] !== undefined) last = c.key;
      if (last) return last;
    }
    const first = cols[0];
    return first && (x.cells[first.key] === null || x.cells[first.key] === undefined) ? first.key : null;
  };

  return (
    <div className="tw" tabIndex={0} role="region" aria-label={caption}>
      <table className="t">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {firstAgg && <th scope="col"><span className="sr-only">Row</span></th>}
            {cols.map((c) => (
              <th key={c.key} scope="col" className={isNumeric(c.type) ? 'num' : undefined} title={c.aggregate ? `Subtotal and total rows show the ${c.aggregate}` : undefined}>
                {headerText(c)}{c.type === 'area' && !c.unit && perRowUnit && <span className="sr-only"> (unit shown in each row)</span>}
              </th>
            ))}
            {flagCol && <th scope="col">Flags</th>}
          </tr>
        </thead>
        <tbody>
          {r.rows.map((x, ri) => {
            const lbl = rowLabel(x);
            const lk = labelKey(x);
            const style = x.kind === 'total' ? TOTAL_STYLE : x.kind === 'subtotal' ? SUB_STYLE : undefined;
            return (
              <tr key={ri} style={style} data-kind={x.kind} data-level={x.level}>
                {firstAgg && (lbl ? <th scope="row" style={{ textAlign: 'left', fontWeight: 'inherit' }}>{lbl}</th> : <td />)}
                {cols.map((c, i) => cell(c, x, i, lk === c.key ? lbl : null))}
                {flagCol && <FlagCell flags={x.flags} text={flagText} />}
              </tr>
            );
          })}
          {r.rows.length === 0 && <tr><td colSpan={cols.length + (firstAgg ? 1 : 0) + (flagCol ? 1 : 0)} className="empty">No records match these filters.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function FlagLegend({ r }: { r: ReportResult }) {
  const keys = Object.keys(r.flags);
  const extra = r.meta.flagText ? Object.keys(r.meta.flagText).filter((k) => !keys.includes(k)) : [];
  if (!keys.length && !extra.length) return null;
  return (
    <section className="u-mt-12" aria-label="Flags">
      <h4 className="sec-t">Flags in this result</h4>
      <ul className="u-list" style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
        {keys.map((k) => (
          <li key={k} style={{ marginBottom: 4 }}>
            <span className="b b-w"><Icon name="warn" size={12} /> {flagShort(k)}</span>{' '}
            {flagLong(k, r.meta.flagText)} — <b>{r.flags[k].toLocaleString('en-PK')}</b> record{r.flags[k] === 1 ? '' : 's'}
          </li>
        ))}
        {extra.map((k) => (
          <li key={k} style={{ marginBottom: 4 }}><span className="b b-w"><Icon name="warn" size={12} /> {flagShort(k)}</span> {flagLong(k, r.meta.flagText)}</li>
        ))}
      </ul>
    </section>
  );
}

function UnitTotals({ r }: { r: ReportResult }) {
  if (!r.unitTotals?.length || (!r.meta.mixedUnits && r.unitTotals.length < 2)) return null;
  const aggCols = r.columns.filter((c) => c.aggregate);
  return (
    <section className="u-mt-12" aria-label="Totals by unit">
      <h4 className="sec-t">Totals by unit</h4>
      {r.meta.mixedUnits && <p className="note">Rows are in different units, so land areas have no single grand total. These are the totals per unit.</p>}
      <div className="tw" tabIndex={0} role="region" aria-label="Totals by unit">
        <table className="t">
          <thead><tr><th scope="col">Unit</th><th scope="col" className="num">Records</th>{aggCols.map((c) => <th key={c.key} scope="col" className="num">{headerText(c)}</th>)}</tr></thead>
          <tbody>
            {r.unitTotals.map((u) => (
              <tr key={u.unit}>
                <th scope="row" style={{ textAlign: 'left' }}>{u.unit}</th>
                <td className="num">{u.rows.toLocaleString('en-PK')}</td>
                {aggCols.map((c) => <td key={c.key} className="num">{cellText(c, u.cells[c.key])}{c.type === 'area' && u.cells[c.key] != null ? <span className="note"> {u.unit}</span> : null}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** "Showing 1–100 of 1,234 records" for the live region and the pager line. */
export function countText(r: ReportResult): string {
  const { offset, total } = r.page;
  if (total === 0) return 'No records match these filters.';
  // Detail mode pages records; summary mode pages group rows.
  const hasDetail = r.rows.some((x) => x.kind === 'detail');
  const shown = r.rows.filter((x) => (hasDetail ? x.kind === 'detail' : x.kind === 'subtotal')).length;
  const noun = hasDetail ? 'record' : 'group row';
  if (offset === 0 && shown >= total) return `${total.toLocaleString('en-PK')} ${noun}${total === 1 ? '' : 's'}`;
  return `Showing ${(offset + 1).toLocaleString('en-PK')}–${Math.min(total, offset + shown).toLocaleString('en-PK')} of ${total.toLocaleString('en-PK')} ${noun}s`;
}

export default function ResultsView({ state, caption, onOffset, pageSize, onPageSize, onRetry }: {
  state: RunState; caption: string; onOffset: (o: number) => void; pageSize: number; onPageSize: (n: number) => void; onRetry: () => void;
}) {
  const r = state.status === 'ok' ? state.result : state.status === 'loading' ? state.previous : undefined;
  const live =
    state.status === 'loading' ? 'Running report…'
      : state.status === 'ok' ? countText(state.result)
        : state.status === 'error' ? 'The report could not be run.'
          : state.status === 'denied' ? 'You do not have access to this report.'
            : state.status === 'invalid' ? 'The report settings need attention.' : '';
  return (
    <div aria-busy={state.status === 'loading'}>
      <p className="note u-mb-8" role="status" aria-live="polite" aria-atomic="true" data-testid="report-count">{live}</p>

      {state.status === 'idle' && <div className="empty">Choose a quick report or build your own to see results.</div>}
      {state.status === 'loading' && !r && <div className="empty">Running report…</div>}
      {state.status === 'denied' && (
        <div className="al d" role="alert" data-state="denied"><span className="i" /><div className="tx">
          <b>You do not have access to this report.</b>
          <small>{state.message} Ask an administrator if you need it.</small>
        </div></div>
      )}
      {state.status === 'invalid' && (
        <div className="al w" role="alert" data-state="invalid"><span className="i" /><div className="tx">
          <b>These report settings cannot be run.</b><small>{state.message}</small>
        </div></div>
      )}
      {state.status === 'error' && (
        <div className="al d" role="alert" data-state="error"><span className="i" /><div className="tx">
          <b>The report could not be run.</b>
          <small>{state.message}{state.correlationId ? ` Reference: ${state.correlationId}.` : ''}</small>
          <button type="button" className="btn btn-s btn-sm u-mt-6" onClick={onRetry}>Try again</button>
        </div></div>
      )}

      {r && (
        <div style={state.status === 'loading' ? { opacity: 0.55 } : undefined} data-state={state.status === 'ok' ? (r.page.total === 0 ? 'empty' : 'ok') : 'loading'}>
          <AppliedSummary r={r} />
          {r.meta.uom.provinceUnits?.some((p) => !p.approved) && (
            <div className="al w u-mb-8"><span className="i" /><div className="tx">
              Province reporting units marked “proposed” are defaults awaiting Land Department approval; rows in them are flagged.
            </div></div>
          )}
          <ResultTable r={r} caption={caption} />
          <div className="bar u-mt-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="note" htmlFor="rpt-psize">Rows per page</label>
            <select id="rpt-psize" className="sel" value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <span className="grow" />
            <span className="note">{countText(r)}</span>
          </div>
          <Pager page={r.page} onOffset={onOffset} />
          <UnitTotals r={r} />
          <FlagLegend r={r} />
          {r.meta.definitions.length > 0 && (
            <details className="u-mt-12">
              <summary className="note">How the figures are defined</summary>
              <ul className="note">{r.meta.definitions.map((d, i) => <li key={i}>{d}</li>)}</ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
