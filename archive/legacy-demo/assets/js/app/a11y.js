/* Accessibility pass.

   The screens are generated markup, so rather than hand-edit hundreds of
   templates this runs after every render and fills what assistive
   technology needs from what the page already says:

   - a form control with no accessible name takes it from its field label,
     or, inside a table, from its column header and row (so a screen reader
     announces "Compensation case — Checked, Finance Officer" rather than
     "checkbox");
   - an icon-only button takes its name from its title or its action;
   - an empty table header gets screen-reader text;
   - a scrolling region with nothing focusable inside becomes focusable, so a
     keyboard user can scroll it;
   - anything with a data-act that is not natively interactive (a tab, a
     calendar entry, a table cell) becomes a focusable button that responds to
     Enter and Space.

   It also manages focus for dialogs: focus moves into a dialog when it
   opens, Tab stays inside it, and focus returns where it was on close. */
'use strict';

let _a11ySeq = 0;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), '
  + 'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const ACT_NAMES = {
  remind: 'Send reminder', openView: 'View record', openForm: 'Edit record',
  deleteRec: 'Delete record', closeModal: 'Close', docOpen: 'Open document',
  docRename: 'Rename document', docDelete: 'Delete document', subRowDelete: 'Remove row',
  openFollowUps: 'Follow-up Reminders & Schedule', toggleStickyDock: 'Sticky Notes',
  openA11yModal: 'Accessibility & Display Preferences', openShortcutsModal: 'Keyboard Shortcuts',
  exportICal: 'Export Schedule (.ics)',
};

function hasName(el) {
  if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.title) return true;
  if (el.closest('label')) return true;
  if (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) return true;
  return false;
}

function cellName(el) {
  const cell = el.closest('td, th');
  if (!cell) return '';
  const tr = cell.parentElement, table = cell.closest('table');
  const idx = [...tr.children].indexOf(cell);
  const headRow = table && table.querySelector('thead tr:last-child');
  const col = headRow && headRow.children[idx] ? headRow.children[idx].textContent.trim() : '';
  const first = tr.children[0];
  let row = first && first !== cell ? first.textContent.trim().replace(/\s+/g, ' ') : '';
  if (!row && tr.parentElement) row = 'Row ' + ([...tr.parentElement.children].indexOf(tr) + 1);
  return [row, col].filter(Boolean).join(' — ');
}

function labelControls(scope) {
  scope.querySelectorAll('input:not([type="hidden"]), select, textarea').forEach(el => {
    if (hasName(el)) return;
    // 1. the label of the form group it sits in
    const fg = el.closest('.fg');
    const lab = fg && fg.querySelector(':scope > label');
    const controls = fg ? fg.querySelectorAll('input:not([type="hidden"]), select, textarea') : [];
    if (lab && !lab.htmlFor && controls.length === 1) {
      if (!el.id) el.id = 'a11y-' + (++_a11ySeq);
      lab.htmlFor = el.id;
      return;
    }
    if (lab && controls.length > 1) {
      el.setAttribute('aria-label', lab.textContent.replace(/\*/g, '').trim());
      return;
    }
    // 2. a control inside a table: its row and column
    const name = cellName(el);
    if (name) { el.setAttribute('aria-label', name); return; }
    // 3. a filter: "All stages" -> "Filter: All stages"
    if (el.tagName === 'SELECT' && el.options.length) {
      el.setAttribute('aria-label', 'Filter: ' + el.options[0].text);
      return;
    }
    if (el.placeholder) el.setAttribute('aria-label', el.placeholder);
  });
}

function nameIconButtons(scope) {
  scope.querySelectorAll('button, a[href], [data-act]').forEach(el => {
    if (el.textContent.trim() || el.getAttribute('aria-label')) return;
    const name = el.title || ACT_NAMES[el.dataset.act] || '';
    if (name) el.setAttribute('aria-label', name);
  });
}

function fillEmptyHeaders(scope) {
  scope.querySelectorAll('th').forEach(th => {
    if (th.textContent.trim()) return;
    const sr = document.createElement('span');
    sr.className = 'sr-only';
    sr.textContent = 'Actions';
    th.appendChild(sr);
  });
}

function focusableScrollers(scope) {
  const used = new Set([...document.querySelectorAll('[role="region"][aria-label]')].map(e => e.getAttribute('aria-label')));
  scope.querySelectorAll('.tw, .sub, .mbody, [class*="u-mh-"]').forEach(el => {
    if (el.hasAttribute('tabindex')) return;
    if (el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1) return;
    if (el.querySelector(FOCUSABLE)) return;
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'region');
    const h = el.closest('.card') && el.closest('.card').querySelector('h3');
    let name = h ? h.textContent.trim() : 'Scrollable content', n = 2;
    const base = name;
    while (used.has(name)) name = base + ' (' + (n++) + ')';
    used.add(name);
    el.setAttribute('aria-label', name);
  });
}

/* a <div data-act> is clickable with a mouse but invisible to the keyboard */
function operableActions(scope) {
  scope.querySelectorAll('[data-act]').forEach(el => {
    if (/^(A|BUTTON|INPUT|SELECT|TEXTAREA|OPTION|LABEL)$/.test(el.tagName)) return;
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    if (!el.hasAttribute('role')) el.setAttribute('role', el.classList.contains('tab') ? 'tab' : 'button');
    if (el.classList.contains('tab')) el.setAttribute('aria-selected', String(el.classList.contains('active')));
  });
  scope.querySelectorAll('.tabs').forEach(t => t.setAttribute('role', 'tablist'));
}

function a11yPass(root) {
  const scope = root && root.querySelectorAll ? root : document;
  labelControls(scope);
  nameIconButtons(scope);
  fillEmptyHeaders(scope);
  operableActions(scope);
  focusableScrollers(scope);
}

/* Enter / Space on those elements behave like a click */
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target;
  if (!el.matches || !el.matches('[data-act][role="button"], [data-act][role="tab"]')) return;
  e.preventDefault();
  el.click();
});

/* ---- dialogs: move focus in, keep it in, give it back ------------- */
const _focusStack = [];

/* Remember the element that opened a dialog — and how to find it again,
   because saving usually re-renders the screen and replaces that element. */
function focusMemo(el) {
  if (!el || el === document.body) return null;
  const d = el.dataset || {};
  let sel = null;
  if (el.id) sel = '#' + CSS.escape(el.id);
  else if (d.act) sel = '[data-act="' + d.act + '"]'
    + (d.a1 !== undefined ? '[data-a1="' + CSS.escape(d.a1) + '"]' : '')
    + (d.a2 !== undefined ? '[data-a2="' + CSS.escape(d.a2) + '"]' : '');
  return { el, sel };
}
function restoreFocus(m) {
  let target = m && m.el && document.contains(m.el) ? m.el : null;
  if (!target && m && m.sel) target = document.querySelector(m.sel);
  // the trigger is gone for good: land at the start of the content, not the page
  if (!target) target = document.getElementById('content');
  if (target && typeof target.focus === 'function') target.focus({ preventScroll: !!(m && m.el === target) });
}

function topModal() {
  const open = ['dlg', 'conv', 'frm', 'view'].map(id => document.getElementById(id))
    .filter(m => m && !m.classList.contains('hidden'));
  return open[0] || null;   // listed top-most first
}

if (typeof openModal === 'function') {
  const _open = openModal, _close = closeModal;
  window.openModal = function (id) {
    _focusStack.push(focusMemo(document.activeElement));
    const out = _open.apply(this, arguments);
    const m = document.getElementById(id);
    if (m) {
      a11yPass(m);
      setTimeout(() => {
        // the dialog's own code may already have focused a field
        if (m.contains(document.activeElement)) return;
        const body = m.querySelector('.mbody');
        const first = (body && body.querySelector(FOCUSABLE)) || m.querySelector(FOCUSABLE);
        if (first) first.focus();
      }, 60);
    }
    return out;
  };
  window.closeModal = function (id) {
    const m = document.getElementById(id);
    const wasOpen = m && !m.classList.contains('hidden');
    const out = _close.apply(this, arguments);
    if (wasOpen) {
      // after the current task: a save closes the dialog and only then
      // re-renders the screen, replacing the element we want to return to
      const memo = _focusStack.pop();
      setTimeout(() => restoreFocus(memo), 0);
    }
    return out;
  };
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  const m = topModal();
  if (!m) return;
  const items = [...m.querySelectorAll(FOCUSABLE)].filter(x => x.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (!m.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

/* run after anything that writes markup */
['render', 'drawView', 'openForm', 'openConverter', 'renderForm', 'dialog'].forEach(name => {
  const orig = window[name];
  if (typeof orig !== 'function') return;
  window[name] = function () {
    const out = orig.apply(this, arguments);
    a11yPass();
    return out;
  };
});
