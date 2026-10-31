// Provincial Land Administration & Financial Domain Rules

export const PROVINCES = {
  SND: {
    code: 'SND',
    name: 'Sindh',
    levels: ['District', 'Taluka', 'Deh'],
    cadastralKey: 'Survey No. & Block No.',
    // Client reference (slide 3); lms.province_unit is authoritative and flags it until confirmed.
    units: [
      { name: 'Acre', toSqft: 43560 },
      { name: 'Ghunta', toSqft: 1089 }, // 1/40 Acre
      { name: 'Square Feet', toSqft: 1 },
    ],
  },
  BAL: {
    code: 'BAL',
    name: 'Balochistan',
    levels: ['District', 'Sub-Division', 'Tehsil', 'Sub-Tehsil', 'Mouza'],
    cadastralKey: 'Khasra No.',
    units: [
      { name: 'Acre', toSqft: 43560 },
      { name: 'Rod', toSqft: 10890 }, // 1/4 Acre
      { name: 'Pole', toSqft: 272.25 }, // 1/160 Acre
      { name: 'Square Feet', toSqft: 1 },
    ],
  },
  PNJ: {
    code: 'PNJ',
    name: 'Punjab',
    levels: ['District', 'Tehsil', 'Qanungo Halka', 'Mouza'],
    cadastralKey: 'Khasra No.',
    units: [
      { name: 'Acre', toSqft: 43560 },
      { name: 'Kanal', toSqft: 5445 }, // 1/8 Acre
      { name: 'Marla', toSqft: 272.25 }, // 1/160 Acre or 1/20 Kanal
      { name: 'Square Feet', toSqft: 1 },
    ],
  },
  KPK: {
    code: 'KPK',
    name: 'Khyber Pakhtunkhwa',
    levels: ['District', 'Sub-Division', 'Tehsil', 'Mouza'],
    cadastralKey: 'Khasra No. (Rural) / Survey No. (Urban)',
    units: [
      { name: 'Acre', toSqft: 43560 },
      { name: 'Kanal', toSqft: 5445 }, // 1/8 Acre
      { name: 'Marla', toSqft: 272.25 }, // 1/160 Acre
      { name: 'Square Feet', toSqft: 1 },
    ],
  },
};

// 6-Tier Sequential Approval Stages aligned with lms.workflow_stage
export const WORKFLOW_STAGES = [
  { order: 1, key: 'Prepared', label: 'Field Initiation', requiredRole: 'Land Officer' },
  { order: 2, key: 'Checked', label: 'Negotiation Check', requiredRole: 'Negotiation Group' },
  { order: 3, key: 'Reviewed', label: 'Legal Clearance', requiredRole: 'Legal Advisor' },
  { order: 4, key: 'Verified', label: 'Field Admin Endorsement', requiredRole: 'Sr. Administrator LMS (Field)' },
  { order: 5, key: 'Field Approved', label: 'Field Approval (DM/TL)', requiredRole: 'DM / Team Lead (Field)' },
  { order: 6, key: 'HO Approved', label: 'Head Office Executive Approval', requiredRole: 'Manager Land (HO)' },
];

// Validate CNIC Format (XXXXX-XXXXXXX-X)
export function isValidCNIC(cnic: string): boolean {
  return /^[0-9]{5}-[0-9]{7}-[0-9]{1}$/.test(cnic.trim());
}

/** Format CNIC input as it is typed: keep digits only (at most 13) and put the
 * dashes in (12345-1234567-1), so the user only types the number. Pasted text
 * with or without dashes or spaces ends up the same. */
export function formatCNICInput(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 13);
  if (d.length <= 5) return d;
  if (d.length <= 12) return `${d.slice(0, 5)}-${d.slice(5)}`;
  return `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}`;
}

// Convert native land area to square feet. An unknown province or unit is an
// error, never silently Sindh or acres (UOM-19). Display helper only: stored
// areas are converted by PostgreSQL (lms.unit_conversion is the one source).
export function convertToSqft(amount: number, unitName: string, provinceCode: string): number {
  const prov = PROVINCES[provinceCode as keyof typeof PROVINCES];
  if (!prov) throw new Error(`Unknown province: ${provinceCode}`);
  const unit = prov.units.find(u => u.name.toLowerCase() === unitName.toLowerCase());
  if (!unit) throw new Error(`${unitName} is not a land unit of ${prov.name}`);
  return amount * unit.toSqft;
}

export function sqftToAcres(sqft: number): number {
  return Number((sqft / 43560).toFixed(4));
}

// Calculate FBR Withholding Tax (WHT)
export function calculateTax(
  grossAmount: number,
  filerStatus: 'Filer' | 'Non-Filer',
  transactionType: 'Compensation' | 'Purchase' | 'Lease' | 'Default' = 'Compensation'
) {
  let baseRate = 0.10;
  if (transactionType === 'Purchase') baseRate = 0.03;
  if (transactionType === 'Lease') baseRate = 0.15;
  if (transactionType === 'Default') baseRate = 0.075;

  const rate = filerStatus === 'Filer' ? baseRate : baseRate * 2;
  const taxAmount = Number((grossAmount * rate).toFixed(2));
  const netPayable = Number((grossAmount - taxAmount).toFixed(2));

  return {
    grossAmount,
    rate,
    ratePercent: `${(rate * 100).toFixed(rate === 0.075 ? 1 : 0)}%`,
    taxAmount,
    netPayable,
  };
}

// Format Pakistani Rupee currency
export function formatPKR(amount: number): string {
  if (amount == null || isNaN(amount)) return '—';   // unknown is not zero
  return `Rs. ${Number(amount).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`;
}

/**
 * A rupee amount in words, as a receipt states it (REQ-65):
 * 111250 → "One Hundred Eleven Thousand Two Hundred Fifty",
 * 90000.5 → "Ninety Thousand and Fifty Paisa". International grouping, as the
 * client's sample receipt uses. Callers add "Rupees … Only".
 */
export function amountInWords(amount: number | string): string {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return '';
  const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
    'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const below1000 = (x: number): string => {
    const h = Math.floor(x / 100), r = x % 100;
    const rest = r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? ` ${ONES[r % 10]}` : ''}`;
    return [h ? `${ONES[h]} Hundred` : '', rest].filter(Boolean).join(' ');
  };
  const SCALES: [number, string][] = [[1e12, 'Trillion'], [1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand'], [1, '']];
  const cents = Math.round(n * 100);
  let whole = Math.floor(cents / 100);
  const paisa = cents % 100;
  const parts: string[] = [];
  for (const [size, name] of SCALES) {
    const chunk = Math.floor(whole / size);
    if (chunk) { parts.push(`${below1000(chunk)}${name ? ` ${name}` : ''}`); whole -= chunk * size; }
  }
  const rupees = parts.length ? parts.join(' ') : 'Zero';
  return paisa ? `${rupees} and ${below1000(paisa)} Paisa` : rupees;
}

// 100.0% Co-ownership share balancer validator
export interface OwnerShareInput {
  landowner_id?: string;
  share_pct?: number | string;
  share_percent?: number | string;
}

export function validateCoOwnershipShares(shares: OwnerShareInput[]) {
  if (!Array.isArray(shares) || shares.length === 0) {
    return { isValid: false, total: 0, discrepancy: -100, error: 'At least one landowner share is required' };
  }

  let total = 0;
  for (const s of shares) {
    const pct = Number(s.share_pct ?? s.share_percent ?? 0);
    if (isNaN(pct) || pct < 0) {
      return { isValid: false, total: 0, discrepancy: -100, error: 'Negative or invalid share percentage specified' };
    }
    total += pct;
  }

  total = Number(total.toFixed(4));
  const discrepancy = Number((total - 100.0).toFixed(4));
  const isValid = Math.abs(discrepancy) < 0.001;

  let error = '';
  if (discrepancy < -0.001) {
    error = `Under-allocated: Shares sum to ${total}%, shortfall of ${Math.abs(discrepancy)}%`;
  } else if (discrepancy > 0.001) {
    error = `Over-allocated: Shares sum to ${total}%, excess of ${discrepancy}%`;
  }

  return { isValid, total, discrepancy, error };
}

// Canonical CNIC validation
export function validateCNIC(cnic: string | null | undefined): boolean {
  if (!cnic || typeof cnic !== 'string') return false;
  return /^[0-9]{5}-[0-9]{7}-[0-9]{1}$/.test(cnic.trim());
}

// Canonical Pakistan IBAN validation (PK + 2 check digits + 4 bank chars + 16 account chars = 24 chars)
export function validatePKRIBAN(iban: string | null | undefined): boolean {
  if (!iban || typeof iban !== 'string') return false;
  return /^PK[0-9]{2}[A-Z0-9]{20}$/.test(iban.trim().toUpperCase());
}

export type MeasurementUnit =
  | 'Acre'
  | 'Hectare'
  | 'Square Meter'
  | 'Square Feet'
  | 'Square Yard'
  | 'Sq Yard'
  | 'Ghunta'
  | 'Kanal'
  | 'Marla'
  | 'Rod'
  | 'Pole'
  | 'Bigha'
  | 'Jireb'
  | 'Murabba';

// Square feet per unit, from the exact definitions held in lms.unit_conversion
// (1 acre = 43,560 sq ft; 1 m² = 10.7639104167 sq ft). The database is the one
// source of factors; this table exists for display helpers and must agree with
// it. Jireb / Bigha are PROVISIONAL (awaiting Land Department confirmation).
export const SQFT_FACTORS: Record<string, number> = {
  'Acre': 43560,
  'Hectare': 10000 / 0.09290304,
  'Square Meter': 1 / 0.09290304,
  'Square Feet': 1,
  'Sq. Feet': 1,
  'Square Yard': 9,
  'Sq. Yards': 9,
  'Sq Yard': 9,
  'Ghunta': 1089,      // 1/40 Acre (Sindh)
  'Kanal': 5445,       // 1/8 Acre
  'Marla': 272.25,     // 1/160 Acre or 1/20 Kanal
  'Rod': 10890,        // 1/4 Acre (Balochistan)
  'Pole': 272.25,      // 1/160 Acre (Balochistan)
  'Bigha': 21780,      // provisional
  'Jireb': 21780,      // provisional
  'Jareeb': 21780,     // provisional
  'Murabba': 1089000,  // 25 Acres
};

/** Units whose factor the client has not confirmed. */
export const PROVISIONAL_UNITS = new Set(['Bigha', 'Jireb', 'Jareeb']);

function factorOf(unit: string): number {
  const f = SQFT_FACTORS[unit];
  if (f === undefined) throw new Error(`Unknown land unit: ${unit}`);
  return f;
}

export function toSqft(amount: number, unit: string): number {
  const f = factorOf(unit);
  if (!amount || isNaN(amount)) return 0;
  return amount * f;
}

export function fromSqft(sqft: number, unit: string): number {
  const f = factorOf(unit);
  if (!sqft || isNaN(sqft)) return 0;
  return Number((sqft / f).toFixed(4));
}

export function convertArea(amount: number, fromUnit: string, toUnit: string): number {
  const from = factorOf(fromUnit), to = factorOf(toUnit);
  if (amount === 0) return 0;
  return Number(((amount * from) / to).toFixed(4));
}

// FBR Tax calculation with boolean isFiler parameter
export function calculateFBRTax(
  grossAmount: number,
  isFiler: boolean,
  transactionType: 'Compensation' | 'Purchase' | 'Lease' | 'Default' = 'Compensation'
) {
  const status = isFiler ? 'Filer' : 'Non-Filer';
  const tax = calculateTax(grossAmount, status, transactionType);
  return {
    grossAmount: tax.grossAmount,
    taxRate: Number((tax.rate * 100).toFixed(1)),
    taxAmount: tax.taxAmount,
    netAmount: tax.netPayable,
  };
}

export const PROVINCIAL_HIERARCHIES = {
  SND: { name: 'Sindh', tiers: ['Division', 'District', 'Taluka', 'Tappa', 'Deh', 'Survey'] },
  BAL: { name: 'Balochistan', tiers: ['Division', 'District', 'Tehsil', 'Qanungo Circle', 'Patwar Circle', 'Mauza', 'Khasra'] },
  PNJ: { name: 'Punjab', tiers: ['Division', 'District', 'Tehsil', 'Qanungo Circle', 'Patwar Circle', 'Mauza', 'Khasra'] },
  KPK: { name: 'Khyber Pakhtunkhwa', tiers: ['Division', 'District', 'Tehsil', 'Qanungo Circle', 'Patwar Circle', 'Mauza', 'Khasra'] },
};
