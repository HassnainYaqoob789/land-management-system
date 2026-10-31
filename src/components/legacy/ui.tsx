'use client';

// React versions of the markup the legacy design system renders
// (legacy-demo/assets/js: kpi(), stageBadge(), renderList(), the modal and
// form skeletons, and the ICONS line-icon set). Class names are the
// reference's; styling lives in src/styles/legacy.

import React, { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useModalLayer } from './a11y';

// ---- icons (legacy-demo/assets/js/ui/extras.js ICONS) ----------------------
const ICONS: Record<string, string> = {
  dash: '<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  bank: '<path d="M3 22h18M6 18v-7M10 18v-7M14 18v-7M18 18v-7M12 2l9 5H3z"/>',
  rig: '<path d="M12 2v5M8 7h8l3 15H5z"/><path d="M7 14h10M9.5 7l5 7M14.5 7l-5 7"/>',
  map: '<path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15M15 6v15"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  clip: '<rect x="5" y="4" width="14" height="18" rx="2"/><path d="M9 4V2h6v2M9 11h6M9 15h6"/>',
  doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  scale: '<path d="M12 3v18M5 21h14M3 7h18M6 7l-3 7a3 3 0 0 0 6 0zM18 7l-3 7a3 3 0 0 0 6 0z"/>',
  route: '<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/>',
  warn: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  repeat: '<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  wallet: '<rect x="2" y="6" width="20" height="14" rx="2"/><path d="M2 10h20M16 15h2"/>',
  bldg: '<rect x="4" y="2" width="16" height="20" rx="1"/><path d="M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
  calc: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  down: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  up: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  receipt: '<path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 3 2V2l-3 2-3-2-3 2-3-2-3 2z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  layers: '<path d="M12 2l10 5-10 5L2 7z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  print: '<path d="M6 9V2h12v7"/><rect x="6" y="14" width="12" height="8"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>',
  swap: '<path d="M16 3l4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
  attach: '<path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/>',
  ruler: '<path d="M21.3 8.7L8.7 21.3a1 1 0 0 1-1.4 0l-4.6-4.6a1 1 0 0 1 0-1.4L15.3 2.7a1 1 0 0 1 1.4 0l4.6 4.6a1 1 0 0 1 0 1.4z"/><path d="M7.5 10.5l2 2M10.5 7.5l2 2M13.5 4.5l2 2"/>',
  poly: '<path d="M12 2l10 7-4 13H6L2 9z"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  pkg: '<path d="M21 16V8l-9-5-9 5v8l9 5z"/><path d="M3.3 7L12 12l8.7-5M12 22V12"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  mega: '<path d="M3 11l18-5v12L3 14z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  compass: '<circle cx="12" cy="12" r="10"/><path d="M16.2 7.8l-2.1 6.3-6.3 2.1 2.1-6.3z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  cbox: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 12l2 2 4-4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>',
};

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  const d = ICONS[name];
  if (!d) return null;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} stroke="currentColor" fill="none" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}
      dangerouslySetInnerHTML={{ __html: d }} />
  );
}

// ---- status pills (engine.js stageBadge) -----------------------------------
const TONE: Record<string, string> = {
  'HO Approved': 'g', Approved: 'g', Released: 'g', Handover: 'g', Resolved: 'g', Closed: 'g', 'Rate Fixed': 'g',
  Active: 'g', Acquired: 'g', Paid: 'g', Verified: 'i', Current: 'g', Completed: 'g', Operational: 'g',
  Cancelled: 'd', Stopped: 'd', Escalated: 'd', Expired: 'd', Critical: 'd', High: 'd', Disputed: 'd', Rejected: 'd',
  'On Hold': 'd', Hold: 'd', Deceased: 'd', Terminated: 'd', Overdue: 'd',
  Prepared: 'n', Draft: 'n', Requested: 'n', Registered: 'n', Reported: 'n', Estimated: 'n', Identification: 'n',
  Proposed: 'n', Submitted: 'n', Inactive: 'n', Planned: 'n',
  Expiring: 'w', Medium: 'w', 'Under Acquisition': 'w', 'Due for Renewal': 'w', Pending: 'w', Returned: 'w',
  Leased: 'p', Low: 'i',
};

export type Tone = 'g' | 'w' | 'd' | 'i' | 'n' | 'p';

export function toneOf(stage?: string | null): Tone {
  return (TONE[String(stage ?? '')] as Tone) || 'i';
}

export function Badge({ tone, children, title }: { tone?: Tone; children: React.ReactNode; title?: string }) {
  return <span className={`b b-${tone ?? toneOf(String(children))}`} title={title}>{children}</span>;
}

/** A workflow stage or status, coloured as the reference colours it. */
export function Stage({ value }: { value?: string | null }) {
  return <span className={`b b-${toneOf(value)}`}>{value || '—'}</span>;
}

// ---- cards & KPIs ----------------------------------------------------------
export function Card({ title, sub, icon, actions, children, className = '', id }: {
  title?: React.ReactNode; sub?: React.ReactNode; icon?: string; actions?: React.ReactNode;
  children?: React.ReactNode; className?: string; id?: string;
}) {
  return (
    <section className={`card ${className}`} id={id}>
      {(title || actions) && (
        <div className="card-h">
          <div>
            {title && <h3>{icon && <span className="ico"><Icon name={icon} size={17} /></span>} {title}</h3>}
            {sub && <p>{sub}</p>}
          </div>
          {actions && <div className="bar u-m-0">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Kpi({ label, value, sub, tone = '', href }: {
  label: React.ReactNode; value: React.ReactNode; sub?: React.ReactNode; tone?: '' | 'g' | 'w' | 'd'; href?: string;
}) {
  const body = (<><div className="l">{label}</div><div className="v">{value}</div>{sub !== undefined && <div className="s">{sub}</div>}</>);
  return href
    ? <Link className={`kpi ${tone}`} href={href}>{body}</Link>
    : <div className={`kpi ${tone}`}>{body}</div>;
}

// ---- list toolbar & table --------------------------------------------------
export function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className="bar">{children}</div>;
}

export function SearchBox({ value, onChange, placeholder, label }: {
  value: string; onChange: (v: string) => void; placeholder: string; label?: string;
}) {
  return <input className="search" type="search" placeholder={placeholder} aria-label={label ?? placeholder}
    value={value} onChange={(e) => onChange(e.target.value)} />;
}

export function Select({ value, onChange, options, label, all }: {
  value: string; onChange: (v: string) => void; options: (string | [string, string])[]; label: string; all?: string;
}) {
  return (
    <select className="sel" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {all !== undefined && <option value="">{all}</option>}
      {options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return <option key={v} value={v}>{l}</option>; })}
    </select>
  );
}

export function Count({ n }: { n: number }) {
  return <><span className="grow" /><span className="note">{n.toLocaleString()} record(s)</span></>;
}

/** The reference pager strip (legacy-demo screens.js): "Showing a–b of n  ‹ Prev  Page x / y  Next ›". */
export function Pager({ page, onOffset }: { page?: { limit: number; offset: number; total: number }; onOffset: (offset: number) => void }) {
  if (!page || page.total <= page.limit) return null;
  const pages = Math.ceil(page.total / page.limit), at = Math.floor(page.offset / page.limit);
  return (
    <nav className="bar u-pager" aria-label="Pages">
      <span className="note">Showing {(page.offset + 1).toLocaleString()}–{Math.min(page.total, page.offset + page.limit).toLocaleString()} of {page.total.toLocaleString()}</span>
      <button type="button" className="btn btn-s btn-sm" disabled={at === 0} onClick={() => onOffset(Math.max(0, page.offset - page.limit))}>‹ Prev</button>
      <span className="note">Page {(at + 1).toLocaleString()} / {pages.toLocaleString()}</span>
      <button type="button" className="btn btn-s btn-sm" disabled={at >= pages - 1} onClick={() => onOffset(page.offset + page.limit)}>Next ›</button>
    </nav>
  );
}

export function Table({ head, children, empty, colSpan, foot, caption }: {
  head: React.ReactNode; children?: React.ReactNode; empty?: React.ReactNode | false; colSpan?: number;
  foot?: React.ReactNode; caption?: string;
}) {
  return (
    // Focusable so keyboard users can scroll a wide table (WCAG 2.1.1).
    <div className="tw" tabIndex={0} role="region" aria-label={caption ?? 'Table'}>
      <table className="t">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead><tr>{head}</tr></thead>
        <tbody>
          {children}
          {empty && <tr><td colSpan={colSpan} className="empty">{empty}</td></tr>}
        </tbody>
        {foot && <tfoot>{foot}</tfoot>}
      </table>
    </div>
  );
}

export function Loading({ what = 'records' }: { what?: string }) {
  return <div className="empty" role="status">Loading {what}…</div>;
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return <div className="al d" role="alert"><span className="i" /><div className="tx">{children}</div></div>;
}

// ---- modal (the legacy .mb > .modal skeleton) ------------------------------
/**
 * A dialog. Rendered as a child of <body> so the rest of the page can be made
 * inert while it is open; focus moves to its first form control once, when it
 * opens (never on a re-render, UX-01), Tab stays inside it, Escape closes only
 * the top-most dialog, and focus returns to the opener on close (UX-07).
 * The accessible name is the visible title (aria-labelledby), or `label` when
 * the title is not plain text.
 */
export function Modal({ open, title, onClose, children, footer, size = '', icon, stacked, label }: {
  open: boolean; title: React.ReactNode; onClose: () => void; children: React.ReactNode;
  footer?: React.ReactNode; size?: '' | 'sm' | 'lg'; icon?: string; stacked?: boolean; label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useModalLayer(ref, open, onClose,
    (root) => root.querySelector<HTMLElement>('.mbody input:not([disabled]):not([type="hidden"]), .mbody select:not([disabled]), .mbody textarea:not([disabled])'));
  if (!open) return null;
  const dialog = (
    <div className={`mb${stacked ? ' top2' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${size}`} role="dialog" aria-modal="true" ref={ref} tabIndex={-1}
        aria-labelledby={label ? undefined : titleId} aria-label={label}>
        <div className="mh">
          <h3 id={titleId}>{icon && <span className="ico"><Icon name={icon} size={15} /></span>} {title}</h3>
          <button type="button" className="x" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <div className="mbody">{children}</div>
        {footer && <div className="mf">{footer}</div>}
      </div>
    </div>
  );
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}

// ---- form group (.fg) ------------------------------------------------------
export function Field({ label, required, hint, full, children, htmlFor }: {
  label: React.ReactNode; required?: boolean; hint?: React.ReactNode; full?: boolean; children: React.ReactNode; htmlFor?: string;
}) {
  return (
    <div className={`fg${full ? ' full' : ''}`}>
      <label htmlFor={htmlFor}>{label}{required && <span className="req"> *</span>}</label>
      {children}
      {hint && <small>{hint}</small>}
    </div>
  );
}

// ---- workflow strip (.wf .st) ----------------------------------------------
export function WorkflowStrip({ stages, current, stopped }: { stages: string[]; current?: string | null; stopped?: boolean }) {
  const at = stages.indexOf(String(current ?? ''));
  return (
    <div className="wf" aria-label="Workflow stage">
      {stages.map((s, i) => (
        <div key={s} className={`st${stopped && i === at ? ' x' : i < at ? ' done' : i === at ? ' cur' : ''}`}
          aria-current={i === at ? 'step' : undefined}>{s}</div>
      ))}
    </div>
  );
}

// ---- tabs ------------------------------------------------------------------
/**
 * The ARIA tabs pattern (UX-14): one tab stop (roving tabindex), Left/Right
 * (and Home/End) move between tabs and select them, and each tab names the
 * panel it controls. Wrap the content in <TabPanel> with the same `id` and
 * value to link them; without it the tabs still work, just unlinked.
 */
export function Tabs<T extends string>({ tabs, value, onChange, label, id }: {
  tabs: [T, React.ReactNode][]; value: T; onChange: (t: T) => void; label: string; id?: string;
}) {
  const base = id;   // panels are linked only when the caller renders <TabPanel id={id}>
  const listRef = useRef<HTMLDivElement>(null);
  const onKey = (e: React.KeyboardEvent) => {
    const at = tabs.findIndex(([k]) => k === value);
    const go = (i: number) => {
      e.preventDefault();
      const n = (i + tabs.length) % tabs.length;
      onChange(tabs[n][0]);
      listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[n]?.focus();
    };
    if (e.key === 'ArrowRight') go(at + 1);
    else if (e.key === 'ArrowLeft') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(tabs.length - 1);
  };
  return (
    <div className="tabs" role="tablist" aria-label={label} ref={listRef} onKeyDown={onKey}>
      {tabs.map(([k, l]) => (
        <button key={k} type="button" role="tab" id={base ? `${base}-tab-${k}` : undefined}
          aria-controls={base ? `${base}-panel-${k}` : undefined}
          aria-selected={value === k} tabIndex={value === k ? 0 : -1}
          className={`tab${value === k ? ' active' : ''}`} onClick={() => onChange(k)}>{l}</button>
      ))}
    </div>
  );
}

/** The panel for the selected tab of <Tabs id={id}>. */
export function TabPanel({ id, value, children }: { id: string; value: string; children: React.ReactNode }) {
  return <div role="tabpanel" id={`${id}-panel-${value}`} aria-labelledby={`${id}-tab-${value}`} tabIndex={0}>{children}</div>;
}

// ---- formatting the reference uses ----------------------------------------
export const fmtNum = (v: unknown, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-PK', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
};
export const fmtRs = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? 'Rs ' + n.toLocaleString('en-PK', { maximumFractionDigits: 0 }) : '—';
};
export const fmtRsM = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? `Rs ${(n / 1e6).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} M` : '—';
};
export const fmtDate = (v: unknown) => {
  if (!v) return '—';
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
