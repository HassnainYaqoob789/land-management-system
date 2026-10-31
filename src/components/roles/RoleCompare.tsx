'use client';

// Two roles side by side: every permission either grants, at which scope, and
// how they differ.

import React, { useState } from 'react';
import { Table, Field } from '@/components/legacy/ui';
import { compareRoles, scopeLabel, type CompareKind } from './model';
import type { RoleSummary } from './types';

const KIND: Record<CompareKind, [string, string]> = {
  same: ['b-g', 'same'], scope: ['b-w', 'different scope'], only_a: ['b-i', 'only in the first'], only_b: ['b-p', 'only in the second'],
};

export default function RoleCompare({ roles }: { roles: RoleSummary[] }) {
  const [a, setA] = useState(roles[0]?.code ?? '');
  const [b, setB] = useState(roles[1]?.code ?? '');
  const [diffOnly, setDiffOnly] = useState(true);
  const ra = roles.find((r) => r.code === a), rb = roles.find((r) => r.code === b);
  const result = ra && rb ? compareRoles(ra.permissions, rb.permissions) : null;
  const rows = result ? result.rows.filter((r) => !diffOnly || r.kind !== 'same') : [];

  const pick = (id: string, label: string, value: string, set: (v: string) => void) => (
    <Field label={label} htmlFor={id}>
      <select id={id} value={value} onChange={(e) => set(e.target.value)}>
        {roles.map((r) => <option key={r.code} value={r.code}>{r.name} ({r.code})</option>)}
      </select>
    </Field>
  );

  return (
    <>
      <div className="fgrid u-mb-10">
        {pick('cmpA', 'First role', a, setA)}
        {pick('cmpB', 'Second role', b, setB)}
      </div>
      {ra && rb && (<>
        <div className="bar">
          <span className="note">Tier {ra.tier_name ?? ra.db_role_code} vs {rb.tier_name ?? rb.db_role_code} ·
            {' '}{result!.counts.same} same · {result!.counts.scope} different scope · {result!.counts.only_a} only in the first · {result!.counts.only_b} only in the second</span>
          <span className="grow" />
          <label className="note" htmlFor="cmpDiff"><input id="cmpDiff" type="checkbox" checked={diffOnly} onChange={(e) => setDiffOnly(e.target.checked)} /> Differences only</label>
        </div>
        <Table caption="Role comparison" head={<><th>Permission</th><th>{ra.name}</th><th>{rb.name}</th><th>Difference</th></>}
          empty={rows.length ? false : a === b ? 'Choose two different roles.' : 'The two roles grant the same permissions at the same scopes.'} colSpan={4}>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="mono">{r.key}</td>
              <td>{r.a ? scopeLabel(r.a) : <span className="note">—</span>}</td>
              <td>{r.b ? scopeLabel(r.b) : <span className="note">—</span>}</td>
              <td><span className={`b ${KIND[r.kind][0]}`}>{KIND[r.kind][1]}</span></td>
            </tr>
          ))}
        </Table>
      </>)}
    </>
  );
}
