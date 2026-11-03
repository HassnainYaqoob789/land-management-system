'use client';

import React, { useState } from 'react';
import Shell, { useLMS } from '@/components/layout/Shell';
import { Card, Modal, Field, Stage, Table, Toolbar, SearchBox, Count, Tabs, Loading, Kpi, fmtNum, fmtDate, fmtRsM, Pager, rowOpen, DetailsModal, type DetailSection } from '@/components/legacy/ui';
import { useList, useListQuery, RefSelect, RecordPicker } from '@/components/legacy/data';
import { LoadError } from '@/components/auth/PageGuard';
import { ApiError, send, useApi } from '@/lib/client/api';
import { useCan, useCanIn } from '@/lib/client/permissions';
import { formatCNICInput, formatPKR } from '@/lib/domain';
import { escapeHtml, printDocument } from '@/lib/client/print';

export default function PaymentsPage() {
  return <Shell><PaymentsContent /></Shell>;
}

type TabKey = 'vouchers' | 'releases' | 'liabilities' | 'holds' | 'reconciliation';
type Dialog = null | { kind: 'request' } | { kind: 'release' | 'verify'; v: any } | { kind: 'receipt'; r: any } | { kind: 'allocate'; l: any }
  | { kind: 'hold' } | { kind: 'lift'; h: any } | { kind: 'reconcile' } | { kind: 'reverse'; r: any; confirming: boolean } | { kind: 'cancel'; v: any }
  | { kind: 'view'; what: ViewKind; x: any };
type ViewKind = 'voucher' | 'release' | 'receipt' | 'liability' | 'allocation' | 'hold' | 'run' | 'exception';

/** A landowner in a picker: name and CNIC exactly as the server sent it (masked without pii:read). */
const ownerLabel = (l: { full_name?: string; cnic?: string | null }) => `${l.full_name ?? ''}${l.cnic ? ` (${l.cnic})` : ''}`;

const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`.replace('.', ''));
const today = () => new Date().toISOString().slice(0, 10);

/** Money as a receipt prints it: 111,250.00 (no currency sign). */
const money = (v: unknown) => Number(v ?? 0).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Whole months from one date to another, inclusive of the last day (01-Apr to 31-Mar = 12). */
function monthsBetween(from?: string | null, to?: string | null): number | null {
  if (!from || !to) return null;
  const a = new Date(from), b = new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b < a) return null;
  const end = new Date(b.getTime() + 86_400_000);   // the day after the period ends
  return (end.getFullYear() - a.getFullYear()) * 12 + (end.getMonth() - a.getMonth());
}

/**
 * The "Receipt of Payment" document (REQ-65), laid out as the client's sample
 * (archive/requirments/Reports and documents/Sample Payment Receipt.png), for
 * every kind of payment: a compensation case (one owner, or one owner's share),
 * a lease's rent, a DBPFC government-land payment, or a stand-alone voucher.
 * The server says what the money was for (`basis`, `details`), the payee's share
 * and capacity, and whether it settles the account; this only lays it out.
 * Every value is escaped; `[[…]]` in a basis clause marks the part printed bold.
 */
function receiptHtml(r: any): string {
  const e = (v: unknown) => escapeHtml(v === null || v === undefined || v === '' ? '—' : String(v));
  const bold = (s: string) => e(s).replace(/\[\[(.*?)\]\]/g, '<b>$1</b>');
  const ac = (v: unknown) => Number(v ?? 0).toFixed(2);
  const h = r.heads ?? {}, d = r.details ?? {};
  const rentalHead = Number(h.rental) > 0;
  const wht = Number(r.wht_amount ?? 0);

  // The land, grouped by place: "999/1 (block 12) in Taluka Mirpur Mathelo, District Ghotki".
  const groups: any[] = r.land?.groups ?? [];
  const landText = groups.map((g) => {
    const list = g.parcels.map((s: any) => `${s.survey_no}${s.block_no ? ` (block ${s.block_no})` : ''}`).join(', ');
    return `<b>${e(list)}</b>${g.place ? ` in ${e(g.place)}` : ''}`;
  }).join('; ');
  const recorded = r.land?.recorded_acres ? ` (recorded area ${ac(r.land.recorded_acres)} acres)` : '';

  // What the money was for, and under which record.
  const basis = (r.basis ?? []).map(bold).join(' and ');
  const share = r.share && r.share.owners > 1
    ? ` the share of ${e(r.payee_name)} (<b>${e(Number(r.share.pct).toFixed(2))}%</b>, one of ${e(r.share.owners)} owners) in the compensation for` : '';
  const under = r.kind === 'case' ? `under Compensation Case # <b>${e(r.case_code)}</b>`
    : r.kind === 'lease' ? `leased under Lease Agreement # <b>${e(r.lease_code)}</b>`
    : r.kind === 'dbpfc' ? `under DBPFC estimate # <b>${e(r.dbpfc_code)}</b>` : '';
  const period = r.period_to
    ? ` for the period <b>${e(fmtDate(r.period_from))}</b> to <b>${e(fmtDate(r.period_to))}</b>`
    : r.pay_type && r.pay_type !== 'One-time' && r.period_from ? ` for the period from <b>${e(fmtDate(r.period_from))}</b>` : '';

  // The five heads of the sample, each with the record's own quantities.
  const months = monthsBetween(r.period_from, r.period_to);
  const rentalLabel = `Rental${months ? ` for ${months} months` : ''}${r.period_to ? ` ( ${e(fmtDate(r.period_from))} to ${e(fmtDate(r.period_to))} )` : ''}`;
  const detail = (k: string) => ((d[k] ?? []).length ? `<br><span class="small">${(d[k] as string[]).map(e).join('; ')}</span>` : '');
  const row = (label: string, value: string, strong = false) =>
    `<tr><td class="p-nb">${label}</td><td class="p-nb p-tc">=</td><td class="p-nb p-tr">${strong ? `<b>${value}</b>` : value}</td></tr>`;
  const whtLabel = `Less: withholding income tax${r.wht_pct != null ? ` (${e(Number(r.wht_pct))}%${r.tax_status ? `, ${e(r.tax_status)}` : ''})` : ''}`;

  // Settlement: full and final only when this payment leaves nothing owed on the payee's account.
  const s = r.settlement;
  const settlementTable = s ? [
    `<table class="p-w-80 p-mt-14">`,
    row('Payable to the payee under this case', money(s.payable)),
    row('Paid before this payment (gross)', money(s.paid_before)),
    row('This payment (gross)', money(s.this_payment)),
    row('<b>Balance after this payment</b>', money(s.balance), true),
    `</table>`].join('') : '';
  const fullAndFinal = !r.reversed && (s ? s.full : true);
  const advance = rentalHead && r.pay_type && r.pay_type !== 'One-time'
    ? ` I further confirm that if the lease rate is increased during the period for which I have received the advance rental payment, I shall
      not demand the incremental amount, which shall be considered set-off against the advance facility and I hereby expressly waive any
      entitlement or right to claim the same.` : '';
  const declaration = r.reversed
    ? `This payment was reversed after it was made. This receipt is void and is kept only as a record.`
    : !r.payee_is_landowner
    ? `Received the above amount for and on behalf of <b>${e(r.payee_name)}</b>${r.period_to ? ' for the period stated' : ''}.`
    : fullAndFinal
    ? `I hereby confirm that this payment represents full and final settlement of any and all of my claims and demands, on the above
       account(s), concerning the land described above${r.period_to ? ' for the period stated' : ''}.${advance}`
    : `I hereby acknowledge this payment as a part payment on the above account(s). The balance of Rs <b>${money(s?.balance)}</b> remains
       payable and this receipt does not settle it.`;

  // Who signs: the landowner (as owner or attorney), or the authorised signatory of a non-landowner payee.
  const capacity = r.share && r.share.capacity !== 'owner' ? ` (${e(r.share.capacity)})` : '';
  const recipient = r.payee_is_landowner
    ? `<p><b>${e(r.payee_name)}</b>${r.payee_father ? ` s/o ${e(r.payee_father)}` : ''}${capacity}<br>N.I.C. # : ${e(r.payee_cnic)}</p>`
    : `<p>for and on behalf of <b>${e(r.payee_name)}</b><br>Name and designation of signatory: ______________________</p>`;
  // 'Payee' / 'Self' in the receipt means the payee took the cheque in person.
  const ackBy = String(r.acknowledged_by ?? '').trim().toLowerCase();
  const other = !!ackBy && !['payee', 'self', 'landowner'].includes(ackBy) && ackBy !== String(r.payee_name ?? '').trim().toLowerCase();

  return [
    r.reversed ? `<div class="p-watermark">CANCELLED</div>` : '',
    `<p class="p-tc p-fs-15"><b><u>${e(r.reference)}</u></b></p>`,
    r.reversed ? `<p class="box">This cheque was reversed on ${e(fmtDate(r.reversed.at))}: ${e(r.reversed.reason)}. The receipt is void.</p>` : '',
    `<p class="p-just-17 p-mt-14">RECEIVED from <b>Mari Energies Limited</b> ${e(r.instrument)} No. <b>${e(r.cheque_no)}</b>, dated <b>${e(fmtDate(r.cheque_date))}</b>,
      amounting to Rupees: <b>${money(r.amount)}</b> (Rupees ${e(r.amount_words)} Only), in respect of${share} ${basis || 'the payment described below'}${landText ? ` on the land bearing survey/block number(s): ${landText}${recorded}` : ''}${period}${under ? `, ${under}` : ''}.</p>`,
    `<p class="p-mt-14">This Payment is comprised of the following :</p>`,
    `<table class="p-w-80">`,
    row(`1. ${rentalLabel}${detail('rental')}`, money(h.rental)),
    row(`2. Crop compensation (one-time)${detail('crop')}`, money(h.crop)),
    row(`3. Tree compensation (one-time)${detail('tree')}`, money(h.tree)),
    row(`4. Miscellaneous (one-time)${detail('misc')}`, money(h.misc)),
    row(`5. Others${Number(h.other) ? ` — ${e(r.category)}` : ''}`, money(h.other)),
    row('<span class="p-fr">Gross (Rs.)</span>', money(r.gross_amount), true),
    row(`<span class="p-fr">${whtLabel}</span>`, wht ? `(${money(wht)})` : money(0)),
    row('<span class="p-fr">Total (Rs.)</span>', money(r.amount), true),
    `</table>`,
    settlementTable,
    `<p class="p-just p-mt-20">${declaration}</p>`,
    `<p class="p-mt-40">Recipient: ________________________________ <span class="p-stamp small">Thumb impression / Revenue stamp</span></p>`,
    recipient,
    other ? `<p class="small">Cheque received on behalf of the payee by <b>${e(r.acknowledged_by)}</b>${r.acknowledged_cnic ? `, N.I.C. # ${e(r.acknowledged_cnic)}` : ''}.</p>` : '',
    `<p class="p-mt-20">Date: ______________________ <span class="small">(recorded as received on ${e(fmtDate(r.received_on))}, receipt ${e(r.receipt_no)})</span></p>`,
    `<p class="p-mt-14">Witnesses:</p>`,
    `<p class="p-mt-14">1. ____________________________ &nbsp; N.I.C. # : ____________________</p>`,
    `<p class="p-mt-14">2. ____________________________ &nbsp; N.I.C. # : ____________________</p>`,
    `<p class="small p-mt-20">Voucher ${e(r.voucher_code)} · ${e(r.category)} · ${e(r.pay_type)} · ${e(r.payment_mode)} · ${e(r.land_class)} land${r.project_code ? ` · Project ${e(r.project_code)} — ${e(r.project_name)}` : ''}</p>`,
  ].join('');
}

function PaymentsContent() {
  const { currentUser } = useLMS();
  const perms = useCan();
  const canIn = useCanIn();
  const [tab, setTabState] = useState<TabKey>('vouchers');
  const lq = useListQuery();
  const setTab = (t: TabKey) => { setTabState(t); lq.setQ(''); };
  // Each tab is its own bounded list, searched and paged in the database.
  const list = useList('/api/payments', tab, { view: tab, ...lq.params });
  const { body, page, summary, loading, error } = list;
  const receiptsList = useList(tab === 'releases' ? '/api/payments' : '', 'receipts', { view: 'receipts' });
  const allocationsList = useList(tab === 'liabilities' ? '/api/payments' : '', 'allocations', { view: 'allocations' });
  const projects = useApi(perms('projects:read') ? '/api/projects' : null).data?.projects ?? [];
  const vouchers: any[] = body?.vouchers ?? [], releases: any[] = body?.releases ?? [], liabilities: any[] = body?.liabilities ?? [];
  const holds: any[] = body?.holds ?? [];
  const allocations: any[] = tab === 'liabilities' ? allocationsList.rows : [], receipts: any[] = tab === 'releases' ? receiptsList.rows : [];
  const runs: any[] = body?.reconciliation_runs ?? [], exceptions: any[] = body?.reconciliation_exceptions ?? [];
  // The server's per-action rules (api/payments POST), in the record's province where it has one.
  const can = (a: string) => perms(`payments:${a}`);
  const canHere = (actions: string[], province: string | null | undefined) => canIn(actions.map((a) => `payments:${a}`), province, 'any');
  const finance = can('verify') || can('release');
  // Reversal: payments:release in the province, and never by the person who released the cheque.
  const reverseBlock = (r: any): string | null =>
    r.reversed_at ? 'This release has already been reversed.'
      : currentUser && r.released_by === currentUser.username ? 'You released this cheque; another finance officer must reverse it.' : null;

  const [dialog, setDialog] = useState<Dialog>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const f = (k: string) => form[k] ?? '';
  const set = (k: string) => (v: string) => setForm((s) => ({ ...s, [k]: v }));
  const open = (d: Dialog, init: Record<string, string> = {}) => { setFormError(null); setForm(init); setDialog(d); };
  // Print one receipt as the "Receipt of Payment" document (REQ-65).
  const [printError, setPrintError] = useState<string | null>(null);
  const [printing, setPrinting] = useState<string | null>(null);
  const printReceipt = async (id: string) => {
    setPrintError(null); setPrinting(id);
    try {
      const res = await fetch(`/api/payments?receipt=${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.receipt) throw new Error(d.error || `Could not load this receipt (${res.status}).`);
      const r = d.receipt;
      printDocument({
        title: 'Receipt of Payment',
        meta: [['Receipt', String(r.receipt_no ?? '')], ['Cheque', String(r.cheque_no ?? '')], ['Voucher', String(r.voucher_code ?? '')],
          ['Province', String(r.province_code ?? '')]],
        bodyHtml: receiptHtml(r),
        classification: 'Confidential — personal data',
      });
    } catch (err: any) { setPrintError(err.message); } finally { setPrinting(null); }
  };

  const act = async (e: React.FormEvent | null, body: Record<string, unknown>, also: string[] = []) => {
    e?.preventDefault(); setBusy(true); setFormError(null);
    try { await send('POST', '/api/payments', body, { also: ['/api/cases', '/api/landowners', '/api/budgets', ...also] }); setDialog(null); }
    catch (err: any) { setFormError(err.message); } finally { setBusy(false); }
  };
  const [notice, setNotice] = useState<string | null>(null);
  const reviewReverse = (e: React.FormEvent) => {
    e.preventDefault();
    if (dialog?.kind !== 'reverse') return;
    if (f('reason').trim().length < 10) { setFormError('Give the reason for the reversal (at least 10 characters).'); return; }
    setFormError(null); setDialog({ ...dialog, confirming: true });
  };
  const postReverse = async () => {
    if (dialog?.kind !== 'reverse') return;
    const r = dialog.r;
    setBusy(true); setFormError(null);
    try {
      await send('POST', `/api/payments/releases/${encodeURIComponent(r.release_id)}/reverse`, { reason: f('reason').trim() },
        { also: ['/api/cases', '/api/landowners', '/api/budgets', '/api/reports'] });
      setDialog(null);
      setNotice(`Cheque ${r.cheque_no} (${r.voucher_code}) reversed. The amount is no longer counted as paid.`);
    } catch (err: any) {
      setFormError(err instanceof ApiError && err.status === 409 ? `This release cannot be reversed in its current state: ${err.message}` : err.message);
      setDialog({ ...dialog, confirming: false });
    } finally { setBusy(false); }
  };
  const blank = (v: string) => (v === '' ? undefined : v);
  const num = (v: string) => (v === '' ? undefined : Number(v));

  const project = projects.find((p: any) => p.project_id === f('project_id'));

  // Read-only details of the clicked row (fields the list already carries).
  const when = (t?: string | null) => (t ? new Date(t).toLocaleString('en-GB') : null);
  const rs = (v: unknown) => (v === null || v === undefined || v === '' ? null : formatPKR(Number(v)));
  const period = (a?: string | null, b?: string | null) => (a ? `${fmtDate(a)}${b ? ` – ${fmtDate(b)}` : ''}` : null);
  const viewOf = (what: ViewKind, x: any): { title: React.ReactNode; icon: string; sections: DetailSection[]; actions?: React.ReactNode } => {
    switch (what) {
      case 'voucher': return {
        title: <>Voucher <span className="code">{x.code}</span></>, icon: 'wallet',
        sections: [
          { title: 'Voucher', items: [
            ['Stage', <><Stage value={x.stage_code} />{x.is_on_hold && <> <span className="b b-d">On hold</span></>}</>],
            ['Province', x.province_code],
            ['Project', x.project_code ? `${x.project_code} · ${x.project_name ?? ''}` : null],
            ['Compensation case', x.case_code],
            ['Category', x.category_code], ['Pay type', x.pay_type], ['Payment mode', x.payment_mode], ['Land class', x.land_class],
            ['Period', period(x.period_from, x.period_to)], ['Requested', when(x.created_at)], ['Remarks', x.remarks, true]] },
          { title: 'Payee', items: [['Payee', x.payee], ['CNIC', x.cnic && <span className="mono">{x.cnic}</span>], ['Tax status', x.tax_status]] },
          { title: 'Amounts', items: [['Gross', rs(x.gross_amount)],
            ['Withholding tax', x.wht_amount != null ? `${rs(x.wht_amount)} (${Number(x.wht_pct)}%)` : null], ['Net payable', rs(x.net_amount)]] },
          { title: 'Cheque', items: x.cheque_no ? [['Cheque no.', <span className="mono">{x.cheque_no}</span>], ['Cheque date', fmtDate(x.cheque_date)],
            ['Released', when(x.released_at)], ['Receipts', fmtNum(x.receipt_count)]] : [] },
        ],
        actions: <>
          {x.stage_code === 'Requested' && canHere(['verify'], x.province_code) &&
            <button type="button" className="btn btn-s" onClick={() => open({ kind: 'verify', v: x })}>Verify</button>}
          {x.stage_code === 'Verified' && canHere(['release'], x.province_code) &&
            <button type="button" className="btn btn-s" disabled={x.is_on_hold} title={x.is_on_hold ? 'A hold blocks release' : undefined}
              onClick={() => open({ kind: 'release', v: x }, { cheque_date: today() })}>Release cheque</button>}
          {['Requested', 'Verified'].includes(x.stage_code) && canHere(['verify', 'release'], x.province_code) &&
            <button type="button" className="btn btn-s" onClick={() => open({ kind: 'cancel', v: x })}>Cancel voucher</button>}
        </>,
      };
      case 'release': return {
        title: <>Cheque <span className="mono">{x.cheque_no}</span></>, icon: 'receipt',
        sections: [
          { title: 'Cheque', items: [['Cheque no.', <span className="mono">{x.cheque_no}</span>], ['Cheque date', fmtDate(x.cheque_date)],
            ['Amount', rs(x.released_amount)], ['Released', when(x.released_at)], ['Released by', x.released_by],
            ['Status', x.reversed_at ? <span className="b b-d">Reversed {when(x.reversed_at)}</span> : <span className="b b-g">Released</span>],
            ['Receipts', fmtNum(x.receipt_count)]] },
          { title: 'Voucher', items: [['Voucher', <span className="code">{x.voucher_code}</span>], ['Province', x.province_code], ['Project', x.project_code],
            ['Case', x.case_code], ['Lease', x.lease_code], ['Category', x.category_code], ['Pay type', x.pay_type], ['Period', period(x.period_from, x.period_to)]] },
          { title: 'Payee', items: [['Payee', x.payee], ['Landowner code', x.landowner_code], ['CNIC', x.cnic && <span className="mono">{x.cnic}</span>]] },
          { title: 'Amounts', items: [['Gross', rs(x.gross_amount)], ['Withholding tax', rs(x.wht_amount)], ['Net', rs(x.net_amount)]] },
        ],
        actions: canHere(['verify', 'release'], x.province_code) && !x.reversed_at
          ? <button type="button" className="btn btn-s" onClick={() => open({ kind: 'receipt', r: x }, { received_date: today() })}>Record receipt</button> : undefined,
      };
      case 'receipt': return {
        title: <>Receipt <span className="mono">{x.receipt_no}</span></>, icon: 'receipt',
        sections: [{ items: [['Receipt no.', <span className="mono">{x.receipt_no}</span>], ['Cheque', <span className="mono">{x.cheque_no}</span>],
          ['Voucher', <span className="code">{x.voucher_code}</span>], ['Received on', fmtDate(x.received_date || x.received_on)],
          ['Acknowledged by', x.acknowledged_by],
          ['Acknowledging CNIC', (x.received_by_cnic || x.acknowledged_cnic) && <span className="mono">{x.received_by_cnic || x.acknowledged_cnic}</span>],
          ['Recorded', when(x.recorded_at)], ['Recorded by', x.verified_by_name], ['Remarks', x.remarks || x.note, true]] }],
        actions: <button type="button" className="btn btn-s" onClick={() => printReceipt(x.id)} disabled={printing === x.id}>{printing === x.id ? 'Preparing…' : 'Print receipt'}</button>,
      };
      case 'liability': return {
        title: <>Liability <span className="code">{x.case_code}</span></>, icon: 'calc',
        sections: [
          { title: 'Case', items: [['Case', <span className="code">{x.case_code}</span>], ['Province', x.province_code],
            ['Project', x.project_code ? `${x.project_code} · ${x.project_name ?? ''}` : x.project_name],
            ['Approved', fmtDate(x.approved_at)], ['Days since approval', fmtNum(x.days_since_approval)],
            ['Settlement', <Stage value={x.settlement_status} />], ['Payees', x.payees, true]] },
          { title: 'Amounts', items: [['Approved award', rs(x.approved_amount)], ['Adjustments', rs(x.adjustment_amount)], ['Payable', rs(x.payable_amount)],
            ['Allocated', rs(x.allocated_amount)], ['Released (gross)', rs(x.released_amount)], ['Released (net)', rs(x.released_net_amount)],
            ['Withholding tax', rs(x.wht_amount)], ['Outstanding', x.outstanding_amount != null ? <b>{rs(x.outstanding_amount)}</b> : null]] },
        ],
        actions: canHere(['create', 'verify'], x.province_code)
          ? <button type="button" className="btn btn-s" onClick={() => open({ kind: 'allocate', l: x })}>Allocate voucher</button> : undefined,
      };
      case 'allocation': return {
        title: <>Allocation <span className="code">{x.payment_code}</span></>, icon: 'calc',
        sections: [{ items: [['Voucher', <span className="code">{x.payment_code}</span>], ['Case', <span className="code">{x.case_code}</span>],
          ['Landowner', x.landowner_name], ['Amount', rs(x.amount)], ['Allocated', when(x.allocated_at || x.created_at)],
          ['By', x.allocated_by_name], ['Note', x.note, true]] }],
      };
      case 'hold': return {
        title: <>Payment hold</>, icon: 'lock',
        sections: [
          { items: [['Status', x.lifted_at ? <span className="b b-g">Lifted</span> : <span className="b b-d">Active</span>], ['Scope', x.scope],
            ['Court stay', x.legal_case_id ? 'Yes (lift it on the legal case)' : 'No'], ['Province', x.province_code],
            ['Landowner', x.landowner_name], ['Case', x.case_code], ['Voucher', x.payment_code], ['Parcel', x.survey_code],
            ['Project', x.project_code ? `${x.project_code} · ${x.project_name ?? ''}` : null], ['Reason', x.reason, true]] },
          { title: 'History', items: [['Placed', when(x.placed_at)], ['Placed by', x.placed_by_name], ['Lifted', when(x.lifted_at)],
            ['Lifted by', x.lifted_by_name], ['Reason for lifting', x.lift_reason, true]] },
        ],
        actions: !x.lifted_at && canHere(['verify', 'release'], x.province_code) && !x.legal_case_id
          ? <button type="button" className="btn btn-s" onClick={() => open({ kind: 'lift', h: x })}>Lift</button> : undefined,
      };
      case 'run': return {
        title: <>Reconciliation run <span className="mono">{String(x.id).slice(0, 8)}</span></>, icon: 'calc',
        sections: [{ items: [['Scope', x.scope], ['Scope reference', x.scope_ref], ['Province', x.province_code], ['As of', fmtDate(x.as_of)],
          ['Started', when(x.started_at)], ['Finished', when(x.finished_at)],
          ['Exceptions', fmtNum(x.exception_count ?? exceptions.filter((e) => e.run_id === x.id).length)]] }],
      };
      case 'exception': return {
        title: <>Reconciliation exception</>, icon: 'warn',
        sections: [{ items: [
          ['Severity', <span className={`b ${x.severity === 'error' ? 'b-d' : x.severity === 'warning' ? 'b-w' : 'b-i'}`}>{x.severity}</span>],
          ['Finding', x.kind], ['Record', x.entity_code || x.entity], ['Record type', x.entity], ['Province', x.province_code], ['As of', fmtDate(x.as_of)],
          ['Expected', x.expected != null ? fmtNum(x.expected) : null], ['Actual', x.actual != null ? fmtNum(x.actual) : null],
          ['Difference', x.difference != null ? fmtNum(x.difference) : null], ['Resolved', when(x.resolved_at)], ['Resolution', x.resolution, true],
          ['Detail', x.detail ? (typeof x.detail === 'string' ? x.detail
            : <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{JSON.stringify(x.detail, null, 2)}</pre>) : null, true]] }],
      };
    }
  };
  const viewing = dialog?.kind === 'view' ? viewOf(dialog.what, dialog.x) : null;

  const shownCount = tab === 'reconciliation' ? exceptions.length : (page?.total ?? 0);

  return (
    <>
      {body && (
        <div className="kpis">
          <Kpi label="Awaiting verification" value={fmtNum(summary.requested)} sub="requested vouchers" tone="w" />
          <Kpi label="Verified, not released" value={fmtNum(summary.verified)} sub="ready for cheque" />
          <Kpi label="Released" value={fmtRsM(Number(summary.released_net ?? 0))} sub="net of withholding tax" tone="g" />
          <Kpi label="Outstanding liabilities" value={fmtRsM(Number(summary.outstanding ?? 0))} sub="approved, not fully paid" tone={Number(summary.outstanding) ? 'w' : 'g'} />
          <Kpi label="Active holds" value={fmtNum(summary.active_holds)} sub="stay orders and disputes" tone={summary.active_holds ? 'd' : 'g'} />
        </div>
      )}
      <Card icon="wallet" title="Payments & Cheques"
        sub="Requested → Verified → Released · withholding tax by filer status (finance.wht_pct; non-filers × finance.wht_nonfiler_multiplier) · one release per voucher · holds block release">
        <LoadError {...list} what="payments" />
        {notice && <div className="al i" role="status"><span className="i" /><div className="tx">{notice}</div></div>}
        <div className="bar">
          {can('create') && (perms('projects:read')
            ? <button className="btn btn-p" onClick={() => open({ kind: 'request' }, { idempotency_key: newKey(), period_from: today() })}>+ Request Payment</button>
            : <button className="btn btn-p" disabled title="Requesting a payment also needs read access to projects.">+ Request Payment</button>)}
          {finance && <button className="btn btn-s" onClick={() => open({ kind: 'hold' })}>Place hold</button>}
          {finance && <button className="btn btn-s" onClick={() => open({ kind: 'reconcile' }, { as_of_date: today() })}>Run reconciliation</button>}
        </div>
        <Tabs label="Payment views" value={tab} onChange={setTab} tabs={[
          ['vouchers', 'Vouchers'], ['releases', 'Cheques'], ['liabilities', 'Liabilities'],
          ['holds', `Holds (${fmtNum(summary.active_holds)} active)`], ['reconciliation', 'Reconciliation'],
        ]} />
        <Toolbar>
          <SearchBox value={lq.q} onChange={lq.setQ} placeholder="Search payee, CNIC, voucher, cheque, case…" />
          <Count n={shownCount} />
        </Toolbar>
        {loading ? <Loading what="payments" /> : error && !body ? null : (
          <>
            {tab === 'vouchers' && (
              <Table caption="Payment vouchers"
                head={<><th>Voucher</th><th>Prov.</th><th>Payee</th><th>Category</th><th className="num">Gross</th><th className="num">WHT</th><th className="num">Net (Rs)</th><th>Stage</th><th>Actions</th></>}
                empty={vouchers.length || error ? false : 'No vouchers.'} colSpan={9}>
                {vouchers.map((v) => (
                  <tr key={v.id} {...rowOpen(() => open({ kind: 'view', what: 'voucher', x: v }), `Show voucher ${v.code}`)}>
                    <td><span className="code">{v.code}</span><br /><small className="note">{v.project_code}{v.case_code ? ` · ${v.case_code}` : ''}</small></td>
                    <td><span className="pill">{v.province_code}</span></td>
                    <td>{v.payee || '—'}{v.cnic && <><br /><small className="note mono">{v.cnic} · {v.tax_status}</small></>}</td>
                    <td>{v.category_code}<br /><small className="note">{v.pay_type} · {v.payment_mode}</small></td>
                    <td className="num">{fmtNum(v.gross_amount)}</td>
                    <td className="num">−{fmtNum(v.wht_amount)} <small className="note">({Number(v.wht_pct)}%)</small></td>
                    <td className="num"><b>{fmtNum(v.net_amount)}</b></td>
                    <td><Stage value={v.stage_code} />{v.is_on_hold && <><br /><span className="b b-d">On hold</span></>}</td>
                    <td><div className="acts">
                      {v.stage_code === 'Requested' && canHere(['verify'], v.province_code) && <button onClick={() => open({ kind: 'verify', v })}>Verify</button>}
                      {v.stage_code === 'Verified' && canHere(['release'], v.province_code) && <button disabled={v.is_on_hold} title={v.is_on_hold ? 'A hold blocks release' : undefined}
                        onClick={() => open({ kind: 'release', v }, { cheque_date: today() })}>Release cheque</button>}
                      {['Requested', 'Verified'].includes(v.stage_code) && canHere(['verify', 'release'], v.province_code) &&
                        <button onClick={() => open({ kind: 'cancel', v })}>Cancel voucher</button>}
                      {v.stage_code === 'Released' && <span className="note mono">{v.cheque_no}</span>}
                    </div></td>
                  </tr>
                ))}
              </Table>
            )}
            {tab === 'releases' && (<>
              <Table caption="Cheque releases"
                head={<><th>Cheque</th><th>Voucher</th><th>Payee</th><th>Cheque date</th><th className="num">Amount (Rs)</th><th>Released</th><th className="num">Receipts</th><th>Actions</th></>}
                empty={releases.length || error ? false : 'No cheques released.'} colSpan={8}>
                {releases.map((r) => (
                  <tr key={r.release_id} {...rowOpen(() => open({ kind: 'view', what: 'release', x: r }), `Show cheque ${r.cheque_no}`)}>
                    <td><span className="mono">{r.cheque_no}</span></td>
                    <td><span className="code">{r.voucher_code}</span></td>
                    <td>{r.payee}{r.cnic && <><br /><small className="note mono">{r.cnic}</small></>}</td>
                    <td>{fmtDate(r.cheque_date)}</td>
                    <td className="num">{fmtNum(r.released_amount)}</td>
                    <td>{new Date(r.released_at).toLocaleString('en-GB')}<br /><small className="note">{r.released_by || '—'}</small></td>
                    <td className="num">{fmtNum(r.receipt_count)}</td>
                    <td><div className="acts">
                      {canHere(['verify', 'release'], r.province_code) && !r.reversed_at && (
                        <button onClick={() => open({ kind: 'receipt', r }, { received_date: today() })}>Record receipt</button>
                      )}
                      {r.reversed_at && <span className="b b-d">Reversed</span>}
                      {canHere(['release'], r.province_code) && !r.reversed_at && (
                        <button className="del" disabled={!!reverseBlock(r)} title={reverseBlock(r) ?? 'Reverse this release (returned, stopped or wrong cheque)'}
                          onClick={() => { setNotice(null); open({ kind: 'reverse', r, confirming: false }); }}>Reverse release</button>
                      )}
                    </div></td>
                  </tr>
                ))}
              </Table>
              <div className="sec-t u-mt-16">Receipts acknowledged by payees</div>
              {printError && <p className="u-danger" role="alert">{printError}</p>}
              <Table caption="Receipts" head={<><th>Receipt</th><th>Cheque</th><th>Voucher</th><th>Received</th><th>Acknowledged by</th><th>Remarks</th><th>Actions</th></>}
                empty={receipts.length ? false : 'No receipts recorded.'} colSpan={7}>
                {receipts.map((rc) => (
                  <tr key={rc.id} {...rowOpen(() => open({ kind: 'view', what: 'receipt', x: rc }), `Show receipt ${rc.receipt_no}`)}><td className="mono">{rc.receipt_no}</td><td className="mono">{rc.cheque_no}</td><td><span className="code">{rc.voucher_code}</span></td>
                    <td>{fmtDate(rc.received_date || rc.received_on)}</td><td>{rc.acknowledged_by}{(rc.received_by_cnic || rc.acknowledged_cnic) && <><br /><small className="note mono">{rc.received_by_cnic || rc.acknowledged_cnic}</small></>}</td>
                    <td>{rc.remarks || rc.note || '—'}</td>
                    <td><div className="acts"><button type="button" onClick={() => printReceipt(rc.id)} disabled={printing === rc.id}
                      aria-label={`Print receipt ${rc.receipt_no}`}>{printing === rc.id ? 'Preparing…' : 'Print receipt'}</button></div></td></tr>
                ))}
              </Table>
            </>)}
            {tab === 'liabilities' && (<>
              <Table caption="Outstanding liabilities"
                head={<><th>Case</th><th>Prov.</th><th>Project</th><th className="num">Approved</th><th className="num">Allocated</th><th className="num">Released</th>
                  <th className="num">Outstanding (Rs)</th><th className="num">Days</th><th>Settlement</th><th>Actions</th></>}
                empty={liabilities.length || error ? false : 'No outstanding liabilities.'} colSpan={10}>
                {liabilities.map((l) => (
                  <tr key={l.case_id} {...rowOpen(() => open({ kind: 'view', what: 'liability', x: l }), `Show liability of ${l.case_code}`)}>
                    <td><span className="code">{l.case_code}</span><br /><small className="note">{l.payees}</small></td>
                    <td><span className="pill">{l.province_code}</span></td>
                    <td>{l.project_name}</td>
                    <td className="num">{fmtNum(l.approved_amount)}</td>
                    <td className="num">{fmtNum(l.allocated_amount)}</td>
                    <td className="num">{fmtNum(l.released_amount)}</td>
                    <td className="num"><b>{fmtNum(l.outstanding_amount)}</b></td>
                    <td className="num">{fmtNum(l.days_since_approval)}</td>
                    <td><Stage value={l.settlement_status} /></td>
                    <td><div className="acts">{canHere(['create', 'verify'], l.province_code) && <button onClick={() => open({ kind: 'allocate', l })}>Allocate voucher</button>}</div></td>
                  </tr>
                ))}
              </Table>
              <div className="sec-t u-mt-16">Allocations of vouchers to cases</div>
              <Table caption="Allocations" head={<><th>Voucher</th><th>Case</th><th>Landowner</th><th className="num">Amount (Rs)</th><th>By</th><th>Note</th></>}
                empty={allocations.length ? false : 'No allocations.'} colSpan={6}>
                {allocations.map((a) => (
                  <tr key={a.id} {...rowOpen(() => open({ kind: 'view', what: 'allocation', x: a }), `Show allocation of ${a.payment_code}`)}><td><span className="code">{a.payment_code}</span></td><td><span className="code">{a.case_code}</span></td><td>{a.landowner_name || '—'}</td>
                    <td className="num">{fmtNum(a.amount)}</td><td>{a.allocated_by_name || '—'}</td><td>{a.note || '—'}</td></tr>
                ))}
              </Table>
            </>)}
            {tab === 'holds' && (
              <Table caption="Payment holds"
                head={<><th>Scope</th><th>On</th><th>Reason</th><th>Placed</th><th>Lifted</th><th>Actions</th></>}
                empty={holds.length || error ? false : 'No holds.'} colSpan={6}>
                {holds.map((h) => (
                  <tr key={h.id} {...rowOpen(() => open({ kind: 'view', what: 'hold', x: h }), 'Show hold details')}>
                    <td><span className="b b-n">{h.scope}</span>{h.legal_case_id && <><br /><span className="b b-d">Court stay</span></>}</td>
                    <td>{h.landowner_name || h.case_code || h.payment_code || h.survey_code || h.project_code || '—'}</td>
                    <td>{h.reason}</td>
                    <td>{fmtDate(h.placed_at)}<br /><small className="note">{h.placed_by_name || '—'}</small></td>
                    <td>{h.lifted_at ? <>{fmtDate(h.lifted_at)}<br /><small className="note">{h.lifted_by_name || '—'} · {h.lift_reason}</small></> : <span className="b b-d">Active</span>}</td>
                    <td><div className="acts">{!h.lifted_at && canHere(['verify', 'release'], h.province_code) && !h.legal_case_id && <button onClick={() => open({ kind: 'lift', h })}>Lift</button>}
                      {!h.lifted_at && h.legal_case_id && <span className="note">Lift on the legal case</span>}</div></td>
                  </tr>
                ))}
              </Table>
            )}
            {tab === 'reconciliation' && (<>
              <Table caption="Reconciliation runs" head={<><th>Run</th><th>Scope</th><th>As of</th><th>Started</th><th className="num">Exceptions</th></>}
                empty={runs.length ? false : 'No reconciliation has been run.'} colSpan={5}>
                {runs.map((r: any) => (
                  <tr key={r.id} {...rowOpen(() => open({ kind: 'view', what: 'run', x: r }), 'Show reconciliation run')}><td className="mono">{String(r.id).slice(0, 8)}</td><td>{r.scope}</td><td>{fmtDate(r.as_of)}</td>
                    <td>{r.started_at ? new Date(r.started_at).toLocaleString('en-GB') : '—'}</td><td className="num">{fmtNum(r.exception_count ?? exceptions.filter((e) => e.run_id === r.id).length)}</td></tr>
                ))}
              </Table>
              <div className="sec-t u-mt-16">Exceptions</div>
              <Table caption="Reconciliation exceptions" head={<><th>Severity</th><th>Record</th><th>Finding</th><th className="num">Expected</th><th className="num">Actual</th></>}
                empty={exceptions.length ? false : 'No exceptions.'} colSpan={5}>
                {exceptions.map((x: any) => (
                  <tr key={x.id} {...rowOpen(() => open({ kind: 'view', what: 'exception', x }), 'Show exception')}><td><span className={`b ${x.severity === 'error' ? 'b-d' : x.severity === 'warning' ? 'b-w' : 'b-i'}`}>{x.severity}</span></td>
                    <td className="mono">{x.entity_code || x.entity || '—'}</td><td>{x.kind}{x.detail && <><br /><small className="note">{typeof x.detail === 'string' ? x.detail : JSON.stringify(x.detail)}</small></>}</td>
                    <td className="num">{x.expected != null ? fmtNum(x.expected) : '—'}</td><td className="num">{x.actual != null ? fmtNum(x.actual) : '—'}</td></tr>
                ))}
              </Table>
            </>)}
          </>
        )}
        {tab !== 'reconciliation' && <Pager page={page} onOffset={lq.setOffset} />}
      </Card>

      {viewing && <DetailsModal open icon={viewing.icon} title={viewing.title} sections={viewing.sections} actions={viewing.actions} onClose={() => setDialog(null)} />}

      {/* request */}
      <Modal open={dialog?.kind === 'request'} icon="wallet" title="Request Payment" onClose={() => setDialog(null)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setDialog(null)}>Cancel</button>
          <button type="submit" form="reqForm" className="btn btn-p" disabled={busy}>{busy ? 'Saving…' : 'Request'}</button>
        </>}>
        <form id="reqForm" className="fgrid" onSubmit={(e) => act(e, {
          action: 'request', idempotency_key: f('idempotency_key'), project_id: f('project_id'), case_id: blank(f('case_id')),
          landowner_id: blank(f('landowner_id')), payee_name: f('landowner_id') ? undefined : blank(f('payee_name')),
          category: f('category'), pay_type: f('pay_type'), payment_mode: f('payment_mode'), land_class: f('land_class'),
          period_from: f('period_from'), period_to: blank(f('period_to')), gross_amount: num(f('gross_amount')), remarks: blank(f('remarks')),
        })}>
          <Field label="Project" required full htmlFor="pProj">
            <select id="pProj" required value={f('project_id')} onChange={(e) => setForm((s) => ({ ...s, project_id: e.target.value, case_id: '', landowner_id: '' }))}>
              <option value="">— Select project —</option>
              {projects.map((p: any) => <option key={p.project_id} value={p.project_id}>{p.project_code} — {p.project_name}</option>)}
            </select>
          </Field>
          <Field label="Case (optional)" htmlFor="pCase">
            {/* Only an approved case can be paid (api.request_payment refuses any other). */}
            <RecordPicker id="pCase" resource="/api/cases" rowsKey="cases" label="Approved case" value={f('case_id')}
              filters={{ project: project?.project_code, stage: 'HO Approved' }} idOf={(c) => c.case_id}
              optionLabel={(c) => `${c.case_code} · ${formatPKR(Number(c.outstanding_amount))} outstanding`} onChange={(id) => set('case_id')(id)} />
          </Field>
          <Field label="Payee (landowner)" required={!!f('case_id')} htmlFor="pLo"
            hint={f('case_id') ? 'A case payment names the owner it pays: the policy tax rate and any hold on the owner then apply.' : 'Or give a payee name below for a non-landowner'}>
            <RecordPicker id="pLo" resource="/api/landowners" rowsKey="landowners" label="Payee landowner" value={f('landowner_id')}
              filters={{ province: project?.province_code }} idOf={(l) => l.id}
              optionLabel={(l) => `${ownerLabel(l)} — ${l.tax_status}`} onChange={(id) => set('landowner_id')(id)} />
          </Field>
          {!f('landowner_id') && !f('case_id') && <Field label="Payee name" required htmlFor="pPayee"><input id="pPayee" required value={f('payee_name')} onChange={(e) => set('payee_name')(e.target.value)} placeholder="e.g. Government of Sindh — Board of Revenue" /></Field>}
          <Field label="Category" required htmlFor="pCat"><RefSelect id="pCat" required source="lookup:payment_category" value={f('category')} onChange={set('category')} /></Field>
          <Field label="Pay type" required htmlFor="pType"><RefSelect id="pType" required source="enum:payment_request.pay_type" value={f('pay_type')} onChange={set('pay_type')} /></Field>
          <Field label="Payment mode" required htmlFor="pMode"><RefSelect id="pMode" required source="enum:payment_request.payment_mode" value={f('payment_mode')} onChange={set('payment_mode')} /></Field>
          <Field label="Land class" required htmlFor="pClass" hint="Recorded on the voucher"><RefSelect id="pClass" required source="enum:payment_request.land_class" value={f('land_class')} onChange={set('land_class')} /></Field>
          <Field label="Period from" required htmlFor="pFrom"><input id="pFrom" type="date" required value={f('period_from')} onChange={(e) => set('period_from')(e.target.value)} /></Field>
          <Field label="Period to" htmlFor="pTo"><input id="pTo" type="date" value={f('period_to')} onChange={(e) => set('period_to')(e.target.value)} /></Field>
          <Field label="Gross amount (Rs)" required htmlFor="pGross" hint="Withholding tax is set by the database: finance.wht_pct for filers, times finance.wht_nonfiler_multiplier for non-filers"><input id="pGross" type="number" min="1" step="0.01" required value={f('gross_amount')} onChange={(e) => set('gross_amount')(e.target.value)} /></Field>
          <Field label="Remarks" full htmlFor="pRem"><textarea id="pRem" value={f('remarks')} onChange={(e) => set('remarks')(e.target.value)} /></Field>
        </form>
      </Modal>

      {/* verify */}
      <Modal open={dialog?.kind === 'verify'} size="sm" icon="check" title={`Verify ${dialog?.kind === 'verify' ? dialog.v.code : ''}`} onClose={() => setDialog(null)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setDialog(null)}>Cancel</button>
          <button type="submit" form="vfForm" className="btn btn-p" disabled={busy}>Verify</button>
        </>}>
        {dialog?.kind === 'verify' && (
          <form id="vfForm" onSubmit={(e) => act(e, { action: 'verify', payment_id: dialog.v.id, note: blank(f('note')) })}>
            <p className="u-mb-10">{dialog.v.payee} · net {formatPKR(dialog.v.net_amount)}. The person who requested a voucher cannot verify it.</p>
            <Field label="Note" htmlFor="vfNote"><textarea id="vfNote" value={f('note')} onChange={(e) => set('note')(e.target.value)} /></Field>
          </form>
        )}
      </Modal>

      {/* release */}
      <Modal open={dialog?.kind === 'release'} size="sm" icon="receipt" title={`Release cheque — ${dialog?.kind === 'release' ? dialog.v.code : ''}`} onClose={() => setDialog(null)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setDialog(null)}>Cancel</button>
          <button type="submit" form="rlForm" className="btn btn-g" disabled={busy}>{busy ? 'Issuing…' : 'Confirm release'}</button>
        </>}>
        {dialog?.kind === 'release' && (
          <form id="rlForm" onSubmit={(e) => act(e, { action: 'release', payment_id: dialog.v.id, cheque_date: f('cheque_date'), note: blank(f('note')) })}>
            <div className="totals u-mb-10">
              <div><small>Payee</small><b>{dialog.v.payee}</b></div>
              <div><small>Gross</small><b>{formatPKR(dialog.v.gross_amount)}</b></div>
              <div><small>WHT ({Number(dialog.v.wht_pct)}%)</small><b>−{formatPKR(dialog.v.wht_amount)}</b></div>
              <div><small>Net cheque</small><b>{formatPKR(dialog.v.net_amount)}</b></div>
            </div>
            <Field label="Cheque date" required htmlFor="rlDate"><input id="rlDate" type="date" required value={f('cheque_date')} onChange={(e) => set('cheque_date')(e.target.value)} /></Field>
            <Field label="Note" htmlFor="rlNote"><input id="rlNote" value={f('note')} onChange={(e) => set('note')(e.target.value)} /></Field>
          </form>
        )}
      </Modal>

      {/* receipt */}
      <Modal open={dialog?.kind === 'receipt'} size="sm" icon="receipt" title={`Receipt for cheque ${dialog?.kind === 'receipt' ? dialog.r.cheque_no : ''}`} onClose={() => setDialog(null)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setDialog(null)}>Cancel</button>
          <button type="submit" form="rcForm" className="btn btn-p" disabled={busy}>Save</button>
        </>}>
        {dialog?.kind === 'receipt' && (
          <form id="rcForm" onSubmit={(e) => act(e, { action: 'receipt', release_id: dialog.r.release_id, receipt_no: f('receipt_no'), received_date: f('received_date'),
            acknowledged_by: f('acknowledged_by'), received_by_cnic: blank(f('received_by_cnic')), remarks: blank(f('remarks')) })}>
            <Field label="Receipt no." required htmlFor="rcNo"><input id="rcNo" required value={f('receipt_no')} onChange={(e) => set('receipt_no')(e.target.value)} /></Field>
            <Field label="Received on" required htmlFor="rcDate"><input id="rcDate" type="date" required value={f('received_date')} onChange={(e) => set('received_date')(e.target.value)} /></Field>
            <Field label="Acknowledged by" required htmlFor="rcBy"><input id="rcBy" required value={f('acknowledged_by')} onChange={(e) => set('acknowledged_by')(e.target.value)} /></Field>
            <Field label="Their CNIC" htmlFor="rcCnic"><input id="rcCnic" className="mono" inputMode="numeric" autoComplete="off" maxLength={15} placeholder="12345-1234567-1" pattern="\d{5}-\d{7}-\d" value={f('received_by_cnic')} onChange={(e) => set('received_by_cnic')(formatCNICInput(e.target.value))} /></Field>
            <Field label="Remarks" htmlFor="rcRem"><input id="rcRem" value={f('remarks')} onChange={(e) => set('remarks')(e.target.value)} /></Field>
          </form>
        )}
      </Modal>

      {/* allocate */}
      <Modal open={dialog?.kind === 'allocate'} size="sm" icon="calc" title={`Allocate to ${dialog?.kind === 'allocate' ? dialog.l.case_code : ''}`} onClose={() => setDialog(null)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setDialog(null)}>Cancel</button>
          <button type="submit" form="alForm" className="btn btn-p" disabled={busy}>Allocate</button>
        </>}>
        {dialog?.kind === 'allocate' && (
          <form id="alForm" onSubmit={(e) => act(e, { action: 'allocate', case_id: dialog.l.case_id, payment_id: f('payment_id'), amount: num(f('amount')), note: blank(f('note')) })}>
            <p className="note u-mb-10">Outstanding on this case: {formatPKR(dialog.l.outstanding_amount)}.</p>
            <Field label="Voucher" required htmlFor="alV">
              <RecordPicker id="alV" resource="/api/payments" rowsKey="vouchers" label="Voucher" required value={f('payment_id')}
                filters={{ view: 'vouchers', project: dialog.l.project_code }} idOf={(v) => v.id}
                optionLabel={(v) => `${v.code} · ${v.payee} · ${formatPKR(Number(v.net_amount))} · ${v.stage_code}`} onChange={(id) => set('payment_id')(id)} />
            </Field>
            <Field label="Amount (Rs)" required htmlFor="alAmt"><input id="alAmt" type="number" min="1" step="0.01" required value={f('amount')} onChange={(e) => set('amount')(e.target.value)} /></Field>
            <Field label="Note" htmlFor="alNote"><input id="alNote" value={f('note')} onChange={(e) => set('note')(e.target.value)} /></Field>
          </form>
        )}
      </Modal>

      {/* hold */}
      <Modal open={dialog?.kind === 'hold'} size="sm" icon="lock" title="Place payment hold" onClose={() => setDialog(null)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setDialog(null)}>Cancel</button>
          <button type="submit" form="hdForm" className="btn btn-w" disabled={busy}>Place hold</button>
        </>}>
        <form id="hdForm" onSubmit={(e) => act(e, { action: 'hold', scope: f('scope'), [`${f('scope')}_id`]: f('target'), reason: f('reason') })}>
          <Field label="Hold applies to" required htmlFor="hdScope"><RefSelect id="hdScope" required source="enum:payment_hold.scope" value={f('scope')} onChange={(v) => setForm((s) => ({ ...s, scope: v, target: '' }))} /></Field>
          <Field label="Which" required htmlFor="hdTarget">
            {f('scope') === 'landowner' && <RecordPicker id="hdTarget" resource="/api/landowners" rowsKey="landowners" label="Landowner" required value={f('target')}
              idOf={(l) => l.id} optionLabel={ownerLabel} allowDeceased onChange={(id) => set('target')(id)} />}
            {f('scope') === 'case' && <RecordPicker id="hdTarget" resource="/api/cases" rowsKey="cases" label="Case" required value={f('target')}
              idOf={(c) => c.case_id} optionLabel={(c) => `${c.case_code} · ${c.stage_code}`} onChange={(id) => set('target')(id)} />}
            {f('scope') === 'payment' && <RecordPicker id="hdTarget" resource="/api/payments" rowsKey="vouchers" label="Voucher" required value={f('target')}
              filters={{ view: 'vouchers' }} idOf={(v) => v.id} optionLabel={(v) => `${v.code} · ${v.payee} · ${v.stage_code}`} onChange={(id) => set('target')(id)} />}
            {(f('scope') === 'project' || !f('scope')) && (
              <select id="hdTarget" required value={f('target')} onChange={(e) => set('target')(e.target.value)} disabled={!f('scope')}>
                <option value="">— Select —</option>
                {projects.map((p: any) => <option key={p.project_id} value={p.project_id}>{p.project_code} — {p.project_name}</option>)}
              </select>)}
          </Field>
          {f('scope') === 'survey' && <p className="note">Survey holds come from stay orders recorded on a legal case.</p>}
          <Field label="Reason" required htmlFor="hdWhy"><textarea id="hdWhy" required value={f('reason')} onChange={(e) => set('reason')(e.target.value)} /></Field>
        </form>
      </Modal>

      {/* lift */}
      <Modal open={dialog?.kind === 'lift'} size="sm" icon="lock" title="Lift hold" onClose={() => setDialog(null)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setDialog(null)}>Cancel</button>
          <button type="submit" form="lfForm" className="btn btn-g" disabled={busy}>Lift hold</button>
        </>}>
        {dialog?.kind === 'lift' && (
          <form id="lfForm" onSubmit={(e) => act(e, { action: 'lift_hold', hold_id: dialog.h.id, lift_reason: f('lift_reason') })}>
            <p className="u-mb-10">Hold: {dialog.h.reason}</p>
            <Field label="Why it can be lifted" required htmlFor="lfWhy"><textarea id="lfWhy" required value={f('lift_reason')} onChange={(e) => set('lift_reason')(e.target.value)} /></Field>
          </form>
        )}
      </Modal>

      {/* cancel a voucher */}
      <Modal open={dialog?.kind === 'cancel'} size="sm" icon="warn" title={`Cancel voucher — ${dialog?.kind === 'cancel' ? dialog.v.code : ''}`} onClose={() => setDialog(null)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setDialog(null)}>Back</button>
          <button type="submit" form="cvForm" className="btn btn-d" disabled={busy}>Cancel voucher</button>
        </>}>
        {dialog?.kind === 'cancel' && (
          <form id="cvForm" onSubmit={(e) => act(e, { action: 'cancel', payment_id: dialog.v.id, reason: f('cancel_reason') })}>
            <p className="u-mb-10">{dialog.v.payee || '—'} · {formatPKR(Number(dialog.v.gross_amount))} gross. A cancelled voucher is never paid; its holds are lifted and a new voucher can be raised (e.g. for the new owner after a mutation).</p>
            <Field label="Reason" required htmlFor="cvWhy"><textarea id="cvWhy" required minLength={5} value={f('cancel_reason')} onChange={(e) => set('cancel_reason')(e.target.value)}
              placeholder="e.g. land sold by mutation MUT-0004; raised again for the buyer" /></Field>
          </form>
        )}
      </Modal>

      {/* reverse a release */}
      <Modal open={dialog?.kind === 'reverse'} size="sm" icon="undo" title={`Reverse release — cheque ${dialog?.kind === 'reverse' ? dialog.r.cheque_no : ''}`} onClose={() => setDialog(null)}
        footer={dialog?.kind === 'reverse' && dialog.confirming ? <>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setDialog({ ...dialog, confirming: false })} disabled={busy}>Back</button>
          <button type="button" className="btn btn-d" onClick={postReverse} disabled={busy}>{busy ? 'Reversing…' : 'Confirm reversal'}</button>
        </> : <>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setDialog(null)}>Cancel</button>
          <button type="submit" form="rvForm" className="btn btn-d">Review</button>
        </>}>
        {dialog?.kind === 'reverse' && (
          <form id="rvForm" onSubmit={reviewReverse} noValidate>
            <div className="totals u-mb-10">
              <div><small>Voucher</small><b className="mono">{dialog.r.voucher_code}</b></div>
              <div><small>Cheque</small><b className="mono">{dialog.r.cheque_no}</b></div>
              <div><small>Amount</small><b>{formatPKR(Number(dialog.r.released_amount))}</b></div>
            </div>
            {dialog.confirming ? (
              <div className="al w" role="status"><span className="i" /><div className="tx">
                Reverse the release of <b>{formatPKR(Number(dialog.r.released_amount))}</b> on cheque <b>{dialog.r.cheque_no}</b>?
                <small>Reason: {f('reason').trim()}</small>
                <small>The amount stops counting as paid and the case balance reopens. The reversal is recorded in the audit trail and cannot be undone.</small>
              </div></div>
            ) : (
              <Field label="Reason" required htmlFor="rvWhy" hint="E.g. cheque returned unpaid, stopped, stale or issued in error. Recorded with your name.">
                <textarea id="rvWhy" required minLength={10} maxLength={1000} value={f('reason')} onChange={(e) => set('reason')(e.target.value)} />
              </Field>
            )}
          </form>
        )}
      </Modal>

      {/* reconcile */}
      <Modal open={dialog?.kind === 'reconcile'} size="sm" icon="calc" title="Run reconciliation" onClose={() => setDialog(null)}
        footer={<>
          {formError && <span className="u-danger u-flex-1" role="alert">{formError}</span>}
          <button type="button" className="btn btn-s" onClick={() => setDialog(null)}>Cancel</button>
          <button type="submit" form="rnForm" className="btn btn-p" disabled={busy}>{busy ? 'Running…' : 'Run'}</button>
        </>}>
        <form id="rnForm" onSubmit={(e) => { act(e, { action: 'reconcile', scope_type: f('scope_type'), project_id: blank(f('project_id')), as_of_date: f('as_of_date') }); setTab('reconciliation'); }}>
          <p className="note u-mb-10">Checks approved amounts, allocations, releases and receipts against each other and lists every mismatch.</p>
          <Field label="Scope" required htmlFor="rnScope"><RefSelect id="rnScope" required source="enum:reconciliation_run.scope" value={f('scope_type')} onChange={set('scope_type')} /></Field>
          {f('scope_type') === 'project' && (
            <Field label="Project" required htmlFor="rnProj">
              <select id="rnProj" required value={f('project_id')} onChange={(e) => set('project_id')(e.target.value)}>
                <option value="">— Select —</option>
                {projects.map((p: any) => <option key={p.project_id} value={p.project_id}>{p.project_code} — {p.project_name}</option>)}
              </select>
            </Field>
          )}
          <Field label="As of" required htmlFor="rnDate"><input id="rnDate" type="date" required value={f('as_of_date')} onChange={(e) => set('as_of_date')(e.target.value)} /></Field>
        </form>
      </Modal>
    </>
  );
}
