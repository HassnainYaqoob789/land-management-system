// Renders one ReportResult (run unpaged) as PDF, Excel, CSV or a print-ready
// HTML page. Every format carries the same rows, subtotals and totals, plus
// the organisation, title, reference, generation time and user, scope,
// filters, unit mode, flag explanations and a confidentiality marking; the
// PDF and HTML number their pages. Money is formatted from exact decimal
// strings (no floats); CSV and Excel carry plain numbers (DSP-20).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { csvRow } from '../csv';
import { renderPdf, type PdfColumn } from '../export/pdf';
import { writeXlsx, type XlsxColumn } from '../export/xlsx';
import { formatDecimal } from './decimal';
import { FLAG_TEXT, type ColumnOut, type ExportFormat, type ReportResult, type RowOut } from './types';

export const ORGANISATION = 'Mari Energies Limited';
export const DEPARTMENT = 'Land Management';

export interface ExportHeader {
  title: string;
  reference: string;
  generatedBy: string;
  generatedAt: Date;
}

const SHORT_FLAG: Record<string, string> = {
  provisional_factor: 'provisional factor', unsupported_unit: 'no factor', missing_area: 'area missing',
  recorded_unit_unknown: 'unit not kept', province_unit_unapproved: 'unit proposed', shares_not_100: 'shares ≠ 100%',
  unattributed_payment: 'unattributed', overpaid: 'over-paid', unallocated_payment: 'unallocated',
  area_over_committed: 'over-committed', recorded_provisional: 'provisional acres', no_shares: 'no share',
  possible_duplicate: 'possible duplicate', mixed_units: 'mixed units',
};

const trimZeros = (s: string) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s);
const pkt = (d: Date) => `${new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d).replace(',', '')} PKT`;

/** Display text of one cell. */
export function cellText(col: ColumnOut, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  switch (col.type) {
    case 'money': return formatDecimal(v, 2);
    case 'area': return formatDecimal(v, 4);
    case 'integer': return formatDecimal(v, 0);
    case 'percent': return `${trimZeros(formatDecimal(v, 4))}%`;
    case 'number': return trimZeros(formatDecimal(v, 6));
    case 'boolean': return v === true ? 'Yes' : v === false ? 'No' : String(v);
    default: return String(v);
  }
}

/** The table every format prints: headers, rows of cells, which rows are totals. */
function table(r: ReportResult) {
  const unitCol = r.columns.some((c) => c.type === 'area' && !c.unit);
  const flagCol = r.rows.some((x) => x.flags?.length);
  const firstAgg = !!r.columns[0]?.aggregate;
  const cols: { key: string; header: string; col?: ColumnOut }[] = [];
  if (firstAgg) cols.push({ key: '_label', header: '' });
  let unitPlaced = false;
  for (const c of r.columns) {
    const unit = c.type === 'area' && c.unit ? ` (${c.unit})` : c.type === 'money' ? ' (PKR)' : '';
    cols.push({ key: c.key, header: `${c.label}${unit}`, col: c });
    if (unitCol && !unitPlaced && c.type === 'area' && !c.unit) { cols.push({ key: '_unit', header: 'Unit' }); unitPlaced = true; }
  }
  if (flagCol) cols.push({ key: '_flags', header: 'Flags' });
  const groupKeys = r.columns.filter((c) => !c.aggregate).map((c) => c.key);
  const label = (x: RowOut): string | null => {
    const n = typeof x.cells._rows === 'number' ? ` (${x.cells._rows.toLocaleString('en-PK')} records)` : '';
    if (x.kind === 'total') return `Total${n}`;
    if (x.kind === 'subtotal') return `Subtotal${n}`;
    return null;
  };
  return { cols, unitCol, flagCol, firstAgg, groupKeys, label };
}

type Cell = { text: string; raw: string | number | null };
function rowCells(r: ReportResult, t: ReturnType<typeof table>, x: RowOut): Cell[] {
  const lbl = t.label(x);
  // A total row's label goes into the first column that holds no total.
  const labelKey = t.firstAgg ? '_label' : r.columns[0]?.key;
  let lastGroupIdx = -1;
  if (x.kind === 'subtotal') r.columns.forEach((c, i) => { if (!c.aggregate && x.cells[c.key] !== null && x.cells[c.key] !== undefined) lastGroupIdx = i; });
  return t.cols.map((tc) => {
    if (tc.key === '_label') return { text: lbl ?? '', raw: lbl };
    if (tc.key === '_unit') return { text: x.unit ?? (x.kind === 'detail' ? '' : '—'), raw: x.unit ?? null };
    if (tc.key === '_flags') { const f = (x.flags ?? []).map((k) => SHORT_FLAG[k] ?? k).join('; '); return { text: f, raw: f || null }; }
    const c = tc.col!;
    const v = x.cells[c.key];
    let text = cellText(c, v);
    let raw: string | number | null = v === null || v === undefined ? null : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : (v as string | number);
    if (lbl && x.kind === 'subtotal' && lastGroupIdx >= 0 && r.columns[lastGroupIdx].key === c.key) { text = `${text} — ${lbl.toLowerCase()}`; raw = text; }
    else if (lbl && c.key === labelKey && (x.kind === 'total' || lastGroupIdx < 0) && (v === null || v === undefined)) { text = lbl; raw = lbl; }
    return { text, raw };
  });
}

/** The printed table as text: headers and one array of cell texts per row (legacy JSON consumers). */
export function textTable(r: ReportResult): { headers: string[]; rows: string[][]; kinds: RowOut['kind'][] } {
  const t = table(r);
  return { headers: t.cols.map((c) => c.header), rows: r.rows.map((x) => rowCells(r, t, x).map((c) => c.text)), kinds: r.rows.map((x) => x.kind) };
}

function preamble(r: ReportResult, h: ExportHeader): [string, string][] {
  const units = r.meta.uom.provinceUnits?.length
    ? r.meta.uom.provinceUnits.map((u) => `${u.province}${u.landClass ? ` ${u.landClass}` : ''}: ${u.unit}${u.approved ? '' : ' (proposed)'}`).join(', ')
    : '';
  const mode = r.meta.uom.mode === 'common' ? `Converted to ${r.meta.uom.unit}` : r.meta.uom.mode === 'original' ? 'As recorded' : 'Province reporting units';
  return [
    ['Reference', h.reference],
    ['Generated', `${pkt(h.generatedAt)} by ${h.generatedBy}`],
    ['Scope', r.meta.scope],
    ['Filters', r.meta.filtersApplied.length ? r.meta.filtersApplied.join('; ') : 'None'],
    ['Unit of measure', units ? `${mode} — ${units}` : mode],
    ['Records', r.page.total.toLocaleString('en-PK')],
    ['Personal data', r.meta.piiMasked ? 'CNICs masked' : r.columns.some((c) => c.sensitive) ? 'Shown in full (authorised)' : 'None shown'],
  ];
}

function notes(r: ReportResult): string[] {
  const out: string[] = [];
  for (const [k, n] of Object.entries(r.flags)) out.push(`${SHORT_FLAG[k] ?? k} — ${FLAG_TEXT[k] ?? k}: ${n.toLocaleString('en-PK')} record(s)`);
  if (r.meta.mixedUnits) out.push('Rows are in different units, so there is no grand total of area; totals per unit:');
  for (const u of r.unitTotals ?? []) {
    const parts = r.columns.filter((c) => c.aggregate && u.cells[c.key] !== null && u.cells[c.key] !== undefined)
      .map((c) => `${c.label} ${cellText(c, u.cells[c.key])}${c.type === 'money' ? ' PKR' : ''}`);
    out.push(`  ${u.unit}: ${u.rows.toLocaleString('en-PK')} record(s)${parts.length ? ` — ${parts.join(', ')}` : ''}`);
  }
  out.push(...r.meta.definitions);
  return out;
}

export function classification(r: ReportResult): string {
  const pii = r.columns.some((c) => c.sensitive) && !r.meta.piiMasked;
  return `CONFIDENTIAL — ${ORGANISATION} internal use${pii ? ' · contains personal data (CNIC)' : ''}`;
}

export function toCsv(r: ReportResult, h: ExportHeader): Buffer {
  const t = table(r);
  const lines = [
    csvRow([`${ORGANISATION} — ${DEPARTMENT}`]), csvRow([h.title]),
    ...preamble(r, h).map(([k, v]) => csvRow([k, v])), '',
    csvRow(t.cols.map((c) => c.header)),
    // Numbers stay plain numeric text ("-1234.50"), so a spreadsheet reads them as numbers.
    ...r.rows.map((x) => csvRow(rowCells(r, t, x).map((c) => c.raw ?? ''))),
    '', ...notes(r).map((n) => csvRow([n])), csvRow([classification(r)]),
  ];
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
}

export function toXlsx(r: ReportResult, h: ExportHeader): Buffer {
  const t = table(r);
  const xtype = (c?: ColumnOut): XlsxColumn['type'] =>
    !c ? 'text' : c.type === 'money' ? 'money' : c.type === 'area' ? 'area' : c.type === 'integer' ? 'integer' : c.type === 'number' || c.type === 'percent' ? 'number' : 'text';
  const emphasis = new Set<number>();
  r.rows.forEach((x, i) => { if (x.kind !== 'detail') emphasis.add(i); });
  return writeXlsx([{
    name: h.title,
    preamble: [`${ORGANISATION} — ${DEPARTMENT}: ${h.title}`, ...preamble(r, h).map(([k, v]) => `${k}: ${v}`)],
    columns: t.cols.map((c) => ({ header: c.header, type: xtype(c.col) })),
    rows: r.rows.map((x) => rowCells(r, t, x).map((c) => c.raw)),
    emphasis,
    footer: ['', ...notes(r), classification(r)],
  }], { title: h.title, author: ORGANISATION });
}

export function toPdf(r: ReportResult, h: ExportHeader): Promise<Buffer> {
  const t = table(r);
  const columns: PdfColumn[] = t.cols.map((c) => ({
    header: c.header,
    align: c.col && ['money', 'area', 'integer', 'number', 'percent'].includes(c.col.type) ? 'right' : 'left',
    weight: !c.col ? 0.8 : c.col.type === 'text' ? 1.8 : c.col.type === 'money' ? 1.25 : 1,
  }));
  const emphasis = new Set<number>();
  r.rows.forEach((x, i) => { if (x.kind !== 'detail') emphasis.add(i); });
  return renderPdf({
    title: h.title, subtitle: r.meta.grain ? `One row per ${r.meta.grain.replace(/^one row per /, '')}` : undefined,
    meta: preamble(r, h), columns, rows: r.rows.map((x) => rowCells(r, t, x).map((c) => c.text)), emphasis,
    notes: notes(r), classification: classification(r), organisation: ORGANISATION, department: DEPARTMENT,
  });
}

let logo: string | null | undefined;
function logoDataUri(): string | null {
  if (logo !== undefined) return logo;
  try { logo = `data:image/png;base64,${readFileSync(join(process.cwd(), 'public', 'images', 'mari-energies-logo.png')).toString('base64')}`; } catch { logo = null; }
  return logo;
}
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** A self-contained print view: logo inlined, no scripts, header row repeated on every printed page, page numbers. */
export function toHtml(r: ReportResult, h: ExportHeader): Buffer {
  const t = table(r);
  const num = (c?: ColumnOut) => !!c && ['money', 'area', 'integer', 'number', 'percent'].includes(c.type);
  const img = logoDataUri();
  const body = r.rows.map((x) => {
    const cls = x.kind === 'detail' ? '' : ` class="${x.kind}"`;
    return `<tr${cls}>${rowCells(r, t, x).map((c, i) => `<td${num(t.cols[i].col) ? ' class="n"' : ''}>${escapeHtml(c.text)}</td>`).join('')}</tr>`;
  }).join('\n');
  const doc = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(h.title)} — ${ORGANISATION}</title>
<style>
@page { size: A4 landscape; margin: 14mm 10mm 16mm;
  @bottom-left { content: "${escapeHtml(classification(r)).replace(/"/g, '\\"')}"; font: 8px sans-serif; color: #555; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8px sans-serif; color: #555; } }
body { font: 11px/1.35 "Segoe UI", Arial, sans-serif; color: #111; margin: 0; padding: 16px; background: #fff; }
header { display: flex; gap: 12px; align-items: center; border-bottom: 1px solid #9aa8ba; padding-bottom: 8px; margin-bottom: 8px; }
header img { height: 46px; } h1 { font-size: 16px; margin: 2px 0 0; } .org { color: #0b3b6e; font-weight: 700; font-size: 14px; }
.dept { color: #333; font-size: 10px; } dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; margin: 8px 0 10px; font-size: 10px; }
dt { color: #555; font-weight: 600; } dd { margin: 0; }
table { border-collapse: collapse; width: 100%; font-size: 10px; } thead { display: table-header-group; }
th { background: #e8eef6; text-align: left; padding: 4px; border-bottom: 1px solid #9aa8ba; } td { padding: 3px 4px; border-bottom: 1px solid #eef1f5; vertical-align: top; }
td.n, th.n { text-align: right; white-space: nowrap; } tr { page-break-inside: avoid; } tr.subtotal td { font-weight: 600; border-top: 1px solid #777; }
tr.total td { font-weight: 700; border-top: 2px solid #333; } .notes { margin-top: 10px; font-size: 10px; } .notes li { margin: 2px 0; }
footer { margin-top: 12px; font-size: 9px; color: #555; border-top: 1px solid #ccc; padding-top: 4px; }
@media print { body { padding: 0; } footer { position: fixed; bottom: 0; left: 0; right: 0; } }
</style></head><body>
<header>${img ? `<img src="${img}" alt="Mari Energies">` : ''}<div><div class="org">${ORGANISATION}</div><div class="dept">${DEPARTMENT} · Land Management System</div><h1>${escapeHtml(h.title)}</h1></div></header>
<dl>${preamble(r, h).map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>
<table><thead><tr>${t.cols.map((c) => `<th${num(c.col) ? ' class="n"' : ''}>${escapeHtml(c.header)}</th>`).join('')}</tr></thead>
<tbody>
${body || `<tr><td colspan="${t.cols.length}">No records match this report.</td></tr>`}
</tbody></table>
<ul class="notes">${notes(r).map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>
<footer>${escapeHtml(classification(r))} · Generated ${escapeHtml(pkt(h.generatedAt))} · ${escapeHtml(h.reference)}</footer>
</body></html>`;
  return Buffer.from(doc, 'utf8');
}

export const MIME: Record<ExportFormat, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
  html: 'text/html; charset=utf-8',
};

export async function renderExport(format: ExportFormat, r: ReportResult, h: ExportHeader): Promise<Buffer> {
  switch (format) {
    case 'pdf': return toPdf(r, h);
    case 'xlsx': return toXlsx(r, h);
    case 'csv': return toCsv(r, h);
    case 'html': return toHtml(r, h);
  }
}

/** A filename safe for Content-Disposition. */
export function exportFileName(title: string, reference: string, format: ExportFormat): string {
  const base = title.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'report';
  return `${base}_${reference.replace(/[^A-Za-z0-9-]/g, '')}.${format}`;
}
