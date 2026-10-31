/* Session and addressing.

   The data store stays in localStorage (shared by every tab, so the
   two-window "field officer + head office approver" demo still works).
   The *session* lives in sessionStorage, which is per-tab — so two tabs
   can be signed in as two different users at the same time, and closing
   the tab signs out. */
'use strict';

const SESSION_KEY = 'lms_session_v3';

/* ---- addressing ----------------------------------------------------
   Each screen is a directory holding an index.html, so the address bar
   shows /surveys rather than surveys.html. ROOT is '' on the sign-in page
   (which is the folder root) and '../' everywhere else, which keeps every
   link relative — the app works from any sub-path on the server. */
const ROOT = document.body.dataset.root || '';

/* Opened straight from disk (file://) a browser will not serve index.html
   for a directory — it shows a file listing. So when there is no server,
   every link names index.html explicitly; when served, URLs stay clean. */
const IS_FILE = location.protocol === 'file:';
const INDEX = IS_FILE ? 'index.html' : '';
const pageUrl = (screen, query) => ROOT + screen + '/' + INDEX + (query ? '?' + query : '');
const LOGIN_URL = IS_FILE ? ROOT + 'index.html' : (ROOT || './');
const assetUrl = path => ROOT + 'assets/' + path;

/* '../surveys/' or '../surveys/?view=x' or '../'  ->  add index.html */
function fileHref(h) {
  if (!h || /^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('#')) return h;
  const m = h.match(/^([^?#]*\/)([?#].*)?$/);
  return m ? m[1] + 'index.html' + (m[2] || '') : h;
}

function fixFileLinks(root) {
  if (!IS_FILE) return;
  const scope = root && root.querySelectorAll ? root : document;
  const els = [...scope.querySelectorAll('a[href], [data-href]')];
  if (scope.matches && scope.matches('a[href], [data-href]')) els.push(scope);
  for (const el of els) {
    if (el.hasAttribute('href')) {
      const h = el.getAttribute('href'), f = fileHref(h);
      if (f !== h) el.setAttribute('href', f);
    }
    if (el.dataset.href) {
      const f = fileHref(el.dataset.href);
      if (f !== el.dataset.href) el.dataset.href = f;
    }
  }
}

/* Links in the static page and links any screen renders later are both
   corrected, so nothing in the generated markup has to know about file://. */
if (IS_FILE) {
  fixFileLinks(document);
  new MutationObserver(list => {
    for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) fixFileLinks(n);
  }).observe(document.body, { childList: true, subtree: true });
}

function go(screen, query) {
  location.href = pageUrl(screen, query);
}

/* ---- session -------------------------------------------------------- */
function sessionSave(extra) {
  try {
    const cur = sessionRead() || {};
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(Object.assign(cur, {
      u: ME ? ME.username : null,
      ctx: CTX,
      prev: ME ? ME._prevLogin || null : null,
    }, extra || {})));
  } catch (e) { /* private window — the session just won't survive navigation */ }
}

function sessionRead() {
  try {
    const t = sessionStorage.getItem(SESSION_KEY);
    return t ? JSON.parse(t) : null;
  } catch (e) { return null; }
}

function sessionClear() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { }
}

/* Restore ME and CTX from the tab's session. False when nobody is signed in. */
function sessionRestore() {
  const s = sessionRead();
  if (!s || !s.u) return false;
  const u = S.users.find(x => x.username === s.u);
  if (!u || u.status !== 'Active') { sessionClear(); return false; }
  ME = u;
  ME._prevLogin = s.prev || null;
  CTX = s.ctx || null;
  // never trust a stored province the account may no longer use
  if (CTX && !validCtx(CTX)) CTX = defaultCtx();
  return true;
}

/* ---- where a role starts work --------------------------------------
   Follow the work rather than the job title: anyone with items waiting on
   them opens their approval queue, everyone else opens the dashboard. That
   way an approver lands on their six pending items while a viewer — who can
   action nothing — is never shown an empty queue. */
function landingScreen() {
  try { if (myQueue().length) return 'inbox'; } catch (e) { }
  return 'dashboard';
}

/* A plain-language description of what this role may do, shown in the role
   bar on every screen and in the account menu. */
function roleSummary() {
  const r = ME.role;
  if (r === 'Admin') return 'Full access — configuration, users, every approval step, and deletion.';
  if (r === 'Approver') return 'You can review and approve workflow steps, and create or edit records.';
  if (r === 'User') return 'You can create and edit draft records, submit them for approval, and upload documents.';
  return 'Read-only — you can open records, filter, and export, but not change anything.';
}

function logout() {
  if (ME) { audit('users', ME, 'Logout'); persist(); }
  ME = null;
  sessionClear();
  location.href = LOGIN_URL;
}

function allowedProv() {
  return ME.provinces && ME.provinces.length ? ME.provinces : Object.keys(PROV);
}

/* Remember the screen being left, so choosing a province returns here. */
function showProvince() {
  if (document.body.dataset.page === 'app') sessionSave({ ret: SCREEN });
  location.href = pageUrl('province');
}

function enterProvince(k) {
  if (!validCtx(k)) {
    toast('Your account does not have access to ' + (k === 'ALL' ? 'all provinces' : provName(k)) + '.', 'warning');
    return;
  }
  CTX = k;
  const back = (sessionRead() || {}).ret;
  sessionSave({ ret: null });
  go(back || landingScreen());
}

/* Guard for the application pages. */
function requireSession() {
  if (!sessionRestore()) { location.replace(LOGIN_URL); return false; }
  if (!CTX) { location.replace(pageUrl('province')); return false; }
  return true;
}
