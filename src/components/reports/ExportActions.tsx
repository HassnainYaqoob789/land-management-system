'use client';

// PDF / Excel / CSV downloads and Print. All four are rendered by the server
// from the same engine output as the screen, with the applied filters, scope
// and unit in their header. The caller renders this only when the catalogue
// says the viewer may export (reports:export); the server refuses otherwise.

import React, { useState } from 'react';
import type { ExportFormat, ReportConfig } from '@/lib/reporting/types';
import { exportReport, printReport } from './client';

const LABEL: Record<ExportFormat, string> = { pdf: 'PDF', xlsx: 'Excel', csv: 'CSV', html: 'Print' };

export default function ExportActions({ config, title, preferred, limits, total }: {
  config: ReportConfig | null; title: string; preferred?: ExportFormat | null;
  limits?: Partial<Record<ExportFormat, number>>; total?: number;
}) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const run = async (format: ExportFormat) => {
    if (!config) return;
    setBusy(format); setMsg(null);
    try {
      if (format === 'html') await printReport(config, title);
      else setMsg({ kind: 'ok', text: `Downloaded ${await exportReport(config, format, title)}.` });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally { setBusy(null); }
  };

  const over = (f: ExportFormat) => total !== undefined && limits?.[f] !== undefined && total > (limits[f] as number);
  return (
    <>
      {(['pdf', 'xlsx', 'csv', 'html'] as ExportFormat[]).map((f) => (
        <button key={f} type="button" className={`btn ${preferred === f ? 'btn-p' : 'btn-s'} btn-sm`} disabled={!config || busy !== null}
          aria-busy={busy === f}
          title={over(f) ? `This report has more rows than ${LABEL[f]} allows (${limits![f]!.toLocaleString('en-PK')}); add filters first` : undefined}
          onClick={() => run(f)}>
          {busy === f ? (f === 'html' ? 'Preparing…' : `Preparing ${LABEL[f]}…`) : LABEL[f]}
        </button>
      ))}
      {msg && (
        <span className={msg.kind === 'err' ? 'u-danger' : 'note'} role={msg.kind === 'err' ? 'alert' : 'status'} style={{ flexBasis: '100%', fontSize: 12 }}>
          {msg.text}
        </span>
      )}
    </>
  );
}
