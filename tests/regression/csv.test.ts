import { describe, it, expect } from 'vitest';
import { csvCell, csvRow } from '../../src/lib/csv';

describe('CSV export cells', () => {
  it('quotes and doubles embedded quotes', () => {
    expect(csvCell('He said "no"')).toBe('"He said ""no"""');
    expect(csvCell(null)).toBe('""');
    expect(csvRow(['a', 1, 'b,c'])).toBe('"a","1","b,c"');
  });
  it('neutralises spreadsheet formulas (CSV injection)', () => {
    for (const f of ['=HYPERLINK("http://x")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1']) expect(csvCell(f).startsWith(`"'`), f).toBe(true);
  });
  it('leaves numbers, including negative ones, as numbers', () => {
    expect(csvCell(-25)).toBe('"-25"');
    expect(csvCell('-25.50')).toBe('"-25.50"');
    expect(csvCell('Plain text')).toBe('"Plain text"');
  });
});
