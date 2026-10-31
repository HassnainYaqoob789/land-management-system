// Field-level protection of personal data (findings UI-04, RPT-05, DSP-01,
// AUTHZ-09). Seeing a landowner is landowners:read; seeing their national ID,
// phone, bank account and home address in full is pii:read. Every API response
// that carries those fields passes through redact() (or redactRow()), which
// masks them for a caller without pii:read for the record's province. Masked
// values keep the last four characters so a person can still be told apart.
//
// Masked values contain MASK, which no real CNIC, phone or IBAN does, so a
// form that echoes a masked value back is recognised (guardPiiWrite) and never
// overwrites the real value.

import { HttpError } from './http';

export const MASK = '•';

/** The structural part of a request context this module needs. */
export interface PiiCtx {
  has(resource: string, action: string): boolean;
  can?(resource: string, action: string, rec?: { province?: string | null; project?: string | null; assignedTo?: string | null }): boolean;
}

/** Response keys that always carry personal data. */
export const PII_FIELDS = [
  'cnic', 'phone', 'mobile', 'iban', 'address',
  'complainant_cnic', 'complainant_phone', 'complainant_mobile', 'complainant_address',
  'acknowledged_cnic', 'received_by_cnic', 'landowner_cnic', 'owner_cnic', 'payee_cnic',
  'lessor_cnic', 'heir_cnic', 'transferor_cnic', 'party_cnic',
  'home_address', 'postal_address', 'mailing_address',
] as const;

const EXACT = new Set<string>(PII_FIELDS);
type Kind = 'cnic' | 'phone' | 'iban' | 'address';

/** What kind of personal data a key carries, or null. `ip_address` and similar staff/system fields are not PII here. */
export function piiKind(key: string): Kind | null {
  const k = key.toLowerCase();
  if (!EXACT.has(k) && !/_(cnic|phone|mobile|iban)$/.test(k)) return null;
  if (k.endsWith('cnic')) return 'cnic';
  if (k.endsWith('phone') || k.endsWith('mobile')) return 'phone';
  if (k.endsWith('iban')) return 'iban';
  return 'address';
}

/** Mask every letter and digit except the last `keep`; separators stay, so the format is still recognisable. */
function keepLast(v: string, keep: number): string {
  const total = (v.match(/[A-Za-z0-9]/g) || []).length;
  const k = total > keep * 2 ? keep : 0;   // a value too short to keep anything is masked whole
  let seen = 0;
  return v.replace(/[A-Za-z0-9]/g, (c) => (++seen > total - k ? c : MASK));
}

const blank = (v: unknown) => v === null || v === undefined || v === '';
const empty = (v: unknown): string | null => (v === '' ? '' : null);
export function maskCnic(v: unknown): string | null { return blank(v) ? empty(v) : keepLast(String(v), 4); }
export function maskPhone(v: unknown): string | null { return blank(v) ? empty(v) : keepLast(String(v), 4); }
export function maskIban(v: unknown): string | null { return blank(v) ? empty(v) : keepLast(String(v), 4); }
/** An address has no meaningful tail to keep. */
export function maskAddress(v: unknown): string | null { return blank(v) ? empty(v) : MASK.repeat(6); }

const MASKERS: Record<Kind, (v: unknown) => string | null> = { cnic: maskCnic, phone: maskPhone, iban: maskIban, address: maskAddress };

/** True when a value is (or contains) a masked rendering. */
export function isMasked(v: unknown): boolean { return typeof v === 'string' && v.includes(MASK); }

/** May this caller see personal data in full, for a record in `province` (any province when omitted)? */
export function canSeePii(ctx: PiiCtx, province?: string | null): boolean {
  if (province && ctx.can) return ctx.can('pii', 'read', { province });
  return ctx.has('pii', 'read');
}

// A CNIC typed into free text (remarks, descriptions, validation messages).
const CNIC_IN_TEXT = /\b\d{5}-\d{7}-\d\b/g;
const HAS_CNIC = /\b\d{5}-\d{7}-\d\b/;

/** Mask the named fields of one row unless the caller may see them. Returns a copy. */
export function redactRow<T extends Record<string, any>>(row: T, fields: readonly string[], ctx: PiiCtx): T {
  if (!row || typeof row !== 'object') return row;
  if (canSeePii(ctx, row.province_code ?? null)) return row;
  const out: Record<string, any> = { ...row };
  for (const f of fields) {
    if (f in out && !blank(out[f])) out[f] = (MASKERS[piiKind(f) ?? 'cnic'])(out[f]);
  }
  return out as T;
}

/** Every string or number under a PII key (e.g. an audit diff {from, to}) is masked the same way. */
function maskLeaves(v: unknown, mask: (x: unknown) => string | null): unknown {
  if (Array.isArray(v)) return v.map((x) => maskLeaves(x, mask));
  if (v && typeof v === 'object' && !(v instanceof Date)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskLeaves(x, mask)]));
  return typeof v === 'string' || typeof v === 'number' ? mask(v) : v;
}

/**
 * Mask personal data anywhere in a response body: every key piiKind()
 * recognises, nested rows and arrays (audit diffs, import rows, statements),
 * and CNICs written into free text. A row's province_code, or its nearest
 * ancestor's, decides; a caller with pii:read there gets the value unchanged.
 */
export function redact<T>(value: T, ctx: PiiCtx, province: string | null = null): T {
  if (Array.isArray(value)) return value.map((v) => redact(v, ctx, province)) as unknown as T;
  if (!value || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value)) return value;
  const obj = value as Record<string, any>;
  const prov = typeof obj.province_code === 'string' ? obj.province_code : province;
  const allowed = canSeePii(ctx, prov);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    const kind = piiKind(k);
    if (kind && (typeof v === 'string' || typeof v === 'number')) out[k] = allowed ? v : MASKERS[kind](v);
    else if (kind && v && typeof v === 'object' && !allowed) out[k] = maskLeaves(v, MASKERS[kind]);
    else if (v && typeof v === 'object') out[k] = redact(v, ctx, prov);
    else if (typeof v === 'string' && !allowed && HAS_CNIC.test(v)) out[k] = v.replace(CNIC_IN_TEXT, (m) => maskCnic(m) as string);
    else out[k] = v;
  }
  return out as T;
}

/**
 * Before writing a record: drop personal-data fields the client merely echoed
 * back masked (an edit form prefilled from a masked response), and refuse a
 * real change from a caller who may not see the current value.
 */
export function guardPiiWrite(body: Record<string, any>, ctx: PiiCtx, fields: readonly string[], province?: string | null): void {
  for (const f of fields) {
    if (!(f in body) || body[f] === undefined) continue;
    if (isMasked(body[f])) { delete body[f]; continue; }
    if (!canSeePii(ctx, province ?? null))
      throw new HttpError(403, 'Changing CNIC, phone, bank account or address needs permission to see personal data.', 'forbidden');
  }
}
