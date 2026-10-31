'use client';

// Person / CNIC statement: find a person by full CNIC or from the landowner
// register, then show what GET /api/reports/person returns — identity (masked
// unless the viewer holds pii:read; the server decides), parcels and shares
// with units, cases, payments, adjustments, reversals and the balance. The
// sections are rendered from the response itself, so no field list is
// hard-coded here.

import React, { useEffect, useState } from 'react';
import { ApiError } from '@/lib/client/api';
import { onForbidden } from '@/lib/client/permissions';
import { formatCNICInput } from '@/lib/domain';
import { RecordPicker } from '@/components/legacy/data';
import type { ColumnOut, RowOut } from '@/lib/reporting/types';
import { cellText, flagLong, flagShort, headerText, humanize, isNumeric, rowLabel, safeHref } from './format';

const CNIC = /^\d{5}-\d{7}-\d$/;
const DEC = /^-?\d+(\.\d+)?$/;
/** The order sections appear in when the response has them; anything else follows. */
const ORDER = ['identity', 'person', 'balances', 'balance', 'totals', 'parcels', 'shares', 'ownership', 'cases', 'allocations', 'payments', 'adjustments', 'reversals', 'otherPayments', 'statement', 'definitions'];
const SKIP = new Set(['identity', 'person', 'matches', 'piiMasked', 'flags', 'flagText', 'meta', 'generatedAt', 'correlationId']);
const TITLES: Record<string, string> = { definitions: 'How the figures are defined', otherPayments: 'Other payments (not compensation)', statement: 'Statement of account' };

type Json = Record<string, unknown>;
type Section = { title?: string; columns?: ColumnOut[]; rows?: (RowOut | Json)[] };

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const plain = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v));

function ObjectList({ o, label }: { o: Json; label: string }) {
  // Internal ids are not for reading.
  const entries = Object.entries(o).filter(([k, v]) => !isObj(v) && !Array.isArray(v) && !/(^id|Id|_id)$/.test(k));
  return (
    <div className="dl" aria-label={label}>
      {entries.map(([k, v]) => <div key={k}><small>{humanize(k)}</small><span className={DEC.test(String(v)) ? 'mono' : undefined}>{plain(v)}</span></div>)}
    </div>
  );
}

function RowsTable({ rows, label }: { rows: Json[]; label: string }) {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => !isObj(rows[0]?.[k]) && k !== 'href');
  return (
    <div className="tw" tabIndex={0} role="region" aria-label={label}>
      <table className="t">
        <caption className="sr-only">{label}</caption>
        <thead><tr>{keys.map((k) => <th key={k} scope="col">{humanize(k)}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{keys.map((k, j) => {
              const v = Array.isArray(r[k]) ? (r[k] as unknown[]).join(', ') : r[k];
              const text = plain(v);
              return <td key={k} className={DEC.test(String(v ?? '')) ? 'num' : undefined}>
                {j === 0 && safeHref(r.href) ? <a className="code" href={safeHref(r.href)!}>{text}</a> : text}
              </td>;
            })}</tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={Math.max(1, keys.length)} className="empty">None recorded.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/** A section in the engine's own shape (columns + rows), formatted like a report. */
function EngineTable({ s, label }: { s: Required<Pick<Section, 'columns' | 'rows'>>; label: string }) {
  return (
    <div className="tw" tabIndex={0} role="region" aria-label={label}>
      <table className="t">
        <caption className="sr-only">{label}</caption>
        <thead><tr>{s.columns.map((c) => <th key={c.key} scope="col" className={isNumeric(c.type) ? 'num' : undefined}>{headerText(c)}</th>)}</tr></thead>
        <tbody>
          {(s.rows as RowOut[]).map((x, i) => (
            <tr key={i} style={x.kind && x.kind !== 'detail' ? { fontWeight: 700, background: 'var(--surface-2)' } : undefined}>
              {s.columns.map((c, ci) => {
                const v = x.cells?.[c.key];
                const lbl = ci === 0 && x.kind && x.kind !== 'detail' && (v === null || v === undefined) ? rowLabel(x) : null;
                if (lbl) return <th key={c.key} scope="row" style={{ textAlign: 'left', fontWeight: 'inherit' }}>{lbl}</th>;
                return <td key={c.key} className={isNumeric(c.type) ? 'num' : undefined}>{cellText(c, v)}
                  {c.type === 'area' && !c.unit && x.unit && v != null ? <span className="note"> {x.unit}</span> : null}</td>;
              })}
            </tr>
          ))}
          {s.rows.length === 0 && <tr><td colSpan={s.columns.length} className="empty">None recorded.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function SectionView({ name, value }: { name: string; value: unknown }) {
  const s = isObj(value) ? value as Section : undefined;
  const title = s?.title ?? TITLES[name] ?? humanize(name);
  let body: React.ReactNode = null;
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string')) {
    body = <ul className="note">{(value as string[]).map((t, i) => <li key={i}>{t}</li>)}</ul>;
  } else if (Array.isArray(value)) body = <RowsTable rows={value.filter(isObj)} label={title} />;
  else if (s && Array.isArray(s.columns) && Array.isArray(s.rows)) body = <EngineTable s={{ columns: s.columns, rows: s.rows }} label={title} />;
  else if (s && Array.isArray(s.rows)) body = <RowsTable rows={(s.rows as Json[]).filter(isObj)} label={title} />;
  else if (isObj(value)) body = <ObjectList o={value} label={title} />;
  else return null;
  return <section className="u-mt-12" aria-label={title}><h4 className="sec-t">{title}</h4>{body}</section>;
}

type Query = { cnic: string } | { landowner: string };

export default function PersonStatement({ canReadLandowners }: { canReadLandowners: boolean }) {
  const [cnic, setCnic] = useState('');
  const [landowner, setLandowner] = useState('');
  const [query, setQuery] = useState<Query | null>(null);
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'ok' | 'error' | 'denied' | 'notfound'; data?: Json; message?: string }>({ status: 'idle' });
  const [hint, setHint] = useState('');

  useEffect(() => {
    if (!query) return;
    const ctl = new AbortController();
    setState({ status: 'loading' });
    const qs = new URLSearchParams(query as Record<string, string>).toString();
    fetch(`/api/reports/person?${qs}`, { headers: { Accept: 'application/json' }, signal: ctl.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new ApiError(res.status, body?.error || `The statement could not be loaded (${res.status}).`, body?.code);
        setState({ status: 'ok', data: body as Json });
      })
      .catch((e) => {
        if (e?.name === 'AbortError') return;
        const st = e instanceof ApiError ? e.status : 0;
        if (st === 403) { if (!(e as ApiError).code || (e as ApiError).code === 'forbidden') onForbidden(); setState({ status: 'denied', message: e.message }); }
        else if (st === 404) setState({ status: 'notfound', message: 'No person matches that search in your scope.' });
        else setState({ status: 'error', message: st ? e.message : 'The server could not be reached. Check your connection and try again.' });
      });
    return () => ctl.abort();
  }, [query]);

  const findByCnic = (e: React.FormEvent) => {
    e.preventDefault();
    let v = cnic.trim();
    if (/^\d{13}$/.test(v)) v = `${v.slice(0, 5)}-${v.slice(5, 12)}-${v.slice(12)}`;
    if (!CNIC.test(v)) { setHint('Enter the full CNIC as 12345-1234567-1.'); return; }
    setHint(''); setCnic(v); setQuery({ cnic: v });
  };

  const d = state.data;
  const identity = d && (isObj(d.identity) ? d.identity : isObj(d.person) ? d.person : undefined);
  const matches = d && Array.isArray(d.matches) ? (d.matches as Json[]) : [];
  const flags = d && Array.isArray(d.flags) ? (d.flags as string[]) : [];
  const flagText = d && isObj(d.flagText) ? d.flagText as Record<string, string> : undefined;
  const sections = d ? Object.keys(d).filter((k) => !SKIP.has(k))
    .sort((a, b) => (ORDER.indexOf(a) < 0 ? 99 : ORDER.indexOf(a)) - (ORDER.indexOf(b) < 0 ? 99 : ORDER.indexOf(b))) : [];

  return (
    <div>
      <div className="grid2">
        <form onSubmit={findByCnic} aria-label="Find by CNIC" noValidate>
          <div className="fg">
            <label htmlFor="psCnic">CNIC (full number)</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input id="psCnic" inputMode="numeric" autoComplete="off" placeholder="12345-1234567-1" maxLength={15} value={cnic}
                aria-describedby={hint ? 'psCnicHint' : undefined} aria-invalid={!!hint} onChange={(e) => setCnic(formatCNICInput(e.target.value))} />
              <button type="submit" className="btn btn-p btn-sm">Show statement</button>
            </div>
            {hint && <small id="psCnicHint" className="u-danger" role="alert">{hint}</small>}
          </div>
        </form>
        {canReadLandowners && (
          <div className="fg">
            <label htmlFor="psLo">Or choose a landowner</label>
            <RecordPicker id="psLo" resource="/api/landowners" rowsKey="landowners" label="Landowner" value={landowner}
              idOf={(l) => l.id} allowDeceased optionLabel={(l) => `${l.full_name ?? ''}${l.father_name ? ` s/o ${l.father_name}` : ''}${l.cnic ? ` (${l.cnic})` : ''}`}
              onChange={(id) => { setLandowner(id); if (id) setQuery({ landowner: id }); }} />
          </div>
        )}
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {state.status === 'loading' ? 'Loading statement…' : state.status === 'ok' ? 'Statement loaded.' : state.message ?? ''}
      </p>
      {state.status === 'idle' && <div className="empty">Search by CNIC or choose a landowner to see their statement.</div>}
      {state.status === 'loading' && <div className="empty">Loading statement…</div>}
      {state.status === 'notfound' && <div className="empty">{state.message}</div>}
      {state.status === 'denied' && <div className="al d" role="alert"><span className="i" /><div className="tx"><b>You do not have access to person statements.</b><small>{state.message}</small></div></div>}
      {state.status === 'error' && (
        <div className="al d" role="alert"><span className="i" /><div className="tx"><b>The statement could not be loaded.</b><small>{state.message}</small>
          <button type="button" className="btn btn-s btn-sm u-mt-6" onClick={() => setQuery((q) => (q ? { ...q } : q))}>Try again</button></div></div>
      )}

      {state.status === 'ok' && d && (
        <div data-state="ok">
          {matches.length > 1 && (
            <section aria-label="Matching persons">
              <h4 className="sec-t">{matches.length} persons match — choose one</h4>
              <ul className="u-list">
                {matches.map((m, i) => (
                  <li key={String(m.id ?? i)}>
                    <button type="button" className="as-link" onClick={() => typeof m.id === 'string' && setQuery({ landowner: m.id })}>
                      {plain(m.full_name ?? m.name)}{m.cnic ? ` (${plain(m.cnic)})` : ''}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {identity && (
            <section aria-label="Identity">
              <h4 className="sec-t">Identity</h4>
              <ObjectList o={identity} label="Identity" />
              {d.piiMasked === true && <p className="note">CNIC and contact details are masked: you do not hold permission to see personal data in full.</p>}
            </section>
          )}
          {flags.length > 0 && (
            <div className="u-mb-8" aria-label="Flags">
              {flags.map((k) => <span key={k} className="b b-w" title={flagLong(k, flagText)} style={{ marginRight: 4 }}>{flagShort(k)}</span>)}
            </div>
          )}
          {sections.map((k) => <SectionView key={k} name={k} value={d[k]} />)}
        </div>
      )}
    </div>
  );
}
