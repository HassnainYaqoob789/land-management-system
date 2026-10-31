// Printing one official document (award sheet, lease deed, statement …)
// instead of the page behind it (UX-03). The document is built in a container
// that is a direct child of <body>; while it prints, everything else on the
// page — the register, an open modal — is hidden by src/styles/print-document.css.
// Layout: the Mari Energies letterhead (logo, organisation, department), title,
// subtitle, a key/value block, generated-at and printed-by, the caller's body,
// and a footer with the confidentiality marking, "Developed by Alisons
// Technology" and "Page n of N" (CSS page counters in the @page margin boxes).
//
// Callers build `bodyHtml` from escaped text (escapeHtml below). As a second
// line of defence the body is sanitised here: scripts, frames, forms, event
// handlers, inline styles and non-http(s) links are removed before it is used.

export interface PrintOptions {
  title: string;
  subtitle?: string;
  meta?: [string, string][];
  bodyHtml: string;
  classification?: string;
}

const ORG = 'Mari Energies Limited';
const DEPARTMENT = 'Land Management Department';
const CREDIT = 'Developed by Alisons Technology';
const LOGO = '/images/mari-energies-logo.png';
const ROOT_ID = 'lms-print-root';
const PAGE_STYLE_ID = 'lms-print-page';
const HTML_CLASS = 'lms-print-doc';

/** Text → HTML text, safe in element content and in quoted attribute values. */
export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]!));
}

/** Text → a CSS string literal (for the @page margin boxes). */
function cssString(s: string): string {
  return `"${s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

let identity: { user: string } | null = null;
/** Who is signed in, for the "Printed by" line (set by the Shell). */
export function setPrintIdentity(v: { user: string } | null): void { identity = v; }

// ---- sanitising the caller's body -------------------------------------------------
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE',
  'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'OPTION', 'SVG', 'MATH', 'TEMPLATE', 'NOSCRIPT', 'AUDIO', 'VIDEO', 'SOURCE']);
const KEEP_ATTR = new Set(['class', 'colspan', 'rowspan', 'scope', 'dir', 'lang', 'title', 'alt', 'width', 'height', 'href', 'src', 'headers', 'abbr']);
const SAFE_URL = /^(https?:|\/(?!\/)|#|data:image\/(png|jpeg|gif);base64,)/i;

/** Parse `html` without running anything, keep only harmless markup. */
export function sanitizeHtml(html: string): DocumentFragment {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;   // template content is inert: no scripts run, nothing loads
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.COMMENT_NODE) { child.remove(); continue; }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as Element;
      if (DROP.has(el.tagName.toUpperCase())) { el.remove(); continue; }
      for (const a of Array.from(el.attributes)) {
        const name = a.name.toLowerCase();
        if (!KEEP_ATTR.has(name)) { el.removeAttribute(a.name); continue; }
        if ((name === 'href' || name === 'src') && !SAFE_URL.test(a.value.trim())) el.removeAttribute(a.name);
      }
      walk(el);
    }
  };
  walk(tpl.content);
  return tpl.content;
}

/** A table whose first row is all <th> gets it as a <thead>, so it repeats on every printed page. */
function repeatHeaders(root: ParentNode) {
  for (const table of Array.from(root.querySelectorAll('table'))) {
    if (table.tHead) continue;
    const first = table.rows[0];
    if (first && first.cells.length && Array.from(first.cells).every((c) => c.tagName === 'TH')) {
      const thead = table.createTHead();
      thead.appendChild(first);
    }
  }
}

// ---- lifecycle --------------------------------------------------------------------
let ours = false;          // the print in progress is a document we started
let listening = false;

function cleanup() {
  document.getElementById(ROOT_ID)?.remove();
  document.getElementById(PAGE_STYLE_ID)?.remove();
  document.documentElement.classList.remove(HTML_CLASS);
  ours = false;
}

function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener('afterprint', () => { if (ours) cleanup(); });
  // A later Ctrl+P of the page itself must never print a stale document.
  window.addEventListener('beforeprint', () => { if (!ours) cleanup(); });
}

const stamp = (d: Date) => d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Print exactly this document, on the Mari Energies letterhead. */
export function printDocument(opts: PrintOptions): void {
  if (typeof window === 'undefined') return;
  listen();
  cleanup();
  const classification = (opts.classification || 'Confidential').slice(0, 60);
  const now = new Date();
  const e = escapeHtml;

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.className = 'pd';
  root.setAttribute('aria-hidden', 'true');   // print-only: never shown or read on screen
  const meta = (opts.meta ?? []).filter(([k]) => k);
  root.innerHTML = `
    <header class="pd-head">
      <img class="pd-logo" src="${LOGO}" alt="Mari Energies" width="56" height="56">
      <div class="pd-org"><b>${e(ORG)}</b><span>${e(DEPARTMENT)}</span></div>
      <div class="pd-class">${e(classification)}</div>
    </header>
    <h1 class="pd-title">${e(opts.title)}</h1>
    ${opts.subtitle ? `<p class="pd-sub">${e(opts.subtitle)}</p>` : ''}
    ${meta.length ? `<dl class="pd-meta">${meta.map(([k, v]) => `<div><dt>${e(k)}</dt><dd>${e(v)}</dd></div>`).join('')}</dl>` : ''}
    <p class="pd-gen">Generated ${e(stamp(now))}${identity?.user ? ` · Printed by ${e(identity.user)}` : ''}</p>
    <div class="pd-body"></div>
    <footer class="pd-foot"><span>${e(classification)} · ${e(ORG)}</span><span>${e(CREDIT)}</span></footer>`;
  const body = root.querySelector('.pd-body')!;
  body.appendChild(sanitizeHtml(opts.bodyHtml));
  repeatHeaders(body);
  document.body.appendChild(root);

  // Running page footer: classification, credit and page numbers in the margin boxes.
  const style = document.createElement('style');
  style.id = PAGE_STYLE_ID;
  style.textContent = `@page { size: A4; margin: 14mm 12mm 16mm;
    @bottom-left { content: ${cssString(`${classification} · ${ORG}`)}; font: 8pt Arial, sans-serif; color: #444; }
    @bottom-center { content: ${cssString(CREDIT)}; font: 7.5pt Arial, sans-serif; color: #555; }
    @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt Arial, sans-serif; color: #444; } }`;
  document.head.appendChild(style);
  document.documentElement.classList.add(HTML_CLASS);

  // Print once the logo is ready (or after a short wait), so it is on the page.
  const img = root.querySelector<HTMLImageElement>('.pd-logo');
  const ready = img && !img.complete
    ? Promise.race([img.decode().catch(() => undefined), new Promise((r) => setTimeout(r, 1500))])
    : Promise.resolve();
  ready.then(() => {
    ours = true;
    window.print();
  });
}
