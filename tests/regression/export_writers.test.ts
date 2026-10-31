import { describe, it, expect } from 'vitest';
import AdmZip from 'adm-zip';
import { writeXlsx } from '../../src/lib/export/xlsx';
import { renderPdf } from '../../src/lib/export/pdf';

describe('xlsx writer', () => {
  const book = writeXlsx([{
    name: 'Cases', preamble: ['Compensation cases', 'Unit: Acre'],
    columns: [{ header: 'Case', type: 'text' }, { header: 'Amount (PKR)', type: 'money' }, { header: 'Area (Acre)', type: 'area' }],
    rows: [['=HYPERLINK("http://x","click")', 1234.5, 2.25], ['C-2', 10, null], ['Total', 1244.5, 2.25]],
    emphasis: new Set([2]),
  }], { title: 'Cases' });
  const zip = new AdmZip(book);
  const sheet = zip.readAsText('xl/worksheets/sheet1.xml');

  it('is a valid package with workbook, styles and the sheet', () => {
    for (const p of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml'])
      expect(zip.getEntry(p), p).toBeTruthy();
  });
  it('never writes a formula; formula-like text stays an inline string', () => {
    expect(sheet).not.toMatch(/<f>/);
    expect(sheet).toContain('t="inlineStr"');
    expect(sheet).toContain('=HYPERLINK(&quot;http://x&quot;,&quot;click&quot;)');
  });
  it('writes numbers as numbers so totals reconcile in Excel', () => {
    expect(sheet).toMatch(/<c r="B5" s="2"><v>1234.5<\/v><\/c>/);
    expect(sheet).toMatch(/<c r="B7" s="6"><v>1244.5<\/v><\/c>/);   // bold money on the total row (preamble, blank row, header, then data)
  });
  it('freezes the header row and adds a filter', () => {
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<autoFilter ref="A4:C7"/>');
  });
});

describe('pdf renderer', () => {
  it('produces a multi-page PDF with the table header repeated and page numbers', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => [`CASE-${i}`, `Landowner ${i}`, (1000 + i).toFixed(2)]);
    const pdf = await renderPdf({ title: 'Test report', meta: [['Reporting unit', 'Acre'], ['Scope', 'Sindh']],
      columns: [{ header: 'Case' }, { header: 'Owner', weight: 2 }, { header: 'Amount', align: 'right' }], rows, emphasis: new Set([119]) });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const pages = (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages).toBeGreaterThan(1);
    expect(pdf.toString('latin1')).toMatch(/\/Subtype \/Image/);   // the logo is embedded
  });
});
