/* Data scope — every account sees only the records it is entitled to.

   The rule is the one the Users form already expresses: an account's
   "Province access" (user.provinces) bounds everything it can see. Field
   staff see their own province; head-office staff see all four.

   The original engine applied that bound to most list screens but not to
   the audit trail, the document register, login sessions or the
   cross-tab "live update" notice, and it let a restricted account pick the
   all-provinces view. This file closes those gaps without editing the
   generated engine: it replaces inCtx() — which every scoped query goes
   through — and guards the two ways a record can be opened directly. */
'use strict';

const ALL_PROVS = Object.keys(PROV);

/* ---- demo accounts: give field-office staff their home province ------
   Runs once per data store. An administrator can change any of this later
   on the Users screen (Province access). */
const SCOPE_VERSION = 1;
const OFFICE_HOME = { 'Daharki Field Office': ['SND'] };

function migrateScope() {
  if ((S.meta.scope || 0) >= SCOPE_VERSION) return;
  S.users.forEach(u => {
    const home = OFFICE_HOME[u.office];
    const unrestricted = !u.provinces || !u.provinces.length || u.provinces.length === ALL_PROVS.length;
    if (home && unrestricted) u.provinces = home.slice();
  });
  S.meta.scope = SCOPE_VERSION;
  persist();
}

/* ---- who sees what ------------------------------------------------- */
const coversAllProvinces = () => !!ME && allowedProv().length >= ALL_PROVS.length;

/* Administrators and Internal Audit (the Viewer role) oversee the whole
   system, so the audit trail and document register are theirs in full. */
const overseesEverything = () => !!ME && (isRole('Admin') || isRole('Viewer')) && coversAllProvinces();

const _inCtxBase = inCtx;

/* Is this record inside the account's province access at all, regardless
   of which province is currently selected? */
function inScope(c, r) {
  const save = CTX;
  CTX = 'ALL';
  try { return inCtx(c, r); } finally { CTX = save; }
}

function auditVisible(a) {
  if (!a) return false;
  if (overseesEverything()) return true;
  // sign-ins, settings and the like: only your own
  if (!SPEC[a.coll]) return a.user === ME.username;
  // a record entry follows the record — even one you made yourself, since
  // access you once had to another province is not access you have now
  const rec = byId(a.coll, a.recId);
  return !!rec && inCtx(a.coll, rec);
}

/* A notification is about a record; show it only if that record is visible. */
function noteVisible(n) {
  if (!n || !SPEC[n.coll]) return true;
  const rec = byId(n.coll, n.recId);
  return !!rec && inCtx(n.coll, rec);
}

/* Don't notify people about records outside their province access in the
   first place. notifyNext() addresses everyone in the next step's approval
   group; drop the recipients who could not open the record. */
if (typeof notifyNext === 'function') {
  const _notifyNext = notifyNext;
  window.notifyNext = function (c, r) {
    const before = S.notifications.length;
    _notifyNext.apply(this, arguments);
    const added = S.notifications.length - before;
    if (added <= 0) return;
    const fresh = S.notifications.slice(0, added).filter(nt => {
      const u = S.users.find(x => x.username === nt.to);
      if (!u || !u.provinces || !u.provinces.length) return true;
      const p = recProv(c, r);
      return !p || u.provinces.includes(p);
    });
    S.notifications.splice(0, added, ...fresh);
  };
}

function docVisible(d) {
  if (!d) return false;
  if (overseesEverything()) return true;
  const rec = byId(d.coll, d.recId);
  return !!rec && SPEC[d.coll] && inCtx(d.coll, rec);
}

window.inCtx = function (c, r) {
  if (!ME) return _inCtxBase(c, r);
  if (c === 'audit') return auditVisible(r);
  if (c === 'documents') return docVisible(r);
  if (c === 'sessions') return overseesEverything() || r.user === ME.username;
  if (c === 'users' || c === 'gis') return _inCtxBase(c, r);

  // "All provinces" means all of *your* provinces
  if (CTX === 'ALL' && !coversAllProvinces()) {
    const save = CTX;
    try { return allowedProv().some(p => { CTX = p; return _inCtxBase(c, r); }); }
    finally { CTX = save; }
  }
  return _inCtxBase(c, r);
};

/* A reference from one record to another: visible unless it points at a
   record outside the account's access. */
function refVisible(c, id) {
  if (!id || !SPEC[c]) return true;
  const r = byId(c, id);
  return !r || inScope(c, r);
}
const subRowVisible = (f, row) =>
  (f.cols || []).every(col => col.t !== 'ref' || refVisible(col.coll, row[col.k]));

/* "+ 2 holdings in other provinces" — the fact, without the detail. */
function hiddenNote(list, c, key, noun) {
  const n = (list || []).filter(x => !refVisible(c, x[key])).length;
  return n ? `<p class="note u-mb-6">+ ${n} ${noun}${n === 1 ? '' : 's'} in other provinces, outside your access.</p>` : '';
}

/* Screens that used to read the raw collections call these instead. */
const visibleAudit = () => S.audit.filter(a => inCtx('audit', a));
const visibleDocs = () => S.documents.filter(d => inCtx('documents', d));

/* ---- which screens a role may open ---------------------------------
   One definition, used by the page guard in boot.js and by anything that
   would otherwise render a link the role cannot follow. */
function screenAllowed(k) {
  if (!ME) return false;
  if (k === 'users' || k === 'settings') return can.admin();
  if (k === 'import') return can.create();
  return true;
}

/* ---- province context must be one the account may use -------------- */
function validCtx(k) {
  if (!ME) return false;
  if (k === 'ALL') return coversAllProvinces();
  return allowedProv().includes(k);
}

/* the province a restricted account should fall back to */
const defaultCtx = () => coversAllProvinces() ? 'ALL' : allowedProv()[0];

/* ---- direct access to a record -------------------------------------
   A deep link or a cross-reference can name any record id. Refuse the ones
   outside the account's province access instead of displaying them. */
function outOfScope(c, id) {
  if (!SPEC[c] || !id) return false;
  const r = byId(c, id);
  return !!r && !inScope(c, r);
}

function refuseOutOfScope(c, id) {
  const r = byId(c, id);
  const p = r && recProv(c, r);
  toast((SPEC[c] ? SPEC[c].title + ' ' : '') + ((r && r.code) || '') + ' is in '
    + (p ? provName(p) : 'another area') + ', outside your province access.', 'warning');
}

['openView', 'openForm'].forEach(name => {
  const orig = window[name];
  if (typeof orig !== 'function') return;
  window[name] = function (c, id) {
    if (outOfScope(c, id)) { refuseOutOfScope(c, id); return; }
    return orig.apply(this, arguments);
  };
});

/* ---- "Switch user (demo)" -----------------------------------------
   A presenter's shortcut for showing each role. It signs in as another
   account without a password, so it is only offered when the person who
   actually signed in with a password is an administrator; anyone else
   would be using it to escape their own role. The switch now survives
   page loads, and the new account's province access applies at once. */
function presenterIsAdmin() {
  const s = sessionRead() || {};
  const origin = S.users.find(u => u.username === (s.origin || s.u));
  return !!origin && origin.role === 'Admin' && S.settings.demoSwitch !== false;
}

window.switchUser = function (un, keepView) {
  if (!presenterIsAdmin()) {
    toast('Switching accounts is a presenter tool for administrators. Sign out and sign in as that user instead.', 'warning');
    return;
  }
  const u = S.users.find(x => x.username === un && x.status === 'Active');
  if (!u) return;
  audit('users', u, 'Signed in (demo user switch from ' + (ME ? ME.username : '-') + ')');
  const view = keepView && VIEW ? VIEW : null;
  ME = u;
  ME._prevLogin = u.lastLogin;
  u.lastLogin = nowStr();
  if (!validCtx(CTX)) CTX = defaultCtx();
  persist();
  sessionSave();
  // a fresh page applies the new role everywhere: nav, role bar, data scope
  const target = can.admin() || !['users', 'settings'].includes(SCREEN) ? SCREEN : landingScreen();
  if (view && !outOfScope(view.c, view.id)) go(view.c, 'view=' + encodeURIComponent(view.id));
  else go(target);
};
