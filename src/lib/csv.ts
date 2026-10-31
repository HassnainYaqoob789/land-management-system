// One CSV cell, RFC 4180 quoted. A text cell that a spreadsheet would read as
// a formula (=, +, -, @, tab, carriage return) is prefixed with an apostrophe
// (OWASP "CSV injection"), so a landowner name like "=HYPERLINK(...)" stays
// text when Finance opens the export. Numbers are left as numbers.
const FORMULA = /^[=+\-@\t\r]/;

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '""';
  if (typeof v === 'number' || typeof v === 'bigint') return `"${String(v)}"`;
  let s = String(v);
  if (FORMULA.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export const csvRow = (cells: unknown[]) => cells.map(csvCell).join(',');
