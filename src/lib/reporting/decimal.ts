// Exact decimals as strings. Money and areas come from PostgreSQL numeric as
// text and are only ever rounded and formatted here, never turned into JS
// floats (0.1 + 0.2 must not reach a ledger).

const DEC = /^-?\d+(\.\d+)?$/;

export const isDecimal = (v: unknown): v is string => typeof v === 'string' && DEC.test(v);

/** A user-supplied number (decimal string, or a finite number without exponent) as a canonical decimal string; null if not one. */
export function toDecimal(v: unknown, maxDp = 6): string | null {
  let s: string;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    s = String(v);
    if (/e/i.test(s)) return null;
  } else if (typeof v === 'string') s = v.trim();
  else return null;
  if (!DEC.test(s)) return null;
  const [int, frac = ''] = s.replace('-', '').split('.');
  if (int.length > 18 || frac.length > maxDp) return null;
  return s;
}

/** Round half away from zero (as PostgreSQL round()) to dp places. */
export function roundDecimal(s: string, dp: number): string {
  if (!DEC.test(s)) throw new Error(`not a decimal: ${s}`);
  const neg = s.startsWith('-');
  const [int, frac = ''] = (neg ? s.slice(1) : s).split('.');
  const digits = BigInt(int + (frac + '0'.repeat(dp + 1)).slice(0, dp + 1));
  let q = digits / 10n;
  if (digits % 10n >= 5n) q += 1n;
  const t = q.toString().padStart(dp + 1, '0');
  const out = dp ? `${t.slice(0, -dp)}.${t.slice(-dp)}` : t;
  return neg && /[1-9]/.test(out) ? `-${out}` : out;
}

/** "1234567.5" -> "1,234,567.50". Non-decimals are returned as text; null-ish as an em dash. */
export function formatDecimal(v: unknown, dp = 2, group = true): string {
  if (v === null || v === undefined || v === '') return '—';
  const s = typeof v === 'number' && Number.isFinite(v) && !/e/i.test(String(v)) ? String(v) : v;
  if (!isDecimal(s)) return String(v);
  const r = roundDecimal(s, dp);
  const neg = r.startsWith('-');
  const [int, frac] = (neg ? r.slice(1) : r).split('.');
  const g = group ? int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : int;
  return `${neg ? '-' : ''}${g}${frac !== undefined ? `.${frac}` : ''}`;
}

/** Sign of a decimal string: -1, 0 or 1. */
export function signOf(s: string): -1 | 0 | 1 {
  if (!DEC.test(s) || !/[1-9]/.test(s)) return 0;
  return s.startsWith('-') ? -1 : 1;
}
