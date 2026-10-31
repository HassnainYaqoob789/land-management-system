/* The application shell.

   Every page ships the same static skeleton (sidebar, topbar, breadcrumb
   bar, content, footer, modals). This file fills in the parts that depend
   on who is signed in and which screen is open, and wires the topbar.
   Because there is exactly one implementation, the navigation cannot drift
   between pages. */
'use strict';

const NAV_ICONS = {
  dashboard: 'dash', projdash: 'target', inbox: 'bell', calendar: 'cal', gis: 'pin',
  units: 'bank', projects: 'rig', surveys: 'map', landowners: 'user',
  acquisitions: 'clip', cases: 'doc', leases: 'cal', rows: 'route', encroachments: 'warn',
  mutations: 'repeat', legal: 'scale', payments: 'wallet', dbpfc: 'bldg', budgets: 'trend',
  grievances: 'mega', reports: 'calc', documents: 'folder', import: 'down', audit: 'receipt',
  users: 'lock', matrix: 'compass', settings: 'gear', arch: 'layers'
};

function buildNav() {
  const hide = { users: !can.admin(), settings: !can.admin(), import: !can.create() };
  const nav = $('#nav');
  if (!nav) return;

  nav.innerHTML = NAV.map(([group, items]) => {
    const links = items.filter(([k]) => !hide[k]).map(([k, icon, label]) => {
      const current = k === SCREEN;
      const iconHtml = (typeof svgIcon === 'function' && NAV_ICONS[k]) ? svgIcon(NAV_ICONS[k]) : '';
      return `<a class="nav-i${current ? ' active' : ''}" href="${pageUrl(k)}" data-k="${k}"`
        + `${current ? ' aria-current="page"' : ''}>`
        + `<span class="ic" aria-hidden="true">${iconHtml}</span>${esc(label)}`
        + (k === 'inbox' ? '<span class="cnt hidden" id="navCnt"></span>' : '')
        + `</a>`;
    }).join('');
    return `<div class="nav-t">${esc(group)}</div>${links}`;
  }).join('');
}

const SVG_MOON = '<svg class="th-moon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const SVG_SUN = '<svg class="th-sun" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';

window.applyTheme = function(t) {
  const theme = (t === 'dark' || t === 'night') ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('lms_theme', theme); } catch (e) {}
  if (window.S && S.settings) {
    S.settings.theme = theme;
    if (typeof persist === 'function') persist();
  }
  const thBtn = document.getElementById('thBtn');
  if (thBtn) {
    thBtn.innerHTML = theme === 'dark' ? SVG_SUN : SVG_MOON;
    thBtn.setAttribute('title', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    thBtn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  }
  const mTh = document.getElementById('uMenuTheme');
  if (mTh) {
    mTh.innerHTML = `<span class="m-ic">${theme === 'dark' ? SVG_SUN : SVG_MOON}</span>${theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}`;
  }
};

window.toggleTheme = function() {
  const cur = document.documentElement.getAttribute('data-theme') || (window.S && S.settings && S.settings.theme) || (function() { try { return localStorage.getItem('lms_theme'); } catch(e) { return null; } })() || 'light';
  const next = cur === 'dark' ? 'light' : 'dark';
  applyTheme(next);
};

/* ---- topbar & breadcrumbs ----------------------------------------- */
function fillTopbar() {
  $('#uAv').textContent = ME.fullName.charAt(0);
  // below 980px the visible name is hidden; the button still needs one
  $('#userBtn').setAttribute('aria-label', 'Account menu: ' + ME.fullName + ', ' + ME.role);
  $('#uName').textContent = ME.fullName;
  $('#uRole').textContent = ME.role + ' · ' + ((ME.groups || [])[0] || ME.position);
  $('#uInfo').innerHTML =
    `Signed in: <b>${fdtt(ME.lastLogin)}</b><br>`
    + `Previous login: <b>${ME._prevLogin ? fdtt(ME._prevLogin) : 'First login'}</b><br>`
    + `Approval groups: <b>${esc((ME.groups || []).join(', '))}</b><br>`
    + `Rights: ${esc(ROLES[ME.role])}`;
  // nothing to change if the account covers a single province
  const chip = $('#provChip'), single = allowedProv().length === 1;
  if (chip && single) {
    chip.removeAttribute('data-act');
    chip.setAttribute('aria-disabled', 'true');
    chip.classList.add('is-fixed');
    chip.title = 'Your account covers ' + provName(allowedProv()[0]) + ' only';
  }
  const changeProv = document.querySelector('#uMenu [data-act="showProvince"]');
  if (changeProv) changeProv.classList.toggle('hidden', single);
  // the presenter's account switch is offered only to a signed-in administrator
  const sw = $('#swUser');
  if (sw) sw.classList.toggle('hidden', !presenterIsAdmin());
  iconize($('.top'));
}

function buildCrumbs() {
  const el = $('#crumbs');
  if (!el) return;
  const group = navGroup(SCREEN), label = navLabel(SCREEN);
  const parts = [`<a href="${pageUrl('dashboard')}">LMS</a>`];
  if (group) parts.push(`<span>${esc(group)}</span>`);
  parts.push(`<span aria-current="page">${esc(label)}</span>`);
  el.innerHTML = parts.join('<span class="sep" aria-hidden="true">›</span>');
}

function fillFooter() {
  const el = $('#footMeta');
  if (!el) return;
  el.innerHTML = `<b>${esc(S.settings.company)}</b> · Land Management System`
    + ` · demo build ${esc(APP_VER)}`
    + ` · <span class="note">Pre-award prototype — all records are fictional</span>`;
}

/* ---- topbar interactions ------------------------------------------ */
function wireShell() {
  const side = $('#side'), backdrop = $('#sideBackdrop'), burger = $('#burger');

  const closeDrawer = () => {
    side.classList.remove('open');
    if (backdrop) backdrop.classList.remove('show');
    if (burger) burger.setAttribute('aria-expanded', 'false');
  };
  if (burger) burger.addEventListener('click', e => {
    e.stopPropagation();
    const open = side.classList.toggle('open');
    if (backdrop) backdrop.classList.toggle('show', open);
    burger.setAttribute('aria-expanded', String(open));
  });
  if (backdrop) backdrop.addEventListener('click', closeDrawer);

  // user menu
  const user = $('#userBtn'), menu = $('#uMenu');
  if (user) user.addEventListener('click', e => {
    // the menu's own items sit inside this chip; let their clicks reach the
    // action dispatcher instead of swallowing them as a menu toggle
    if (e.target.closest('#uMenu')) return;
    e.stopPropagation();
    const open = menu.classList.toggle('hidden');
    user.setAttribute('aria-expanded', String(!open));
  });
  if (user) user.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === user) {
      e.preventDefault();
      const open = menu.classList.toggle('hidden');
      user.setAttribute('aria-expanded', String(!open));
      if (!open) { const first = menu.querySelector('button, a'); if (first) first.focus(); }
    }
  });
  document.addEventListener('click', () => {
    if (menu && !menu.classList.contains('hidden')) {
      menu.classList.add('hidden');
      if (user) user.setAttribute('aria-expanded', 'false');
    }
  });

  // Escape closes the top-most modal, then the drawer
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if ($('#globalSearchModal') && !$('#globalSearchModal').classList.contains('hidden')) { if (typeof closeGlobalSearch === 'function') closeGlobalSearch(); else $('#globalSearchModal').classList.add('hidden'); return; }
    if (!$('#dlg').classList.contains('hidden')) { $('#dCancel').click(); return; }
    if (!$('#conv').classList.contains('hidden')) { closeModal('conv'); return; }
    if (!$('#frm').classList.contains('hidden')) { closeModal('frm'); return; }
    if (!$('#view').classList.contains('hidden')) { closeModal('view'); return; }
    closeDrawer();
  });
}

/* ---- deep links ----------------------------------------------------
   Every screen has a URL, so a record, a filter or a map position can be
   linked to directly: /surveys?view=<id>, /cases?stage=Checked,
   /gis?lat=..&lng=.., /reports?report=r9&project=<id>                  */
function applyDeepLink() {
  const q = new URLSearchParams(location.search);
  if (!q.toString()) return;

  const coll = SCREEN;
  if (q.has('q') && SPEC[coll]) UI.q[coll] = q.get('q');
  if (q.has('stage') && SPEC[coll]) {
    // ignore a stage this module does not have, rather than silently
    // filtering the list down to nothing
    const stage = q.get('stage');
    const valid = WF[coll]
      ? [...WF[coll].stages, 'Cancelled', 'Stopped']
      : uniq(S[coll].map(r => r.status));
    if (valid.includes(stage)) UI.stage[coll] = stage;
    else toast('“' + stage + '” is not a stage of ' + navLabel(coll) + ' — showing all records.', 'warning');
  }
  if (q.has('coll')) UI.impColl = q.get('coll');
  if (q.has('report')) UI.reportId = q.get('report');
  if (q.has('project')) UI.rf = Object.assign({}, UI.rf, { project: q.get('project') });
  if (q.has('lat') && q.has('lng')) {
    UI.mapFocus = { lat: +q.get('lat'), lng: +q.get('lng') };
    if (q.has('id')) UI.mapFocus.id = q.get('id');
  }
  if (q.has('month')) UI.calM = q.get('month');
  return q.get('view');          // a record to open once the screen is drawn
}

/* =====================================================================
   Page entry points
   ===================================================================== */

/* ---- login --------------------------------------------------------- */
function initLogin() {
  const list = $('#lgUsers');
  list.innerHTML = S.users.filter(u => u.status === 'Active').map(u =>
    `<tr tabindex="0" role="button" data-u="${esc(u.username)}" data-p="${esc(u.password)}">`
    + `<td><b>${esc(u.username)}</b></td><td>${esc(u.password)}</td>`
    + `<td>${esc((u.groups || [])[0] || u.role)}</td></tr>`).join('');

  const fill = tr => { $('#lgU').value = tr.dataset.u; $('#lgP').value = tr.dataset.p; };
  list.addEventListener('click', e => { const tr = e.target.closest('tr'); if (tr) fill(tr); });
  list.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const tr = e.target.closest('tr');
    if (tr) { e.preventDefault(); fill(tr); }
  });

  $('#lgCo').textContent = S.settings.company;
  const accts = document.querySelector('.demo-accts');
  accts.classList.toggle('hidden', !!S.settings.presentation);
  if (S.settings.presentation) { $('#lgU').value = ''; $('#lgP').value = ''; }

  $('#loginForm').addEventListener('submit', doLogin);
}

function doLogin(e) {
  e.preventDefault();
  const err = $('#lgErr');
  const show = msg => {
    err.textContent = msg;
    err.classList.remove('hidden');
    toast(msg, 'error');
  };
  const name = $('#lgU').value.trim().toLowerCase();
  const u = S.users.find(x => x.username.toLowerCase() === name && x.password === $('#lgP').value);
  if (!u) return show('Invalid username or password.');
  if (u.status !== 'Active') return show('This account is suspended.');

  err.classList.add('hidden');
  ME = u;
  ME._prevLogin = u.lastLogin;
  u.lastLogin = nowStr();
  S.sessions.unshift({
    id: uid(), user: u.username, role: u.role, at: nowStr(),
    agent: /Mobi/.test(navigator.userAgent) ? 'Mobile browser' : 'Desktop browser',
  });
  S.sessions.length = Math.min(S.sessions.length, 300);
  audit('users', u, 'Login');
  persist();
  CTX = null;
  sessionSave({ origin: u.username, ret: null });
  // an account limited to one province has nothing to choose
  if (allowedProv().length === 1) { enterProvince(allowedProv()[0]); return; }
  location.href = pageUrl('province');
}

/* ---- province chooser ---------------------------------------------- */
function initProvince() {
  const allowed = allowedProv();
  if (allowed.length === 1) { enterProvince(allowed[0]); return; }
  $('#provGrid').innerHTML = Object.entries(PROV).filter(([k]) => allowed.includes(k)).map(([k, p]) => {
    const prev = CTX;
    CTX = k;
    const st = {
      lo: ctxRows('landowners').length,
      sv: ctxRows('surveys').length,
      pr: ctxRows('projects').length,
      ls: ctxRows('leases').filter(l => leaseInfo(l).status !== 'Expired' && l.stage !== 'Stopped').length,
    };
    CTX = prev;
    return `<a class="prov-card" href="${pageUrl('dashboard')}" data-act="enterProvince" data-a1="${esc(k)}" data-bg="${esc(p.grad)}">`
      + `<h3>${esc(p.name)}</h3>`
      + `<div class="meta">${esc(p.levels.slice().reverse().join(' → '))}<br>`
      + `Revenue unit: ${esc(p.rev)}${p.rev2 ? ' &amp; ' + esc(p.rev2) : ''} · Units: ${esc(p.units.join(', '))}</div>`
      + `<div class="stats"><div><b>${st.pr}</b>Projects</div><div><b>${st.sv}</b>Surveys</div>`
      + `<div><b>${st.lo}</b>Landowners</div><div><b>${st.ls}</b>Leases</div></div></a>`;
  }).join('');

  $('#provAll').classList.toggle('hidden', allowed.length < 4);
  $('#provHello').textContent = 'Welcome, ' + ME.fullName + ' — ' + ((ME.groups || [])[0] || ME.role);
  applyDynamic($('#prov'));
  iconize($('#prov'));
}
