// A small, dependency-light .xlsx writer (Office Open XML SpreadsheetML,
// zipped with adm-zip, which the project already uses for KMZ).
//
// Why not a library: the exports need only one or a few sheets of typed cells,
// and writing them directly keeps every cell's type under our control —
// numbers are numbers (so totals reconcile in Excel), and text is always an
// inline string, never a formula, so a landowner named "=HYPERLINK(...)"
// cannot execute (spreadsheet formula injection is impossible by construction:
// this writer never emits a <f> element).
import AdmZip from 'adm-zip';

export type XlsxCell = string | number | null | undefined | Date;
export interface XlsxColumn { header: string; type?: 'text' | 'number' | 'money' | 'area' | 'date' | 'integer'; width?: number }
export interface XlsxSheet {
  name: string;
  /** Lines printed above the table (title, scope, filters, unit, generated-at). */
  preamble?: string[];
  columns: XlsxColumn[];
  rows: XlsxCell[][];
  /** Rows (by index into `rows`) to render bold: subtotals and the grand total. */
  emphasis?: Set<number>;
  footer?: string[];
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
  // XML 1.0 forbids most control characters; drop them rather than corrupt the file.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Excel stores dates as days since 1899-12-30 (the 1900 leap-year bug included).
const excelDate = (d: Date) => (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 86_400_000;

// Style indexes into styles.xml below.
const S = { text: 0, bold: 1, money: 2, area: 3, date: 4, int: 5, boldMoney: 6, boldArea: 7, header: 8, boldInt: 9, title: 10 };

// An exact decimal string (money and areas arrive from PostgreSQL as text) is
// written into a numeric column verbatim: no JS float conversion on the way.
const DECIMAL = /^-?\d{1,18}(\.\d{1,12})?$/;
const NUMERIC_TYPES = new Set<XlsxColumn['type']>(['number', 'money', 'area', 'integer']);

function cellXml(ref: string, v: XlsxCell, type: XlsxColumn['type'], bold: boolean): string {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) return `<c r="${ref}" s="${S.date}"><v>${excelDate(v)}</v></c>`;
  if ((typeof v === 'number' && Number.isFinite(v) && type !== 'text') || (typeof v === 'string' && NUMERIC_TYPES.has(type) && DECIMAL.test(v))) {
    const s = type === 'money' ? (bold ? S.boldMoney : S.money) : type === 'area' ? (bold ? S.boldArea : S.area)
      : type === 'integer' ? (bold ? S.boldInt : S.int) : (bold ? S.bold : S.text);
    return `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr" s="${bold ? S.bold : S.text}"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
}

function sheetXml(sh: XlsxSheet): string {
  const out: string[] = [];
  let r = 0;
  const row = (cells: string) => { r++; out.push(`<row r="${r}">${cells}</row>`); };
  for (const line of sh.preamble ?? []) row(`<c r="A${r + 1}" t="inlineStr" s="${r === 0 ? S.title : S.text}"><is><t xml:space="preserve">${esc(line)}</t></is></c>`);
  if (sh.preamble?.length) row('');
  const headerRow = r + 1;
  row(sh.columns.map((c, i) => `<c r="${colName(i)}${r + 1}" t="inlineStr" s="${S.header}"><is><t xml:space="preserve">${esc(c.header)}</t></is></c>`).join(''));
  sh.rows.forEach((cells, k) => {
    const bold = !!sh.emphasis?.has(k);
    row(sh.columns.map((c, i) => cellXml(`${colName(i)}${r + 1}`, cells[i], c.type, bold)).join(''));
  });
  for (const line of sh.footer ?? []) row(`<c r="A${r + 1}" t="inlineStr" s="${S.text}"><is><t xml:space="preserve">${esc(line)}</t></is></c>`);
  const cols = sh.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? Math.min(48, Math.max(10, c.header.length + 4))}" customWidth="1"/>`).join('');
  const last = `${colName(Math.max(0, sh.columns.length - 1))}${headerRow + sh.rows.length}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${cols}</cols><sheetData>${out.join('')}</sheetData>
${sh.rows.length ? `<autoFilter ref="A${headerRow}:${last}"/>` : ''}
<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="#,##0.0000"/></numFmts>
<fonts count="3"><font><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="13"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF6"/></patternFill></fill></fills>
<borders count="2"><border/><border><bottom style="thin"><color rgb="FF9AA8BA"/></bottom></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="11">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="165" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="3" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
</styleSheet>`;

/** Build an .xlsx workbook. Sheet names are trimmed to Excel's 31-character limit. */
export function writeXlsx(sheets: XlsxSheet[], meta: { title?: string; author?: string } = {}): Buffer {
  const zip = new AdmZip();
  const names = sheets.map((s, i) => (s.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `Sheet${i + 1}`));
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`));
  zip.addFile('docProps/core.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${esc(meta.title ?? '')}</dc:title><dc:creator>${esc(meta.author ?? 'Mari Energies LMS')}</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
</cp:coreProperties>`));
  zip.addFile('xl/workbook.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`));
  zip.addFile('xl/styles.xml', Buffer.from(STYLES));
  sheets.forEach((s, i) => zip.addFile(`xl/worksheets/sheet${i + 1}.xml`, Buffer.from(sheetXml(s))));
  return zip.toBuffer();
}
