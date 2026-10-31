'use client';

import { RecordPicker } from '@/components/legacy/data';
import React, { useState } from 'react';
import { Landowner } from '@/lib/types';

export interface OwnerShareItem {
  landowner_id: string;
  landowner_name: string;
  cnic: string;
  share_pct: number;
  revenue_doc_ref?: string;
  tax_status?: string;
  is_deceased?: boolean;
}

interface ShareBalancerProps {
  totalAreaAcres: number;
  initialShares?: OwnerShareItem[];
  /** Province whose landowners may be added (searched in the database). */
  province: string;
  onSharesChange: (shares: OwnerShareItem[], isValid: boolean) => void;
}

export default function ShareBalancer({
  totalAreaAcres,
  initialShares = [],
  province,
  onSharesChange,
}: ShareBalancerProps) {
  const [shares, setShares] = useState<OwnerShareItem[]>(initialShares);
  const [selectedOwnerId, setSelectedOwnerId] = useState('');
  const [selectedOwner, setSelectedOwner] = useState<Landowner | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  const totalSharePct = Number(
    shares.reduce((acc, curr) => acc + Number(curr.share_pct || 0), 0).toFixed(2)
  );
  const isExact100 = Math.abs(totalSharePct - 100.0) < 0.01;
  const hasDeceased = shares.some((s) => s.is_deceased);
  const isValid = isExact100 && !hasDeceased && shares.length > 0;

  const handleShareChange = (index: number, val: number) => {
    const updated = [...shares];
    updated[index].share_pct = Math.max(0, Math.min(100, Number(val) || 0));
    setShares(updated);
    const sum = updated.reduce((acc, curr) => acc + Number(curr.share_pct || 0), 0);
    const valid = Math.abs(sum - 100.0) < 0.01 && !updated.some((s) => s.is_deceased);
    onSharesChange(updated, valid);
  };

  const handleDocRefChange = (index: number, docRef: string) => {
    const updated = [...shares];
    updated[index].revenue_doc_ref = docRef;
    setShares(updated);
    onSharesChange(updated, isValid);
  };

  const addOwner = () => {
    if (!selectedOwnerId) return;
    const owner = selectedOwner && selectedOwner.id === selectedOwnerId ? selectedOwner : null;
    if (!owner) return;

    if (shares.some((s) => s.landowner_id === owner.id)) {
      setAddError('This landowner is already on this survey.');
      return;
    }

    if (owner.is_deceased) {
      setAddError(`${owner.full_name} is deceased. Record the succession (mutation) before allocating shares.`);
      return;
    }

    const remaining = Math.max(0, Number((100 - totalSharePct).toFixed(2)));
    const updated = [
      ...shares,
      {
        landowner_id: owner.id,
        landowner_name: owner.full_name,
        cnic: owner.cnic,
        share_pct: remaining,
        revenue_doc_ref: 'Registered Sale Deed / Khasra Girdawari',
        tax_status: owner.filer_status,
        is_deceased: owner.is_deceased,
      },
    ];

    setShares(updated);
    setSelectedOwnerId('');
    setAddError(null);
    const sum = updated.reduce((acc, curr) => acc + Number(curr.share_pct || 0), 0);
    onSharesChange(updated, Math.abs(sum - 100.0) < 0.01);
  };

  const removeOwner = (index: number) => {
    const updated = shares.filter((_, i) => i !== index);
    setShares(updated);
    const sum = updated.reduce((acc, curr) => acc + Number(curr.share_pct || 0), 0);
    onSharesChange(updated, Math.abs(sum - 100.0) < 0.01 && updated.length > 0);
  };

  const autoBalance = () => {
    if (shares.length === 0) return;
    const equalShare = Number((100 / shares.length).toFixed(2));
    const updated = shares.map((s, idx) => {
      // allocate remaining rounding cents to the first owner
      if (idx === 0) {
        return { ...s, share_pct: Number((100 - equalShare * (shares.length - 1)).toFixed(2)) };
      }
      return { ...s, share_pct: equalShare };
    });
    setShares(updated);
    onSharesChange(updated, true);
  };

  return (
    <div>
      <div className="card-h">
        <div>
          <h3>Owner shares</h3>
          <p>Survey area {totalAreaAcres || 0} acres · shares must total exactly 100.0%</p>
        </div>
        <button type="button" className="btn btn-s btn-sm" onClick={autoBalance} disabled={shares.length < 2}>Split equally</button>
      </div>

      {hasDeceased ? (
        <div className="al d" role="alert"><span className="i" /><div className="tx">A deceased owner is listed. Record the succession (mutation) before shares can be saved.</div></div>
      ) : !isExact100 ? (
        <div className="al w" role="status"><span className="i" /><div className="tx">
          {totalSharePct < 100 ? `Under-allocated by ${(100 - totalSharePct).toFixed(2)}%.` : `Over-allocated by ${(totalSharePct - 100).toFixed(2)}%.`} Shares must equal exactly 100.0%.
        </div></div>
      ) : null}

      <div className="sub">
        <table>
          <thead><tr><th>Landowner</th><th>CNIC</th><th>Tax status</th><th>Revenue document</th><th>Share %</th><th>≈ Acres</th><th aria-label="Remove" /></tr></thead>
          <tbody>
            {shares.length === 0 && <tr><td colSpan={7} className="empty">No owners yet. Add one below.</td></tr>}
            {shares.map((s, idx) => (
              <tr key={s.landowner_id}>
                <td>{s.landowner_name}{s.is_deceased && <> <span className="b b-d">Deceased</span></>}</td>
                <td className="mono">{s.cnic}</td>
                <td>{s.tax_status ? <span className={`b ${s.tax_status === 'Filer' ? 'b-g' : 'b-w'}`}>{s.tax_status}</span> : '—'}</td>
                <td><input type="text" aria-label={`Revenue document for ${s.landowner_name}`} placeholder="e.g. registered deed no."
                  value={s.revenue_doc_ref || ''} onChange={(e) => handleDocRefChange(idx, e.target.value)} /></td>
                <td><input type="number" step="0.01" min="0" max="100" aria-label={`Share for ${s.landowner_name}`}
                  value={s.share_pct} onChange={(e) => handleShareChange(idx, parseFloat(e.target.value))} /></td>
                <td className="num">{((Number(s.share_pct || 0) / 100) * totalAreaAcres).toFixed(3)}</td>
                <td><button type="button" className="bx" onClick={() => removeOwner(idx)} aria-label={`Remove ${s.landowner_name}`}>&times;</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="foot">
          <span className="area-in">
            <RecordPicker resource="/api/landowners" rowsKey="landowners" label="Landowner to add" value={selectedOwnerId}
              filters={{ province }} idOf={(l) => l.id}
              optionLabel={(lo) => `${lo.full_name} (${lo.cnic}) — ${lo.filer_status || lo.tax_status}${lo.is_deceased ? ' [deceased]' : ''}`}
              onChange={(id, lo) => { setSelectedOwnerId(id); setSelectedOwner(lo ?? null); setAddError(null); }} />
            <button type="button" className="addb" onClick={addOwner} disabled={!selectedOwnerId} aria-label="Add landowner">+</button>
          </span>
          <span>Total <span className={`b ${isExact100 && !hasDeceased ? 'b-g' : totalSharePct > 100 ? 'b-d' : 'b-w'}`}>{totalSharePct}% / 100%</span></span>
        </div>
      </div>
      {addError && <p className="u-danger u-mt-8" role="alert">{addError}</p>}
    </div>
  );
}
