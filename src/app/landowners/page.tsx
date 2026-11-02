'use client';

import React, { useRef, useState } from 'react';
import Shell, { useLMS } from '@/components/layout/Shell';
import { Card, Modal, Field, Table, Toolbar, SearchBox, Count, Loading, Kpi, fmtNum, fmtRs, fmtDate, Pager } from '@/components/legacy/ui';
import { useList, RefSelect, ProvinceSelect, useListQuery } from '@/components/legacy/data';
import { LoadError } from '@/components/auth/PageGuard';
import { send, useApi, useReference, enumOf } from '@/lib/client/api';
import { useCan, useCanIn } from '@/lib/client/permissions';
import { printDocument, escapeHtml } from '@/lib/client/print';
import { formatCNICInput, isValidCNIC } from '@/lib/domain';

export default function LandownersPage() {
  return <Shell><LandownersContent /></Shell>;
}

// lms.landowner.owner_type, as the column comment defines it (migration 0003).
const OWNER_TYPE: Record<string, string> = { O: 'Owner', A: 'Attorney', B: 'Owner and attorney' };
const EMPTY = { province_code: '', full_name: '', father_name: '', cnic: '', owner_type: 'O', tax_status: '', phone: '', iban: '', bank_branch: '', address: '', status: '' };
// Personal data the server masks for users without pii:read (UI-04). Without it the edit
// form shows them read-only, exactly as returned, and never sends them back.
const PII = ['cnic', 'phone', 'iban', 'address'] as const;

/** GET /api/landowners?check_duplicate=1 — a registered person (CNIC masked without pii:read). */
interface DupMatch { id: string; code: string; full_name: string; father_name: string | null; province_code: string; status: string; cnic?: string; district?: string | null }
/** `cnic_match` is `{ registered: true }` alone when the caller may not see who it is. */
interface DupResult { cnic: string; cnic_match: (DupMatch & { registered?: never }) | { registered: true } | null; name_matches: DupMatch[] }

/** How to read the statement; shown on screen and on the print. */
const STATEMENT_NOTE = 'Shows compensation on cases approved at Head Office and cheques already released. '
  + 'Payment amounts are gross (cheque + withholding tax; the description gives both). '
  + 'Balance = approved compensation − compensation paid: other payments (lease rent, unallocated crop, …) do not change it. '
  + 'Paid to date is the total of the cheques themselves, after tax.';
const STATEMENT_NOTE_NO_PAY = 'Shows compensation on cases approved at Head Office. Payments, the balance and paid-to-date need the payments:read permission.';

/** The landowner statement as a printable document (UX-03); every value escaped. */
function statementHtml(owner: any, rows: any[], withPayments: boolean): string {
  const e = (v: unknown) => escapeHtml(v === null || v === undefined || v === '' ? '—' : String(v));
  const rs = (v: unknown) => e(v === null || v === undefined ? '—' : fmtRs(v));
  const kv = (pairs: [string, string][]) => `<div class="kv">${pairs.map(([k, v]) => `<span>${e(k)}:</span><b>${v}</b>`).join('')}</div>`;
  const head = ['Date', 'Entry', 'Reference', 'Description', 'Amount (Rs)', ...(withPayments ? ['Balance (Rs)'] : [])];
  return [
    kv([['Owner ID', e(owner.code)], ['Name', `${e(owner.full_name)}${owner.father_name ? ` s/o ${e(owner.father_name)}` : ''}`],
      ['CNIC', e(owner.cnic)], ['Province', e(owner.province_code)], ['Status', e(owner.status)], ['Tax status', e(owner.tax_status)],
      ['Holdings', `${e(fmtNum(owner.holding_count))} · ${e(fmtNum(owner.owned_area_acres, 2))} ac`], ['Active leases', e(fmtNum(owner.active_lease_count))],
      ...(withPayments ? [['Paid to date (cheques, after tax)', rs(owner.paid_to_date)] as [string, string]] : [])]),
    `<div class="band">STATEMENT OF ACCOUNT</div>`,
    `<p class="small">${e(withPayments ? STATEMENT_NOTE : STATEMENT_NOTE_NO_PAY)}</p>`,
    `<table><tr>${head.map((h) => `<th>${e(h)}</th>`).join('')}</tr>${rows.length ? rows.map((r) => `<tr><td>${e(fmtDate(r.entry_date))}</td><td>${e(r.entry_type)}</td>
      <td>${e(r.reference)}</td><td>${e(r.description)}</td><td class="r">${rs(r.amount)}</td>${withPayments ? `<td class="r">${rs(r.running_total)}</td>` : ''}</tr>`).join('')
      : `<tr><td colspan="${head.length}">No transactions for this landowner.</td></tr>`}</table>`,
  ].join('');
}

/** Shown in the Add Landowner form: an exact CNIC match blocks saving; similar names only warn. */
function DuplicateWarning({ dup, blocked, onOpen }: { dup: DupResult; blocked: boolean; onOpen: (m: DupMatch) => void }) {
  const exact = dup.cnic_match;
  const names = dup.name_matches;
  if (!exact && !names.length) return null;
  const who = (m: DupMatch) => <><span className="code">{m.code}</span> <b>{m.full_name}</b>{m.father_name ? <> s/o {m.father_name}</> : null}</>;
  return (
    <div className="fg full">
      {exact && (
        <div className={`al ${blocked ? 'd' : 'w'}`} role="alert"><span className="i" /><div className="tx">
          {'code' in exact
            ? <><b>This CNIC is already registered as {exact.code} — {exact.full_name}{exact.father_name ? ` s/o ${exact.father_name}` : ''} ({exact.province_code}).</b>
                <small>One person has one record, however many parcels they hold. Open it instead of adding a second one.{' '}
                  <button type="button" className="btn btn-s btn-sm" onClick={() => onOpen(exact)}>Open {exact.code}</button></small></>
            : <><b>This CNIC is already registered.</b><small>One person has one record. Ask an officer of that province to open it.</small></>}
          {!blocked && <small>The CNIC has been changed since; check it again by leaving the CNIC box.</small>}
        </div></div>
      )}
      {names.length > 0 && (
        <div className="al w" role="status"><span className="i" /><div className="tx">
          <b>{names.length === 1 ? 'A person' : `${names.length} people`} with a very similar name and father / husband name {names.length === 1 ? 'is' : 'are'} already registered in this province.</b>
          <small>If it is the same person, open the existing record instead. Different people can share a name: save only if the CNIC differs.</small>
          <ul className="u-mt-6">
            {names.map((m) => (
              <li key={m.id}>{who(m)} · CNIC <span className="mono">{m.cnic || '—'}</span> · {m.district || 'no parcels yet'}{' '}
                <button type="button" className="btn btn-s btn-sm" onClick={() => onOpen(m)}>Open</button></li>
            ))}
          </ul>
        </div></div>
      )}
    </div>
  );
}

function LandownersContent() {
  const { activeProvince } = useLMS();
  const can = useCan();
  const canIn = useCanIn();
  const ref = useReference();
  const lq = useListQuery();
  const list = useList('/api/landowners', 'landowners', { search: lq.dq || undefined, offset: lq.offset || undefined });
  const { rows, body, page, summary, loading, error } = list;
  const canPii = can('pii:read');
  // Paid-to-date and payment lines are finance data (UI-09): shown only with payments:read.
  const canPayments = can('payments:read');
  const [mode, setMode] = useState<'new' | 'edit' | null>(null);
  const [form, setForm] = useState({ ...EMPTY });
  const [editing, setEditing] = useState<any | null>(null);
  const [masked, setMasked] = useState<Record<string, string>>({});
  const [editLoading, setEditLoading] = useState(false);
  const editSeq = useRef(0);   // a slower answer for a previously opened record never fills the form
  const [stmtId, setStmtId] = useState<string | null>(null);
  const stmtLoad = useApi<any>(stmtId ? `/api/landowners?statement_for=${encodeURIComponent(stmtId)}` : null);
  const stmtOwner = stmtLoad.data?.landowner;
  // The server leaves out payment lines, the balance and paid-to-date unless the caller
  // may read payments in this owner's province, and says which it did.
  const stmtRows: any[] = stmtLoad.data?.statement ?? [];
  const stmtPay = stmtLoad.data?.payments_shown === true;
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof EMPTY) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  // PII is editable when creating (it is being entered) or with pii:read.
  const piiEditable = mode === 'new' || canPii;
  const cnicBad = piiEditable && form.cnic !== '' && !isValidCNIC(form.cnic);
  const ibanBad = piiEditable && form.iban !== '' && !/^PK\d{2}[A-Z]{4}[0-9A-Z]{16}$/.test(form.iban.replace(/\s/g, '').toUpperCase());

  // Duplicate-person check while adding (one CNIC is one person, who may hold many parcels).
  // The server answers for the CNIC and name as typed; an exact CNIC match blocks saving
  // only while the CNIC in the form is still the one that matched.
  const [dup, setDup] = useState<null | DupResult>(null);
  const dupSeq = useRef(0);
  const dupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetDup = () => { dupSeq.current++; if (dupTimer.current) clearTimeout(dupTimer.current); setDup(null); };
  const checkDuplicate = (f: typeof EMPTY) => {
    if (mode !== 'new') return;
    if (dupTimer.current) clearTimeout(dupTimer.current);
    dupTimer.current = setTimeout(async () => {
      const cnic = isValidCNIC(f.cnic) ? f.cnic : '';
      const name = f.full_name.trim();
      if (!cnic && (name.length < 3 || !f.province_code)) { setDup(null); return; }
      const seq = ++dupSeq.current;
      const qs = new URLSearchParams({ check_duplicate: '1', cnic, name, father_name: f.father_name.trim(), province: f.province_code });
      try {
        const res = await fetch(`/api/landowners?${qs}`, { headers: { Accept: 'application/json' } });
        const d = await res.json().catch(() => ({}));
        if (seq !== dupSeq.current || !res.ok) return;   // the check only warns; saving still enforces the CNIC rule
        setDup({ cnic, cnic_match: d.cnic_match ?? null, name_matches: d.name_matches ?? [] });
      } catch { /* a failed check never blocks entry */ }
    }, 300);
  };
  const dupBlocked = mode === 'new' && !!dup?.cnic_match && dup.cnic !== '' && dup.cnic === form.cnic;
  const openExisting = (m: DupMatch) => {
    setMode(null); resetDup(); lq.setQ(m.code);
    if (canIn('landowners:update', m.province_code)) openEdit(m);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault(); if (cnicBad || ibanBad || dupBlocked || (mode === 'edit' && editLoading)) return; setBusy(true); setFormError(null);
    const body = { full_name: form.full_name, father_name: form.father_name, owner_type: form.owner_type, tax_status: form.tax_status,
      bank_branch: form.bank_branch || undefined,
      ...(piiEditable ? { cnic: form.cnic, phone: form.phone || undefined, iban: form.iban ? form.iban.replace(/\s/g, '').toUpperCase() : undefined,
        address: form.address || undefined } : {}) };
    try {
      if (mode === 'edit') await send('PUT', '/api/landowners', { id: editing.id, ...body, status: form.status }, { also: ['/api/payments', '/api/surveys'] });
      else await send('POST', '/api/landowners', { ...body, province_code: form.province_code });
      setMode(null);
    } catch (err: any) { setFormError(err.message); } finally { setBusy(false); }
  };

  // The list does not carry the full record; the edit form loads it (masked without pii:read).
  const openEdit = async (lo: any) => {
    const seq = ++editSeq.current;
    setFormError(null); setEditing(lo); setMasked({}); setEditLoading(true);
    setForm({ ...EMPTY, province_code: lo.province_code, full_name: lo.full_name ?? '', father_name: lo.father_name ?? '', owner_type: lo.owner_type,
      tax_status: lo.tax_status, bank_branch: lo.bank_branch ?? '', status: lo.status });
    setMode('edit');
    try {
      const res = await fetch(`/api/landowners?id=${encodeURIComponent(lo.id)}`, { headers: { Accept: 'application/json' } });
      const d = await res.json().catch(() => ({}));
      if (seq !== editSeq.current) return;
      if (!res.ok || !d.landowner) throw new Error(d.error || `Could not load this landowner (${res.status}).`);
      const r = d.landowner;
      const pii = Object.fromEntries(PII.map((k) => [k, r[k] == null ? '' : String(r[k])]));
      setForm({ ...EMPTY, province_code: r.province_code, full_name: r.full_name ?? '', father_name: r.father_name ?? '', owner_type: r.owner_type,
        tax_status: r.tax_status, bank_branch: r.bank_branch ?? '', status: r.status, ...(canPii ? pii : {}) });
      if (!canPii) setMasked(pii);
      setEditLoading(false);
    } catch (err: any) { if (seq === editSeq.current) setFormError(err.message); }
  };
  const openStatement = (lo: any) => { setFormError(null); setStmtId(lo.id); };
  const printStatement = () => {
    if (!stmtOwner) return;
    printDocument({
      title: 'Landowner Statement',
      meta: [['Owner ID', String(stmtOwner.code ?? '')], ['Province', String(stmtOwner.province_code ?? '')]],
      bodyHtml: statementHtml(stmtOwner, stmtRows, stmtPay),
      classification: 'Confidential — personal data',
    });
  };

  const deceased = summary.deceased, nonFilers = summary.non_filers;
  const piiField = (k: (typeof PII)[number], label: string, id: string, input: React.ReactNode, hint?: React.ReactNode, full = false) => (
    <Field label={label} full={full} required={k === 'cnic' && piiEditable} htmlFor={piiEditable ? id : `${id}Ro`}
      hint={piiEditable ? hint : 'Shown as the server returned it. Viewing or changing it needs the pii:read permission.'}>
      {piiEditable ? input : <input id={`${id}Ro`} readOnly className="mono" value={masked[k] || '—'} />}
    </Field>
  );

  return (
    <>
      {body && (
        <div className="kpis">
          <Kpi label="Landowners" value={fmtNum(summary.total)} sub="unique CNIC-based IDs" />
          <Kpi label="Non-filers" value={fmtNum(nonFilers)} sub="FBR tax status on record" tone={nonFilers ? 'w' : 'g'} />
          <Kpi label="Deceased — locked" value={fmtNum(deceased)} sub="awaiting succession (mutation)" tone={deceased ? 'd' : 'g'} />
          <Kpi label="On payment hold" value={fmtNum(summary.on_hold)} sub="stay order or dispute" tone="w" />
        </div>
      )}
      <Card icon="user" title="Landowners" sub="CNIC is the unique identity · FBR filer status is recorded · deceased owners are locked until succession is recorded">
        <LoadError {...list} what="the landowner register" />
        {can('landowners:create') && (
          <div className="bar"><button className="btn btn-p" onClick={() => { editSeq.current++; setFormError(null); setEditing(null); setEditLoading(false); setMasked({}); resetDup(); setForm({ ...EMPTY, province_code: activeProvince !== 'ALL' ? activeProvince : '' }); setMode('new'); }}>+ Add Landowner</button></div>
        )}
        <Toolbar>
          <SearchBox value={lq.q} onChange={lq.setQ} placeholder="Search name, father name, CNIC or bank branch…" />
          <Count n={page?.total ?? rows.length} />
        </Toolbar>
        {loading ? <Loading what="landowners" /> : (
          <Table caption="Landowners"
            head={<><th>Owner ID</th><th>Name &amp; parentage</th><th>CNIC</th><th>Prov.</th><th>Type</th><th>Tax status</th><th>Status</th>
              <th className="num">Holdings</th>{canPayments && <th className="num">Paid to date (Rs)</th>}<th>Bank branch</th><th>Actions</th></>}
            empty={rows.length || error ? false : `No landowners${lq.q ? ' match the search' : ' yet'}.`} colSpan={canPayments ? 11 : 10}>
            {rows.map((lo: any) => (
              <tr key={lo.id}>
                <td><span className="code">{lo.code}</span></td>
                <td>{lo.full_name}{lo.father_name && <><br /><small className="note">s/o {lo.father_name}</small></>}</td>
                <td className="mono">{lo.cnic}</td>
                <td><span className="pill">{lo.province_code}</span></td>
                <td>{OWNER_TYPE[lo.owner_type] ?? lo.owner_type}</td>
                <td><span className={`b ${lo.tax_status === 'Filer' ? 'b-g' : 'b-w'}`}>{lo.tax_status}</span></td>
                <td>{lo.is_deceased ? <span className="b b-d">Deceased — locked</span> : <span className={`b ${lo.status === 'Active' ? 'b-g' : 'b-n'}`}>{lo.status}</span>}
                  {lo.is_on_hold && <><br /><span className="b b-d">On hold</span></>}</td>
                <td className="num">{fmtNum(lo.total_parcels ?? 0)} <small className="note">({fmtNum(lo.total_acres, 2)} ac)</small></td>
                {canPayments && <td className="num">{fmtNum(lo.paid_to_date)}</td>}
                <td>{lo.bank_branch || <span className="note">—</span>}</td>
                <td><div className="acts">
                  <button onClick={() => openStatement(lo)}>Statement</button>
                  {canIn('landowners:update', lo.province_code) && <button onClick={() => openEdit(lo)}>Edit</button>}
                </div></td>
              </tr>
            ))}
          </Table>
        )}
        <Pager page={page} onOffset={lq.setOffset} />
      </Card>

      {/* The title names the record by its code, never by personal data. */}
      <Modal open={!!stmtId} size="lg" icon="receipt" title={`Statement — ${stmtOwner?.code ?? ''}`} onClose={() => setStmtId(null)}
        footer={<><button className="btn btn-s" onClick={printStatement} disabled={!stmtOwner}>Print</button><button className="btn btn-s" onClick={() => setStmtId(null)}>Close</button></>}>
        {stmtLoad.error ? <LoadError {...stmtLoad} what="this statement" /> : !stmtOwner ? <Loading what="statement" /> : (
          <>
            <p className="u-mb-10"><b>{stmtOwner.full_name}</b>{stmtOwner.father_name ? <> s/o {stmtOwner.father_name}</> : null}</p>
            <div className="totals u-mb-10">
              <div><small>CNIC</small><b className="mono">{stmtOwner.cnic || '—'}</b></div>
              <div><small>Holdings</small><b>{fmtNum(stmtOwner.holding_count)} · {fmtNum(stmtOwner.owned_area_acres, 2)} ac</b></div>
              <div><small>Active leases</small><b>{fmtNum(stmtOwner.active_lease_count)}</b></div>
              {stmtPay && <div><small>Paid to date (cheques, after tax)</small><b>{fmtRs(stmtOwner.paid_to_date)}</b></div>}
            </div>
            <Table caption="Landowner statement"
              head={<><th>Date</th><th>Entry</th><th>Reference</th><th>Description</th><th className="num">Amount (Rs)</th>{stmtPay && <th className="num">Balance (Rs)</th>}</>}
              empty={stmtRows.length ? false : 'No transactions for this landowner.'} colSpan={stmtPay ? 6 : 5}>
              {stmtRows.map((r, i) => (
                <tr key={i}><td>{fmtDate(r.entry_date)}</td><td>{r.entry_type}</td><td><span className="code">{r.reference}</span></td><td>{r.description || '—'}</td>
                  <td className="num">{fmtNum(r.amount)}</td>{stmtPay && <td className="num">{fmtNum(r.running_total)}</td>}</tr>
              ))}
            </Table>
            <p className="note u-mt-8">{stmtPay ? STATEMENT_NOTE : STATEMENT_NOTE_NO_PAY}</p>
          </>
        )}
      </Modal>

      <Modal open={!!mode} icon="user" title={mode === 'edit' ? `Edit landowner — ${editing?.code}` : 'Add Landowner'} onClose={() => setMode(null)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setMode(null)}>Cancel</button>
          <button type="submit" form="loForm" className="btn btn-p" disabled={busy || cnicBad || ibanBad || dupBlocked || (mode === 'edit' && editLoading)}
            title={dupBlocked ? 'This CNIC is already registered: open the existing record instead.' : undefined}>{busy ? 'Saving…' : 'Save'}</button>
        </>}>
        <form id="loForm" onSubmit={save} className="fgrid">
          {mode === 'new' && <Field label="Province" required htmlFor="loProv"><ProvinceSelect id="loProv" required value={form.province_code} onChange={(v) => { set('province_code')(v); checkDuplicate({ ...form, province_code: v }); }} /></Field>}
          {mode === 'edit' && editLoading && !formError && <div className="fg full"><Loading what="landowner" /></div>}
          {mode === 'new' && dup && <DuplicateWarning dup={dup} blocked={dupBlocked} onOpen={openExisting} />}
          {piiField('cnic', 'CNIC', 'loCnic',
            <input id="loCnic" required inputMode="numeric" autoComplete="off" maxLength={15} placeholder="12345-1234567-1" className={`mono${cnicBad ? ' err' : ''}`} aria-invalid={cnicBad} value={form.cnic} onChange={(e) => set('cnic')(formatCNICInput(e.target.value))} onBlur={() => checkDuplicate(form)} />,
            cnicBad ? <span className="u-danger">Format XXXXX-XXXXXXX-X</span> : 'Format XXXXX-XXXXXXX-X')}
          <Field label="Full name (as on CNIC)" required htmlFor="loName"><input id="loName" required value={form.full_name} onChange={(e) => set('full_name')(e.target.value)} onBlur={() => checkDuplicate(form)} /></Field>
          <Field label="Father / husband name" required htmlFor="loFather"><input id="loFather" required value={form.father_name} onChange={(e) => set('father_name')(e.target.value)} onBlur={() => checkDuplicate(form)} /></Field>
          <Field label="Owner type" required htmlFor="loType">
            <select id="loType" required value={form.owner_type} onChange={(e) => set('owner_type')(e.target.value)}>
              {enumOf(ref, 'landowner.owner_type').map((v) => <option key={v} value={v}>{OWNER_TYPE[v] ?? v}</option>)}
            </select>
          </Field>
          <Field label="Tax status" required htmlFor="loTax"><RefSelect id="loTax" required source="enum:landowner.tax_status" value={form.tax_status} onChange={set('tax_status')} /></Field>
          {mode === 'edit' && <Field label="Status" required htmlFor="loStatus" hint="Deceased locks shares and payments until succession is recorded"><RefSelect id="loStatus" required source="enum:landowner.status" value={form.status} onChange={set('status')} /></Field>}
          {piiField('phone', 'Phone', 'loPhone', <input id="loPhone" type="tel" value={form.phone} onChange={(e) => set('phone')(e.target.value)} />)}
          <Field label="Bank branch" htmlFor="loBank"><input id="loBank" value={form.bank_branch} onChange={(e) => set('bank_branch')(e.target.value)} placeholder="e.g. HBL Ghotki" /></Field>
          {piiField('iban', 'IBAN', 'loIban',
            <input id="loIban" className={`mono${ibanBad ? ' err' : ''}`} aria-invalid={ibanBad} value={form.iban} onChange={(e) => set('iban')(e.target.value)} placeholder="PK36HABB…" />,
            ibanBad ? <span className="u-danger">PK + 2 digits + 4-letter bank code + 16 characters</span> : '24 characters')}
          {piiField('address', 'Address', 'loAddr', <textarea id="loAddr" value={form.address} onChange={(e) => set('address')(e.target.value)} />, undefined, true)}
        </form>
      </Modal>
    </>
  );
}
