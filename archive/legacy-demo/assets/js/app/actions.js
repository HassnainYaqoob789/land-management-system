/* Delegated event dispatcher.

   The markup carries no behaviour of its own — an interactive element
   declares what it does with data-act="<action>" plus data-a1…a3 for
   arguments, and this file routes the event to the matching function in
   ACTION_FNS (see registry.js). Nothing is ever resolved from a string of
   code at runtime, so the pages run under a Content-Security-Policy that
   forbids inline and eval'd script.

   Supported modifiers:
     data-a1 / a2 / a3  positional arguments
     data-aj            a JSON argument (parsed, never eval'd)
     data-num="1,2"     which of those arguments are numbers
     data-src="checked" read the control's state rather than its value
     data-close="view"  close that modal first
     data-stop="1"      stop the event from bubbling
     data-href="…"      destination for the "navigate" action
     data-enter="…"     action to run when Enter is pressed in a field
*/
'use strict';

/* The element that triggered the action currently running. Actions that
   need the control's own value (a select, a file input) read it from here. */
let ACT_EL = null;

function runAction(el, ev) {
  const name = el.dataset.act;
  const fns = window.ACTION_FNS || (typeof ACTION_FNS !== 'undefined' ? ACTION_FNS : {});
  const fn = fns[name] || (window.LMS_ACTIONS && window.LMS_ACTIONS[name]) || window[name];
  if (typeof fn !== 'function') { console.warn('LMS: unknown action "%s"', name); return; }

  if (el.dataset.stop) ev.stopPropagation();
  if (el.dataset.close) closeModal(el.dataset.close);

  const nums = (el.dataset.num || '').split(',');
  const args = [];
  for (let i = 1; i <= 3; i++) {
    const key = 'a' + i;
    if (!(key in el.dataset)) break;
    const raw = el.dataset[key];
    args.push(nums.includes(String(i)) ? +raw : raw);
  }
  if (el.dataset.aj) {
    try { args.push(JSON.parse(el.dataset.aj)); }
    catch (e) { console.warn('LMS: bad data-aj', e); return; }
  }

  ACT_EL = el;
  try { fn.apply(null, args); }
  catch (e) { console.error(e); toast('Action failed: ' + e.message, 'error'); }
  finally { ACT_EL = null; }
}

/* ---- delegation --------------------------------------------------- */
document.addEventListener('click', e => {
  // let the browser handle new-tab / new-window clicks on real links
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  const el = e.target.closest('[data-act]');
  if (!el) return;
  // form controls act on change/input, not click, or the control would
  // never get to toggle itself
  if (/^(INPUT|SELECT|TEXTAREA|OPTION)$/.test(el.tagName)) return;
  if (el.getAttribute('aria-disabled') === 'true' || el.disabled) return;
  e.preventDefault();
  runAction(el, e);
});

document.addEventListener('change', e => {
  const el = e.target.closest('[data-act]');
  if (!el || !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
  if (el.type === 'search' || el.classList.contains('search')) return;  // handled on input
  runAction(el, e);
});

document.addEventListener('input', e => {
  const el = e.target.closest('[data-act="listSearch"]');
  if (el) runAction(el, e);
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const el = e.target.closest('[data-enter]');
  if (!el) return;
  e.preventDefault();
  const fn = ACTION_FNS[el.dataset.enter];
  if (typeof fn === 'function') fn();
});

/* =====================================================================
   Actions introduced by the multi-page build
   ===================================================================== */

/* follow a data-href (used where the control is a button, not a link) */
function navigate() {
  const href = ACT_EL && ACT_EL.dataset.href;
  if (href) location.href = href;
}

function printPage() { window.print(); }

/* --- list search: debounced, and keeps the caret where it was ------- */
let _searchTimer = null;
function listSearch(coll) {
  const el = ACT_EL;
  UI.q[coll] = el.value;
  if (UI.page) UI.page[coll] = 0;
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => {
    render();
    const s = document.querySelector('.search');
    if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  }, 250);
}

/* --- filter / paging state ----------------------------------------- */
const _val = () => ACT_EL.dataset.src === 'checked' ? ACT_EL.checked : ACT_EL.value;

function setStage(coll) { UI.stage[coll] = ACT_EL.value; render(); }
function setPage(coll, n) { UI.page = UI.page || {}; UI.page[coll] = +n; render(); window.scrollTo(0, 0); }
function setViewTab(tab) { if (VIEW) { VIEW.tab = tab; drawView(); } }
function setReportFilter(k) { UI.rf[k] = ACT_EL.value; render(); }
function setAuditFilter(k) { UI.af = Object.assign(UI.af || {}, { [k]: _val() }); render(); }
function setDocFilter(k) { UI.df = Object.assign(UI.df || {}, { [k]: _val() }); render(); }
function setProjectPick() { UI.pd = ACT_EL.value; render(); }
function setCalMonth(y, m) {
  UI.calM = (y === undefined || y === '') ? null : new Date(+y, +m, 1).toISOString();
  render();
}

/* --- reports -------------------------------------------------------- */
function pickReport(id) {
  UI.reportId = id;
  UI._rbLoaded = null;
  if (!/^(rb|sv_)/.test(id)) UI.rf = {};
  render();
}
function rbColl() {
  UI.rb = { coll: ACT_EL.value, cols: null, q: '', st: '', from: '', to: '', gb: '', name: '' };
  render();
}
function setRbFilter(k) { UI.rb[k] = ACT_EL.value; render(); }

/* --- data upload ---------------------------------------------------- */
function setImportColl() { UI.impColl = ACT_EL.value; IMPST = null; render(); }
function resetImport() { IMPST = null; render(); }

/* --- file pickers --------------------------------------------------- */
function attachPick(coll, id) { attachFiles(coll, id, ACT_EL.files); }
function restorePick() { if (ACT_EL.files[0]) restoreJSON(ACT_EL.files[0]); }
function gisPick() { const el = ACT_EL; if (el.files[0]) gisUpload(el.files[0]); el.value = ''; }

/* --- misc ----------------------------------------------------------- */
function subRowDelete() {
  const tr = ACT_EL.closest('tr');
  if (tr) tr.remove();
  formCompute();
}

function auditExport() {
  exportXLSX('Audit trail',
    ['When', 'User', 'Role', 'Module', 'Record', 'Action', 'Note', 'Changes'],
    S.audit.map(a => [a.at, a.user, a.role, a.coll, a.code, a.action, a.note,
      (a.changes || []).map(c => c.f + ': ' + JSON.stringify(c.from ?? '') + ' -> ' + JSON.stringify(c.to ?? '')).join(' | ')]));
}

/* =====================================================================
   Post-render passes — things the generated markup declares but cannot
   do for itself without inline style or inline script.
   ===================================================================== */

/* record-dependent colours arrive as data-* and become CSS custom
   properties here, so no element ever carries a style attribute */
function applyDynamic(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-bg]').forEach(el => {
    el.style.setProperty('--bg-dyn', el.dataset.bg);
    el.classList.add('has-bg');
  });
  scope.querySelectorAll('[data-accent]').forEach(el => {
    el.style.setProperty('--accent-dyn', el.dataset.accent);
    el.classList.add('has-accent-color');
  });
  scope.querySelectorAll('[data-accent-full]').forEach(el => {
    el.style.setProperty('--accent-dyn', el.dataset.accentFull);
    el.classList.add('has-accent');
  });
  scope.querySelectorAll('[data-color]').forEach(el => {
    if (!el.dataset.color) return;
    el.style.setProperty('--color-dyn', el.dataset.color);
    el.classList.add('has-color');
  });
  scope.querySelectorAll('[data-minw]').forEach(el => {
    if (!el.dataset.minw) return;
    el.style.setProperty('--minw-dyn', el.dataset.minw);
    el.classList.add('has-minw');
  });
}

/* drag & drop on an attachment dropzone */
function attachDropzone(root) {
  (root || document).querySelectorAll('[data-dropzone]').forEach(z => {
    if (z._wired) return;
    z._wired = true;
    z.addEventListener('dragover', e => { e.preventDefault(); z.classList.add('over'); });
    z.addEventListener('dragleave', () => z.classList.remove('over'));
    z.addEventListener('drop', e => {
      e.preventDefault();
      z.classList.remove('over');
      const t = z.querySelector('[data-drop-coll]') || z;
      const coll = t.dataset.dropColl || z.dataset.dropColl;
      const id = t.dataset.dropId || z.dataset.dropId;
      if (coll && id) attachFiles(coll, id, e.dataTransfer.files);
    });
  });
}

function afterRender(root) { applyDynamic(root); attachDropzone(root); }

/* Run those passes after anything that writes markup. Wrapping keeps the
   generated screen code untouched. */
['render', 'drawView', 'openForm', 'openConverter', 'drawDashboard', 'drawProjDash'].forEach(name => {
  const orig = window[name];
  if (typeof orig !== 'function') return;
  window[name] = function () {
    const out = orig.apply(this, arguments);
    afterRender();
    return out;
  };
});
