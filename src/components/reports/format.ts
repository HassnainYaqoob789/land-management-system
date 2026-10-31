// Display helpers for the reports screen. Values arrive from the engine as
// exact decimal strings and are only rounded here (same rules as the server's
// exports, src/lib/reporting/render.ts cellText, so screen and file agree).
import { formatDecimal } from '@/lib/reporting/decimal';
import { FLAG_TEXT, type Aggregate, type ColumnOut, type FieldInfo, type FieldType, type FilterOp, type RowOut } from '@/lib/reporting/types';

const trimZeros = (s: string) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s);

export const NUMERIC_TYPES: FieldType[] = ['integer', 'number', 'money', 'area', 'percent'];
export const isNumeric = (t: FieldType) => NUMERIC_TYPES.includes(t);

/** Text of one cell, as the exports print it. */
export function cellText(col: Pick<ColumnOut, 'type'>, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  try {
    switch (col.type) {
      case 'money': return formatDecimal(v, 2);
      case 'area': return formatDecimal(v, 4);
      case 'integer': return formatDecimal(v, 0);
      case 'percent': return `${trimZeros(formatDecimal(v, 4))}%`;
      case 'number': return trimZeros(formatDecimal(v, 6));
      case 'boolean': return v === true ? 'Yes' : v === false ? 'No' : String(v);
      default: return String(v);
    }
  } catch {
    return String(v);   // not a decimal the formatter knows: show it as sent rather than hide it
  }
}

/** Header text: the unit of a common-unit area column, PKR for money. */
export function headerText(c: ColumnOut): string {
  if (c.type === 'area' && c.unit) return `${c.label} (${c.unit})`;
  if (c.type === 'money') return `${c.label} (PKR)`;
  return c.label;
}

export const SHORT_FLAG: Record<string, string> = {
  provisional_factor: 'provisional factor', unsupported_unit: 'no factor', missing_area: 'area missing',
  recorded_unit_unknown: 'unit not kept', province_unit_unapproved: 'unit proposed', shares_not_100: 'shares ≠ 100%',
  unattributed_payment: 'unattributed', overpaid: 'over-paid', unallocated_payment: 'unallocated',
  area_over_committed: 'over-committed', recorded_provisional: 'provisional acres', no_shares: 'no share',
  possible_duplicate: 'possible duplicate', mixed_units: 'mixed units',
};
export const flagShort = (k: string) => SHORT_FLAG[k] ?? k.replace(/_/g, ' ');
export const flagLong = (k: string, text?: Record<string, string>) => text?.[k] ?? FLAG_TEXT[k] ?? k.replace(/_/g, ' ');

export const OP_LABEL: Record<FilterOp, string> = {
  eq: 'is', neq: 'is not', in: 'is any of', contains: 'contains', starts: 'starts with',
  gte: 'at least', lte: 'at most', between: 'between', is_null: 'is empty', not_null: 'is not empty',
};
export const AGG_LABEL: Record<Aggregate, string> = { sum: 'Sum', count: 'Count', avg: 'Average', min: 'Minimum', max: 'Maximum' };

export const opNeedsValue = (op: FilterOp) => op !== 'is_null' && op !== 'not_null';

/** The label a subtotal / total row carries, e.g. "Subtotal (12 records)". */
export function rowLabel(x: RowOut): string | null {
  const n = typeof x.cells._rows === 'number' ? ` (${x.cells._rows.toLocaleString('en-PK')} record${x.cells._rows === 1 ? '' : 's'})` : '';
  if (x.kind === 'total') return `Total${n}`;
  if (x.kind === 'subtotal') return `Subtotal${n}`;
  return null;
}

/** A blank filter value of the right shape for an operator. */
export function blankValue(f: FieldInfo, op: FilterOp): unknown {
  if (!opNeedsValue(op)) return undefined;
  if (op === 'in') return [];
  if (op === 'between') return ['', ''];
  if (f.type === 'boolean') return true;
  return '';
}

/** Is a filter value complete enough to send? (The server validates it fully.) */
export function valueComplete(op: FilterOp, v: unknown): boolean {
  if (!opNeedsValue(op)) return true;
  if (op === 'in') return Array.isArray(v) && v.length > 0;
  if (op === 'between') return Array.isArray(v) && v.length === 2 && v.every((x) => String(x ?? '').trim() !== '');
  if (typeof v === 'boolean') return true;
  return String(v ?? '').trim() !== '';
}

export const fmtWhen = (iso?: string) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d)} PKT`;
};

/** "paid_net_amount" / "otherPayments" → "Paid net amount" / "Other payments". */
export const humanize = (k: string) => {
  const s = k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  return (s.charAt(0).toUpperCase() + s.slice(1)).replace(/\b(cnic|iban|wht|pkr)\b/gi, (m) => m.toUpperCase());
};

/** Only same-site paths become links (a drill-down href is a path such as /cases?q=…; never another site). */
export const safeHref = (h: unknown): string | null => (typeof h === 'string' && /^\/(?![\/\\])/.test(h) ? h : null);
