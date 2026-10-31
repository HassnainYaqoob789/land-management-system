'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Shell, { useLMS } from '@/components/layout/Shell';
import { Card, Modal, Field, Table, Toolbar, SearchBox, Select, Count, Loading, ErrorNote } from '@/components/legacy/ui';
import { send, useApi } from '@/lib/client/api';

export default function UnitsPage() {
  return (
    <Shell>
      <UnitsContent />
    </Shell>
  );
}

const PROVINCES: [string, string][] = [['SND', 'Sindh'], ['BAL', 'Balochistan'], ['PNJ', 'Punjab'], ['KPK', 'KPK']];
const NUM_RE = /^\d{1,12}(\.\d{1,6})?$/;
const EMPTY_UNIT = { province_code: 'SND', level: 0, parent_id: '', name: '' };

/** A decimal string from the server, shown with grouping and trailing zeros trimmed (no float arithmetic). */
function showDecimal(s: unknown): string {
  if (s === null || s === undefined || s === '') return '—';
  const str = String(s);
  if (!/^-?\d+(\.\d+)?$/.test(str)) return str;
  const [i, f = ''] = str.split('.');
  const frac = f.replace(/0+$/, '');
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? `.${frac}` : ''}`;
}

function UnitsContent() {
  const { activeProvince } = useLMS();
  const ref = useApi<any>('/api/units');
  const units: any[] = useMemo(() => ref.data?.units ?? [], [ref.data]);
  const adminUnits: any[] = ref.data?.admin_units ?? [];
  const provinceLevels: any[] = ref.data?.province_levels ?? [];
  const provinceUnits: any[] = ref.data?.province_units ?? [];
  const canManage = !!ref.data?.can?.manageUnits;
  const [provFilter, setProvFilter] = useState('');
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Converter: exact, server-side, from lms.unit_conversion (provisional factors are marked).
  const [convVal, setConvVal] = useState('');
  const [convUnit, setConvUnit] = useState('Acre');
  const [conv, setConv] = useState<{ asked: string; converted_value: string | null; provisional: boolean }[] | null>(null);
  const [convError, setConvError] = useState<string | null>(null);
  const areaUnits = useMemo(() => units.filter((u: any) => u.is_area), [units]);

  useEffect(() => {
    setConvError(null);
    if (!convVal.trim()) { setConv(null); return; }
    if (!NUM_RE.test(convVal.trim())) { setConv(null); setConvError('Enter a number (up to 6 decimal places).'); return; }
    const targets = areaUnits.filter((u: any) => u.code !== convUnit && u.has_factor).map((u: any) => u.code);
    if (!targets.length) return;
    // Plain fetch, not send(): a conversion changes nothing, so no cached data should be invalidated.
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetch('/api/units', { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: convVal.trim(), from_unit: convUnit, to_units: targets }) })
        .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `Could not convert (${r.status}).`); return d; })
        .then((d) => setConv(d.conversions ?? []))
        .catch((e: any) => { if (e?.name !== 'AbortError') { setConv(null); setConvError(e?.message || 'Could not convert.'); } });
    }, 250);
    return () => { ctl.abort(); clearTimeout(t); };
  }, [convVal, convUnit, areaUnits]);

  const [isNewModalOpen, setIsNewModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newAdmin, setNewAdmin] = useState(EMPTY_UNIT);

  const handleCreateAdminUnit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await send('POST', '/api/units', {
        action: 'create_admin_unit', province_code: newAdmin.province_code, level: Number(newAdmin.level),
        parent_id: Number(newAdmin.level) > 0 ? newAdmin.parent_id || null : null, name: newAdmin.name,
      });
      setError(null);
      setIsNewModalOpen(false);
      setNewAdmin(EMPTY_UNIT);
      ref.reload?.();
    } catch (err: any) {
      setError(err?.message || 'Could not create the administrative unit.');
    } finally {
      setSaving(false);
    }
  };

  const effProv = provFilter || (activeProvince !== 'ALL' ? activeProvince : '');
  const shownAdmin = adminUnits.filter((u) => {
    if (effProv && u.province_code !== effProv) return false;
    if (q && ![u.name, u.full_path, u.level_name, u.province_code].join(' ').toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  const levelsForProv = provinceLevels.filter((l) => l.province_code === newAdmin.province_code);
  const parentsForLevel = adminUnits.filter((u) => u.province_code === newAdmin.province_code && Number(u.level) === Number(newAdmin.level) - 1);
  const where = (code: string) => provinceUnits.filter((p: any) => p.unit_code === code);

  return (
    <>
      <div className="grid2">
        <Card icon="ruler" title="Area converter" sub="Converted by the database with the factors in lms.unit_conversion; provisional factors are marked">
          <div className="fgrid">
            <Field label="Value" htmlFor="cvVal">
              <input id="cvVal" inputMode="decimal" value={convVal} onChange={(e) => setConvVal(e.target.value)} aria-describedby={convError ? 'cvErr' : undefined} />
            </Field>
            <Field label="From unit" htmlFor="cvUnit">
              <select id="cvUnit" value={convUnit} onChange={(e) => setConvUnit(e.target.value)}>
                {areaUnits.map((u: any) => <option key={u.code} value={u.code}>{u.name}{u.is_confirmed ? '' : ' (provisional)'}</option>)}
              </select>
            </Field>
          </div>
          {convError && <div id="cvErr" role="alert"><ErrorNote>{convError}</ErrorNote></div>}
          {conv && (
            <div className="totals u-mt-12" aria-live="polite">
              {conv.map((c) => {
                const u = areaUnits.find((x: any) => x.code === c.asked);
                return (
                  <div key={c.asked}>
                    <small>{u?.name ?? c.asked}</small>
                    <b>{c.converted_value === null ? 'no factor' : showDecimal(c.converted_value)}</b>
                    {c.provisional && <span className="b b-w" title="Uses a factor awaiting Land Department confirmation">provisional</span>}
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card icon="calc" title="Unit reference" sub="The factor in force for each unit (lms.unit_conversion) and the provinces that use it (lms.province_unit)">
          {ref.loading && !units.length ? <Loading what="units" /> : (
            <Table
              caption="Measurement units"
              head={<><th>Unit</th><th className="num">Square metres</th><th className="num">Per acre</th><th>Factor</th><th>Applies in</th><th>Source</th></>}
              empty={units.length ? false : ref.error ? String(ref.error) : 'No units loaded.'}
              colSpan={6}
            >
              {areaUnits.map((u: any) => {
                const provs = where(u.code);
                return (
                  <tr key={u.code}>
                    <td><b>{u.name}</b>{u.note && <><br /><small className="note">{u.note}</small></>}</td>
                    <td className="num">{u.has_factor ? showDecimal(u.sqm_per_unit) : <span className="b b-d">no factor</span>}</td>
                    <td className="num">{u.has_factor ? showDecimal(u.units_per_acre) : '—'}</td>
                    <td>{!u.has_factor ? '—' : u.is_confirmed ? <span className="b b-g">confirmed</span> : <span className="b b-w">provisional</span>}</td>
                    <td>
                      {provs.length ? provs.map((p: any) => p.province_code).join(', ') : '—'}
                      {provs.some((p: any) => !p.confirmed) && <><br /><small className="note">awaiting Land Department confirmation</small></>}
                    </td>
                    <td className="mono u-fs-11">{u.source_ref || '—'}</td>
                  </tr>
                );
              })}
            </Table>
          )}
        </Card>
      </div>

      <Card icon="layers" title="Administrative Hierarchy Master (District → Taluka/Tehsil → Deh/Mouza)"
        sub="Provincial revenue hierarchy used for cadastral parcel registration">
        {error && <ErrorNote>{error}</ErrorNote>}
        {canManage && (
          <div className="bar">
            <button className="btn btn-p" onClick={() => { setError(null); setIsNewModalOpen(true); }}>+ Add Administrative Unit</button>
          </div>
        )}
        <Toolbar>
          <SearchBox value={q} onChange={setQ} placeholder="Search district, taluka, tehsil, deh or mouza…" />
          <Select label="Province" value={provFilter} onChange={setProvFilter} all="All provinces" options={PROVINCES} />
          <Count n={shownAdmin.length} />
        </Toolbar>
        {ref.loading && !adminUnits.length ? (
          <Loading what="administrative hierarchy" />
        ) : (
          <Table
            caption="Administrative hierarchy"
            head={<><th>Prov.</th><th>Level</th><th>Name</th><th>Full Revenue Hierarchy Path</th></>}
            empty={shownAdmin.length ? false : 'No administrative units match the filter.'}
            colSpan={4}
          >
            {shownAdmin.map((u: any) => (
              <tr key={u.id || u.admin_unit_id}>
                <td><span className="pill">{u.province_code}</span></td>
                <td><span className="b b-n">L{u.level} · {u.level_name}</span></td>
                <td><b>{u.name}</b></td>
                <td>{u.full_path || u.path || u.name}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {canManage && (
        <Modal
          open={isNewModalOpen}
          size="sm"
          icon="layers"
          title="Add Administrative Unit"
          onClose={() => setIsNewModalOpen(false)}
          footer={
            <>
              <button type="button" className="btn btn-s" onClick={() => setIsNewModalOpen(false)}>Cancel</button>
              <button type="submit" form="adminUnitForm" className="btn btn-p" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            </>
          }
        >
          <form id="adminUnitForm" onSubmit={handleCreateAdminUnit} className="fgrid">
            <Field label="Province" required htmlFor="auProv">
              <select id="auProv" value={newAdmin.province_code}
                onChange={(e) => setNewAdmin({ ...newAdmin, province_code: e.target.value, level: 0, parent_id: '' })}>
                {PROVINCES.map(([c, n]) => <option key={c} value={c}>{n} ({c})</option>)}
              </select>
            </Field>
            <Field label="Hierarchy level" required htmlFor="auLvl">
              <select id="auLvl" value={newAdmin.level} onChange={(e) => setNewAdmin({ ...newAdmin, level: Number(e.target.value), parent_id: '' })}>
                {levelsForProv.map((l: any) => <option key={l.depth} value={l.depth}>Level {l.depth} — {l.name}</option>)}
              </select>
            </Field>
            {Number(newAdmin.level) > 0 && (
              <Field label="Parent unit" required full htmlFor="auParent">
                <select id="auParent" required value={newAdmin.parent_id} onChange={(e) => setNewAdmin({ ...newAdmin, parent_id: e.target.value })}>
                  <option value="">— Select parent —</option>
                  {parentsForLevel.map((p: any) => <option key={p.id} value={p.id}>{p.full_path || p.name}</option>)}
                </select>
              </Field>
            )}
            <Field label="Unit name" required full htmlFor="auName">
              <input id="auName" type="text" required maxLength={120} placeholder="e.g. Deh Mari / Mouza Sui"
                value={newAdmin.name} onChange={(e) => setNewAdmin({ ...newAdmin, name: e.target.value })} />
            </Field>
          </form>
        </Modal>
      )}
    </>
  );
}
