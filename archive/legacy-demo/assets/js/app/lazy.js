/* Lazy vendor loading.

   The single-file build parsed 1.5 MB of libraries on every screen. Here
   each page loads only the core app, and the heavy libraries arrive the
   first time something actually needs them:

     XLSX  (639 KB) — on the first Excel export
     jsPDF (402 KB) — on the first PDF export

   Chart.js is loaded up front by the two dashboard pages, and Leaflet and
   JSZip by the GIS page, because those screens draw with them immediately. */
'use strict';

const VENDOR = assetUrl('js/vendor/');   // ROOT-relative: pages live in subdirectories
const _scripts = {};

function loadScript(src) {
  if (_scripts[src]) return _scripts[src];
  return _scripts[src] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => { delete _scripts[src]; reject(new Error('Could not load ' + src)); };
    document.head.appendChild(s);
  });
}

const ensureXLSX = () => typeof XLSX !== 'undefined'
  ? Promise.resolve()
  : loadScript(VENDOR + 'xlsx.full.min.js');

const ensurePDF = () => (window.jspdf && window.jspdf.jsPDF)
  ? Promise.resolve()
  : loadScript(VENDOR + 'jspdf.umd.min.js').then(() => loadScript(VENDOR + 'jspdf.plugin.autotable.js'));

/* ---- wrap the two export helpers so callers need not know ---------- */
const _exportXLSX = exportXLSX;
const _exportPDF = exportPDF;

function _deferExport(ensure, fn, args, label) {
  const ready = ensure();
  let pending = true;
  // only nag the user if the library really has to come off disk
  setTimeout(() => { if (pending) toast('Preparing ' + label + '…', 'info'); }, 150);
  ready.then(() => fn.apply(null, args))
    .catch(e => toast(label + ' unavailable: ' + e.message, 'error'))
    .finally(() => { pending = false; });
}

window.exportXLSX = function () { _deferExport(ensureXLSX, _exportXLSX, arguments, 'Excel export'); };
window.exportPDF = function () { _deferExport(ensurePDF, _exportPDF, arguments, 'PDF export'); };

/* ---- charts degrade instead of throwing --------------------------- */
const _mkChart = typeof mkChart === 'function' ? mkChart : null;
if (_mkChart) {
  window.mkChart = function (id) {
    if (typeof Chart === 'undefined') {
      const el = document.getElementById(id);
      if (el && el.parentElement) {
        el.parentElement.innerHTML = '<p class="note u-ta-center u-mt-16">Chart library not loaded on this page.</p>';
      }
      return null;
    }
    return _mkChart.apply(null, arguments);
  };
}
