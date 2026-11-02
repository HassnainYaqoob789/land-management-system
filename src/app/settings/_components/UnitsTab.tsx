'use client';

import React, { useState } from 'react';
import { Card, ErrorNote, Field, Loading, Modal, Table, fmtDate } from '@/components/legacy/ui';
import { LoadError } from '@/components/auth/PageGuard';
import { send, useApi } from '@/lib/client/api';
import { PROVINCES } from '@/components/layout/nav';
import { Done, messageOf } from './shared';

// Land units per province (client requirement, 2 Nov 2026): which units each
// province's forms offer first, and the size of each local unit in that
// province. The national factor (lms.unit_conversion) applies unless a
// province sets its own; a new size applies to parcels recorded from then on,
// and a recorded parcel keeps the size it was recorded with.
const FIXED = ['Acre', 'Hectare', 'Square Meter', 'Square Feet', 'Square Yard'];
const PROVINCE_CODES = ['SND', 'BAL', 'PNJ', 'KPK'];

export default function UnitsTab({ canUpdate }: { canUpdate: boolean }) {
  const d = useApi<any>('/api/units');
  const [prov, setProv] = useState('SND');
  const [done, setDone] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ unit: string; perAcre: string; confirmed: boolean; note: string; hasOwn: boolean } | null>(null);
  const [list, setList] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (d.error && !d.data) return <LoadError error={d.error} status={d.status} code={d.code} what="land units" />;
  if (!d.data) return <Loading what="land units" />;

  const units: any[] = (d.data.units ?? []).filter((u: any) => u.is_area && u.has_factor);
  const provinceUnits: any[] = (d.data.province_units ?? []).filter((p: any) => p.province_code === prov);
  const own: any[] = (d.data.province_factors ?? []).filter((f: any) => f.province_code === prov);
  const inList = provinceUnits.map((p) => p.unit_code);
  const ownOf = (code: string) => own.find((f) => f.unit_code === code);
  const local = units.filter((u) => !FIXED.includes(u.code));

  const run = async (fn: () => Promise<unknown>, message: string, after: () => void) => {
    setBusy(true);
    try { await fn(); setError(null); setDone(message); after(); d.reload(); }
    catch (e) { setError(messageOf(e)); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="tabs u-mb-10" role="tablist" aria-label="Province">
        {PROVINCE_CODES.map((p) => (
          <button key={p} type="button" role="tab" aria-selected={prov === p} className={`tab${prov === p ? ' active' : ''}`}
            onClick={() => { setProv(p); setDone(null); setError(null); }}>{PROVINCES[p]?.name ?? p}</button>
        ))}
      </div>
      <Done>{done}</Done>
      {error && !edit && !list && <ErrorNote>{error}</ErrorNote>}
      <div className="grid2">
        <Card icon="layers" title={`Units used in ${PROVINCES[prov]?.name ?? prov}`}
          sub="Forms in this province offer these units first, in this order; all other units stay available under “Other units”."
          actions={canUpdate ? <button type="button" className="btn btn-s btn-sm" onClick={() => { setError(null); setList(inList.length ? inList : ['Acre']); }}>Change list…</button> : undefined}>
          <Table caption={`Units used in ${prov}`} colSpan={3} empty={provinceUnits.length ? false : 'No units listed for this province.'}
            head={<><th className="num">#</th><th>Unit</th><th>Status</th></>}>
            {provinceUnits.map((p) => (
              <tr key={p.unit_code}><td className="num">{p.display_order}</td><td><b>{p.unit_code}</b></td>
                <td>{p.confirmed ? <span className="b b-g">Confirmed</span> : <span className="b b-w">Awaiting confirmation</span>}</td></tr>
            ))}
          </Table>
        </Card>

        <Card icon="calc" title={`Unit sizes in ${PROVINCES[prov]?.name ?? prov}`}
          sub="How many of each local unit make one acre. Acre, hectare and square measures are fixed.">
          <Table caption={`Unit sizes in ${prov}`} colSpan={4} empty={local.length ? false : 'No local units.'}
            head={<><th>Unit</th><th className="num">National (per acre)</th><th className="num">{prov} (per acre)</th><th><span className="sr-only">Actions</span></th></>}>
            {local.map((u) => {
              const o = ownOf(u.code);
              const national = Number(u.units_per_acre);
              return (
                <tr key={u.code}>
                  <td><b>{u.code}</b>{inList.includes(u.code) && <small className="note"> · used here</small>}</td>
                  <td className="num">{round(national)}{!u.is_confirmed && <><br /><small className="note">provisional</small></>}</td>
                  <td className="num">{o ? <><b>{round(Number(o.units_per_acre))}</b><br /><small className="note">{o.is_confirmed ? 'confirmed' : 'not confirmed'} · since {fmtDate(o.valid_from)}</small></>
                    : <span className="note">national size</span>}</td>
                  <td>{canUpdate && <button type="button" className="btn btn-s btn-sm" aria-label={`Set the size of ${u.code} in ${prov}`}
                    onClick={() => { setError(null); setEdit({ unit: u.code, perAcre: String(round(o ? Number(o.units_per_acre) : national)), confirmed: o ? !!o.is_confirmed : false, note: o?.note ?? '', hasOwn: !!o }); }}>Set size…</button>}</td>
                </tr>
              );
            })}
          </Table>
          <p className="note u-mt-6">A new size applies to parcels recorded from today. A parcel already recorded keeps the size it was recorded with, so its area does not change silently.</p>
        </Card>
      </div>

      <Modal open={!!edit} size="sm" icon="calc" title={edit ? `${edit.unit} in ${PROVINCES[prov]?.name ?? prov}` : ''} onClose={() => setEdit(null)}
        footer={<>
          {edit?.hasOwn && <button type="button" className="btn btn-w u-mr-auto" disabled={busy}
            onClick={() => edit && run(() => send('POST', '/api/units', { action: 'clear_province_factor', province_code: prov, unit_code: edit.unit }),
              `${edit.unit} in ${prov} is back on the national size.`, () => setEdit(null))}>Use the national size</button>}
          <button type="button" className="btn btn-s" onClick={() => setEdit(null)}>Cancel</button>
          <button type="submit" form="unitForm" className="btn btn-p" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </>}>
        {edit && (
          <form id="unitForm" onSubmit={(e) => {
            e.preventDefault();
            run(() => send('POST', '/api/units', { action: 'set_province_factor', province_code: prov, unit_code: edit.unit, units_per_acre: edit.perAcre, confirmed: edit.confirmed, note: edit.note }),
              `${edit.unit} in ${prov}: ${edit.perAcre} per acre from today.`, () => setEdit(null));
          }}>
            {error && <ErrorNote>{error}</ErrorNote>}
            <Field label={`${edit.unit} per acre`} required htmlFor="uPer" hint={`1 acre = ${edit.perAcre || '…'} ${edit.unit}. 1 ${edit.unit} = ${Number(edit.perAcre) > 0 ? round(43560 / Number(edit.perAcre)) : '…'} sq ft.`}>
              <input id="uPer" type="number" step="any" min="0.000001" required value={edit.perAcre} onChange={(e) => setEdit({ ...edit, perAcre: e.target.value })} />
            </Field>
            <label className="gl-check u-mb-10"><input type="checkbox" checked={edit.confirmed} onChange={(e) => setEdit({ ...edit, confirmed: e.target.checked })} />
              Confirmed by the Land Department</label>
            <Field label="Source / note" htmlFor="uNote" hint="e.g. the revenue office letter or district practice">
              <input id="uNote" type="text" maxLength={300} value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} />
            </Field>
          </form>
        )}
      </Modal>

      <Modal open={!!list} size="sm" icon="layers" title={`Units used in ${PROVINCES[prov]?.name ?? prov}`} onClose={() => setList(null)}
        footer={<>
          <button type="button" className="btn btn-s" onClick={() => setList(null)}>Cancel</button>
          <button type="button" className="btn btn-p" disabled={busy || !list?.length}
            onClick={() => list && run(() => send('POST', '/api/units', { action: 'set_province_units', province_code: prov, units: list }),
              `Unit list of ${prov} saved.`, () => setList(null))}>{busy ? 'Saving…' : 'Save'}</button>
        </>}>
        {list && (
          <>
            {error && <ErrorNote>{error}</ErrorNote>}
            <p className="note u-mb-10">Tick the units this province records land in. The order of ticking is the order on the forms. Acre is always included.</p>
            {units.map((u) => {
              const i = list.indexOf(u.code);
              return (
                <label key={u.code} className="gl-check u-mb-6">
                  <input type="checkbox" checked={i >= 0} disabled={u.code === 'Acre'}
                    onChange={(e) => setList(e.target.checked ? [...list, u.code] : list.filter((x) => x !== u.code))} />
                  {u.code}{i >= 0 && <small className="note"> · #{i + 1}</small>}
                </label>
              );
            })}
          </>
        )}
      </Modal>
    </>
  );
}

const round = (n: number) => (Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0);
