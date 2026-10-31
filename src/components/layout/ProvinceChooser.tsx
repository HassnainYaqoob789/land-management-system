'use client';

// "Select province" screen from legacy-demo/province (.screen > .prov-wrap),
// with the counts read from api.v_province_summary instead of demo data.
// It is a modal dialog (UX-09): focus moves to its heading when it opens, Tab
// stays inside it, the shell behind it is inert, Escape cancels when there is
// something to go back to, and focus returns to whatever opened it.

import React, { useEffect, useRef, useState } from 'react';
import { PROVINCES } from './nav';
import { useModalLayer } from '@/components/legacy/a11y';

interface Summary { province_code: string; projects: number; parcels: number; landowners: number; active_leases: number }

export default function ProvinceChooser({ allowed, userName, roleName, onChoose, onClose }: {
  allowed: string[]; userName: string; roleName: string; onChoose: (p: string) => void; onClose?: () => void;
}) {
  const [stats, setStats] = useState<Record<string, Summary>>({});
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    fetch('/api/provinces').then((r) => r.ok ? r.json() : { provinces: [] })
      .then((d) => setStats(Object.fromEntries((d.provinces || []).map((s: Summary) => [s.province_code, s]))))
      .catch(() => { /* cards still work without counts */ });
  }, []);
  // Escape cancels only when the user already has a province to go back to.
  useModalLayer(ref, true, onClose, (root) => root.querySelector<HTMLElement>('#provTitle'));

  const codes = Object.keys(PROVINCES).filter((c) => allowed.includes(c));
  const all = Object.keys(PROVINCES).every((c) => allowed.includes(c));

  return (
    <div className="screen" role="dialog" aria-modal="true" aria-labelledby="provTitle" aria-describedby="provHint" ref={ref}>
      <div className="prov-wrap">
        <h2 id="provTitle" tabIndex={-1}>Select province</h2>
        <p id="provHint">Welcome, {userName}{roleName ? ` — ${roleName}` : ''}. Choose the province to work in; you can change it later from the header.</p>
        <div className="prov-grid">
          {codes.map((c) => {
            const p = PROVINCES[c]; const s = stats[c];
            return (
              <a key={c} href="/dashboard" className="prov-card" style={{ background: p.grad }} onClick={(e) => { e.preventDefault(); onChoose(c); }}>
                <h3>{p.name}</h3>
                <div className="meta">{[...p.levels].reverse().join(' → ')}<br />Revenue unit: {p.rev} · Units: {p.units.join(', ')}</div>
                <div className="stats">
                  <span><b>{s?.projects != null && Number.isFinite(Number(s.projects)) ? Number(s.projects) : '—'}</b>Projects</span>
                  <span><b>{s?.parcels != null && Number.isFinite(Number(s.parcels)) ? Number(s.parcels) : '—'}</b>Surveys</span>
                  <span><b>{s?.landowners != null && Number.isFinite(Number(s.landowners)) ? Number(s.landowners) : '—'}</b>Landowners</span>
                  <span><b>{s?.active_leases != null && Number.isFinite(Number(s.active_leases)) ? Number(s.active_leases) : '—'}</b>Leases</span>
                </div>
              </a>
            );
          })}
        </div>
        {all && <a href="/dashboard" className="prov-all" onClick={(e) => { e.preventDefault(); onChoose('ALL'); }}>All provinces — Head Office consolidated view</a>}
        <p className="u-mt-16 u-fs-12">
          {onClose
            ? <button type="button" className="u-link-on-dark" onClick={onClose}>Cancel</button>
            : <a className="u-link-on-dark" href="/login" onClick={async (e) => { e.preventDefault(); await fetch('/api/auth/logout', { method: 'POST' }); location.href = '/login'; }}>Sign out</a>}
        </p>
      </div>
    </div>
  );
}
