/* Record forms: clearer validation and no silent data loss.

   The engine reports problems with a toast that disappears after a few
   seconds and a red border. Here, when Save is refused:
   - a summary at the top of the form lists every problem, each a link that
     jumps to its field;
   - every invalid field gets its own message underneath and is announced as
     invalid to screen readers (aria-invalid, aria-describedby);
   - focus moves to the first problem;
   - a message clears as soon as that field is filled in.

   Closing a form with unsaved changes (Cancel, the × button, Escape) now asks
   first. Ctrl+Enter / Cmd+Enter saves. Required fields are marked for
   assistive technology, not only with a red asterisk. */
'use strict';

let _formSnapshot = null;   // field values when the form was opened
let _formSaving = false;    // a successful save closes the form: don't ask then

const formBody = () => document.getElementById('fBody');

function formValues() {
  try { return JSON.stringify(readForm(true).vals); } catch (e) { return null; }
}
const formIsDirty = () => _formSnapshot !== null && formValues() !== _formSnapshot;

/* ---- presentation helpers ----------------------------------------- */
function clearFormErrors() {
  const body = formBody();
  if (!body) return;
  body.querySelectorAll('.fld-err, .form-errors').forEach(n => n.remove());
  body.querySelectorAll('[aria-invalid="true"]').forEach(n => {
    n.removeAttribute('aria-invalid');
    n.removeAttribute('aria-describedby');
  });
}

function fieldLabel(el) {
  const fg = el.closest('.fg');
  const lab = fg && fg.querySelector(':scope > label');
  return lab ? lab.textContent.replace(/\*/g, '').trim() : (el.getAttribute('aria-label') || 'This field');
}

function showFormErrors(messages) {
  const body = formBody();
  if (!body) return;
  clearFormErrors();
  const invalid = [...body.querySelectorAll('.err')];
  const items = [];

  invalid.forEach((el, i) => {
    const id = 'ferr-' + i;
    const msg = document.createElement('small');
    msg.className = 'fld-err';
    msg.id = id;
    msg.textContent = fieldLabel(el) + ' is required.';
    (el.closest('.fg') || el.parentElement).appendChild(msg);
    const target = el.matches('input, select, textarea') ? el : el.querySelector('input, select, textarea') || el;
    target.setAttribute('aria-invalid', 'true');
    target.setAttribute('aria-describedby', id);
    if (!target.id) target.id = 'ffld-' + i;
    items.push(`<li><a href="#${target.id}" data-focus="${target.id}">${esc(fieldLabel(el))}</a> is required</li>`);
  });
  // problems found by the module's own rules (e.g. "shares must total 100%")
  messages.filter(m => !invalid.length || !/^Please complete required fields/.test(m))
    .forEach(m => items.push('<li>' + esc(m) + '</li>'));
  if (!items.length) return;

  const box = document.createElement('div');
  box.className = 'form-errors';
  box.setAttribute('role', 'alert');
  box.tabIndex = -1;
  box.innerHTML = `<b>${items.length === 1 ? 'One thing needs' : items.length + ' things need'} attention before saving</b><ul>${items.join('')}</ul>`;
  body.prepend(box);

  const first = body.querySelector('[aria-invalid="true"]');
  (first || box).focus();
  if (first && first.scrollIntoView) first.scrollIntoView({ block: 'center' });
}

/* "Fields marked * are required" and aria-required on those fields */
function decorateForm() {
  const body = formBody();
  if (!body || body.querySelector('.form-legend')) return;
  let required = 0;
  body.querySelectorAll('.fg').forEach(fg => {
    const lab = fg.querySelector(':scope > label');
    if (!lab || !lab.querySelector('.req')) return;
    required++;
    fg.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]), select, textarea')
      .forEach(c => c.setAttribute('aria-required', 'true'));
  });
  if (required) {
    const p = document.createElement('p');
    p.className = 'form-legend';
    p.innerHTML = 'Fields marked <span class="req" aria-hidden="true">*</span> are required. '
      + '<span class="kbd-hint">Press <kbd>Ctrl</kbd>+<kbd>Enter</kbd> to save.</span>';
    body.prepend(p);
  }
}

/* ---- hook the engine ---------------------------------------------- */
const _saveForm = saveForm;
window.saveForm = function () {
  if (!CUR) return;
  // collect what the engine would toast, so it can be shown in place as well
  const shown = [];
  const _toast = window.toast;
  window.toast = function (msg, type) {
    if (type === 'error') shown.push(String(msg));
    return _toast.apply(this, arguments);
  };
  _formSaving = true;
  try { _saveForm.apply(this, arguments); }
  finally { window.toast = _toast; _formSaving = false; }

  const stillOpen = !document.getElementById('frm').classList.contains('hidden');
  if (stillOpen && shown.length) showFormErrors(shown);
  if (!stillOpen) { _formSnapshot = null; clearFormErrors(); }
};

['openForm', 'renderForm'].forEach(name => {
  const orig = window[name];
  if (typeof orig !== 'function') return;
  window[name] = function () {
    const out = orig.apply(this, arguments);
    decorateForm();
    if (name === 'openForm' && !document.getElementById('frm').classList.contains('hidden')) {
      _formSnapshot = formValues();
    }
    return out;
  };
});

/* closing with unsaved changes asks first */
const _closeModalForms = closeModal;
window.closeModal = function (id) {
  if (id === 'frm' && !_formSaving && formIsDirty()) {
    confirmBox('Discard changes?', 'You have unsaved changes in this form. Close it and lose them?', 'Discard', true)
      .then(ok => { if (ok) { _formSnapshot = null; _closeModalForms('frm'); } });
    return;
  }
  if (id === 'frm') _formSnapshot = null;
  return _closeModalForms.apply(this, arguments);
};

/* a field's message clears as soon as it is filled in */
document.addEventListener('input', e => clearOne(e.target));
document.addEventListener('change', e => clearOne(e.target));
function clearOne(el) {
  if (!el || el.getAttribute('aria-invalid') !== 'true') return;
  if (el.value === '' || el.value == null) return;
  const msg = document.getElementById(el.getAttribute('aria-describedby'));
  if (msg) msg.remove();
  el.removeAttribute('aria-invalid');
  el.removeAttribute('aria-describedby');
  el.classList.remove('err');
  const holder = el.closest('.err');
  if (holder) holder.classList.remove('err');
}

/* links in the error summary move focus to the field */
document.addEventListener('click', e => {
  const a = e.target.closest('.form-errors a[data-focus]');
  if (!a) return;
  e.preventDefault();
  const f = document.getElementById(a.dataset.focus);
  if (f) { f.focus(); f.scrollIntoView({ block: 'center' }); }
});

/* Ctrl/Cmd + Enter saves the open form */
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
  if (document.getElementById('frm').classList.contains('hidden')) return;
  e.preventDefault();
  window.saveForm();
});
