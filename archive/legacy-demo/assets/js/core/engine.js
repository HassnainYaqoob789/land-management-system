/* Core engine — utilities, state, provinces, units, roles, workflows, audit, form engine, exports
   Part of the LMS multi-page build. Loaded as a classic script;
   top-level declarations are shared across the bundle. */
/* =====================================================================
   LMS DEMO — CORE ENGINE
   Storage · roles · provinces · units · workflows · audit · form engine
   ===================================================================== */
'use strict';
const APP_VER = '3.0.0-demo';
const STORE = 'lms_demo_store_v3';

/* ---------- utilities ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = v => v == null ? '' : String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);
const iso = d => { const x = new Date(d); return isNaN(x) ? '' : new Date(x.getTime() - x.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const today = () => iso(new Date());
const nowStr = () => new Date().toISOString();
const dOff = n => { const x = new Date(); x.setDate(x.getDate() + n); return iso(x); };
const addYears = (d, y) => { if (!d || !y) return ''; const x = new Date(d); x.setFullYear(x.getFullYear() + Math.floor(+y)); const m = Math.round((+y % 1) * 12); x.setMonth(x.getMonth() + m); x.setDate(x.getDate() - 1); return iso(x); };
const daysTo = d => d ? Math.round((new Date(d) - new Date(today())) / 864e5) : null;
const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const fmt = (n, d = 0) => (n == null || n === '' || isNaN(n)) ? '-' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const rs = n => 'Rs ' + fmt(n);
const rsM = n => 'Rs ' + fmt(n / 1e6, 2) + ' M';
const fdt = d => { if (!d) return '-'; const x = new Date(d); return isNaN(x) ? d : x.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); };
const fdtt = d => { if (!d) return '-'; const x = new Date(d); return x.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const sum = (arr, f) => arr.reduce((a, r) => a + num(typeof f === 'function' ? f(r) : r[f]), 0);
const uniq = a => [...new Set(a.filter(Boolean))];
function toast(msg, type = 'info') { const t = document.createElement('div'); t.className = 'toast ' + type; t.textContent = msg; const box = $('#toasts'); box.appendChild(t); while (box.children.length > 3) box.firstChild.remove(); setTimeout(() => t.remove(), 4500); }

/* ---------- provinces (SoW §3.1 table) ---------- */
const PROV = {
  SND: { name: 'Sindh', color: '#2368b0', grad: 'linear-gradient(135deg,#1c6dc4,#0e3f78)', levels: ['District', 'Taluka', 'Deh'], rev: 'Survey No.', rev2: 'Block No.', units: ['Acre', 'Jireb', 'Ghunta'], center: [26.0, 68.7] },
  BAL: { name: 'Balochistan', color: '#c26a17', grad: 'linear-gradient(135deg,#d07a24,#8a4410)', levels: ['District', 'Sub-Division', 'Tehsil', 'Sub-Tehsil / Qanungo Halka', 'Mouza'], rev: 'Khasra No.', units: ['Acre', 'Rod', 'Pole'], center: [29.5, 67.5] },
  PNJ: { name: 'Punjab', color: '#178a4c', grad: 'linear-gradient(135deg,#1f9e5a,#0d5c32)', levels: ['District', 'Tehsil', 'Qanungo Halka', 'Mouza'], rev: 'Khasra No.', units: ['Acre', 'Kanal', 'Marla'], center: [31.3, 72.6] },
  KPK: { name: 'Khyber Pakhtunkhwa', color: '#b8324a', grad: 'linear-gradient(135deg,#c93b55,#7c1a2c)', levels: ['District', 'Sub-Division', 'Tehsil', 'Mouza'], rev: 'Khasra No. (Rural) / Survey No. (Urban)', units: ['Acre', 'Kanal', 'Bigha'], center: [33.6, 71.6] }
};
const provName = p => PROV[p]?.name || p || '-';

/* ---------- unit conversion (SoW §3.2: acre primary, province secondary units) ---------- */
// Square-feet per unit. Factors flagged "confirm" must be supplied/confirmed by Mari (SoW §3.2: "Unit conversions will be provided when required").
const UNIT_DEFAULT = {
  'Acre': { sqft: 43560, ok: true }, 'Kanal': { sqft: 5445, ok: true }, 'Marla': { sqft: 272.25, ok: true },
  'Ghunta': { sqft: 1089, ok: true }, 'Jireb': { sqft: 21780, ok: false }, 'Rod': { sqft: 10890, ok: true },
  'Pole': { sqft: 272.25, ok: true }, 'Bigha': { sqft: 21780, ok: false }, 'Square Feet': { sqft: 1, ok: true },
  'Square Meter': { sqft: 10.7639104, ok: true }, 'Hectare': { sqft: 107639.104, ok: true }
};
const UNITS = () => S.settings.units;
const toAcres = (v, u) => num(v) * (UNITS()[u]?.sqft || 43560) / 43560;
const fromAcres = (a, u) => num(a) * 43560 / (UNITS()[u]?.sqft || 43560);
function ag(acres) { // Acre - Ghunta (40 ghunta = 1 acre) as used in SoR sample reports
  let a = Math.floor(num(acres) + 1e-9), g = Math.round((num(acres) - a) * 40 * 100) / 100;
  if (g >= 40) { a += 1; g -= 40; }
  return `${a} - ${fmt(g, g % 1 ? 1 : 0)}`;
}
function areaTxt(acres, prov) {
  if (acres == null || acres === '') return '-';
  const p = PROV[prov]; let s = fmt(acres, 3) + ' ac';
  if (prov === 'SND') s += ` (${ag(acres)} A-G)`;
  else if (p) s += ` (${fmt(fromAcres(acres, p.units[1]), 2)} ${p.units[1]})`;
  return s;
}

/* ---------- state ---------- */
const COLLS = ['units', 'projects', 'surveys', 'landowners', 'acquisitions', 'cases', 'leases', 'rows', 'payments', 'dbpfc', 'budgets', 'grievances', 'encroachments', 'legal', 'mutations', 'documents', 'users', 'audit', 'gis', 'sessions', 'notifications', 'savedReports'];
const DEFAULT_USERS = [
  { id: 'u1', username: 'admin', password: 'admin123', fullName: 'System Administrator', role: 'Admin', department: 'IT / Land Management', position: 'LMS System Administrator', groups: ['System Administrator'], office: 'Head Office Islamabad', email: 'admin@lms.demo', status: 'Active' },
  { id: 'u2', username: 'approver', password: 'approver123', fullName: 'Asad Mehmood', role: 'Approver', department: 'Land Management', position: 'DM / Team Lead (Field)', groups: ['DM / Team Lead (Field)'], office: 'Daharki Field Office', email: 'approver@lms.demo', status: 'Active' },
  { id: 'u3', username: 'user', password: 'user123', fullName: 'Moazam Ali', role: 'User', department: 'Land Management', position: 'Land Officer (Field)', groups: ['Land Officer (Field)'], office: 'Daharki Field Office', email: 'user@lms.demo', status: 'Active' },
  { id: 'u4', username: 'viewer', password: 'viewer123', fullName: 'Fawad Hashmi', role: 'Viewer', department: 'Internal Audit', position: 'Internal Auditor', groups: ['Internal Audit'], office: 'Head Office Islamabad', email: 'audit@lms.demo', status: 'Active' }
];
let S = null, ME = null, CTX = 'ALL', SCREEN = 'dashboard';
const UI = { q: {}, stage: {}, reportId: 'r1', rf: {} };
function blankState() {
  const s = { meta: { seq: {}, created: nowStr(), ver: APP_VER }, settings: { company: 'Mari Energies Limited', ho: 'Islamabad', wht: 10, units: JSON.parse(JSON.stringify(UNIT_DEFAULT)), theme: 'light', matrix: JSON.parse(JSON.stringify(MATRIX_DEFAULT)), sod: 'strict', adminOverride: false, presentation: false } };
  COLLS.forEach(c => s[c] = []); s.users = JSON.parse(JSON.stringify(DEFAULT_USERS)); return s;
}
let _lastSave = '';
function persist() {
  clearCache();
  try { const clean = Object.assign({}, S); COLLS.forEach(c => { if (Array.isArray(S[c]) && S[c].some(r => r && r._vol)) clean[c] = S[c].filter(r => !r._vol); });
    _lastSave = JSON.stringify(clean); localStorage.setItem(STORE, _lastSave); }
  catch (e) { toast('Browser storage full or blocked — changes kept in memory for this session only.', 'warning'); }
}
/* multi-window sync: two browser windows (e.g. field officer + HO approver) share the same data store live */
window.addEventListener('storage', e => {
  if (e.key !== STORE || !e.newValue || e.newValue === _lastSave || !ME) return;
  try { const vol = {}; COLLS.forEach(c => { if (Array.isArray(S[c])) vol[c] = S[c].filter(r => r && r._vol); });
    S = JSON.parse(e.newValue); COLLS.forEach(c => { S[c] = (S[c] || []).concat(vol[c] || []); }); clearCache(); ME = S.users.find(u => u.username === ME.username) || ME;
    const who = visibleAudit()[0]; render(); if (VIEW && !$('#view').classList.contains('hidden')) drawView();
    toast('Live update: ' + (who ? who.user + ' — ' + who.action + ' ' + (who.code || '') : 'data changed in another window'), 'info');
  } catch (err) { }
});
function restore() {
  try { const t = localStorage.getItem(STORE); if (t) { S = JSON.parse(t); COLLS.forEach(c => S[c] = S[c] || []); S.settings.units = Object.assign(JSON.parse(JSON.stringify(UNIT_DEFAULT)), S.settings.units || {}); S.settings.matrix = S.settings.matrix || JSON.parse(JSON.stringify(MATRIX_DEFAULT)); _lastSave = t; return true; } } catch (e) { }
  return false;
}
function nextCode(prefix, pad = 4) { S.meta.seq[prefix] = (S.meta.seq[prefix] || 0) + 1; return prefix + String(S.meta.seq[prefix]).padStart(pad, '0'); }
const CACHE = {}; function clearCache() { for (const k in CACHE) delete CACHE[k]; }
const byId = (c, id) => { if (!id || !S[c]) return null; const m = CACHE['i_' + c] || (CACHE['i_' + c] = new Map(S[c].map(r => [r.id, r]))); return m.get(id) || S[c].find(r => r.id === id) || null; };
const byCode = (c, code) => code ? S[c].find(r => (r.code || '').toLowerCase() === String(code).trim().toLowerCase()) : null;
/* escape a value for use inside a single-quoted JS string within an inline HTML handler attribute */
const jsq = v => esc(String(v ?? '').replace(/[\\']/g, '\\$&'));
/* per-render indexes (CACHE is cleared on persist()/render()) — replace O(n²) scans in lists, reports and exports */
const ownersOfSurvey = id => {
  let m = CACHE.ownSv;
  if (!m) { m = CACHE.ownSv = new Map(); S.landowners.forEach(l => (l.shares || []).forEach(x => { const a = m.get(x.surveyId); if (!a) m.set(x.surveyId, [l]); else if (a[a.length - 1] !== l) a.push(l); })); }
  return m.get(id) || [];
};
const activeLeaseCount = id => {
  let m = CACHE.actLs;
  if (!m) { m = CACHE.actLs = new Map(); S.leases.forEach(l => { if (['Active', 'Expiring'].includes(leaseInfo(l).status)) (l.landownerIds || []).forEach(o => m.set(o, (m.get(o) || 0) + 1)); }); }
  return m.get(id) || 0;
};

/* ---------- labels ---------- */
const LABEL = {
  units: r => `${r.name} (${r.code})`,
  projects: r => `${r.code} — ${r.name}`,
  surveys: r => `${r.code} · ${surveyNoTxt(r)} · ${unitName(r.unitId)}`,
  landowners: r => `${r.code} — ${r.name}${r.father ? ' s/o ' + r.father : ''}`,
  cases: r => `${r.code} — ${projCode(r.projectId)}`,
  leases: r => `${r.code} — ${projCode(r.projectId)}`,
  rows: r => `${r.code} — ${r.name}`,
  users: r => `${r.fullName} (${r.role})`,
  legal: r => `${r.code} — ${r.caseNo}`, mutations: r => r.code,
  acquisitions: r => r.code, payments: r => r.code, dbpfc: r => r.code, budgets: r => r.code, grievances: r => r.code, encroachments: r => r.code
};
const lbl = (c, id) => { const r = byId(c, id); return r ? LABEL[c](r) : '-'; };
const codeOf = (c, id) => byId(c, id)?.code || '-';
const projCode = id => codeOf('projects', id);
const unitName = id => byId('units', id)?.name || '-';
function surveyNoTxt(s) { if (!s) return '-'; let t = s.surveyNo || ''; if (s.blockNo) t += ' / Blk ' + s.blockNo; if (s.khasraType) t += ' (' + s.khasraType + ')'; return t; }
function unitPath(id) { const out = []; let u = byId('units', id); while (u) { out.push(u.name); u = byId('units', u.parentId); } return out.join(' → ') || '-'; }
function unitChain(id) { const out = []; let u = byId('units', id); while (u) { out.unshift(u); u = byId('units', u.parentId); } return out; }
function ownersOf(c, r) { // landowner ids attached to a record
  if (c === 'landowners') return [r.id];
  if (c === 'cases') return (r.owners || []).map(o => o.landownerId);
  if (r.landownerIds) return r.landownerIds; if (r.landownerId) return [r.landownerId]; return [];
}

/* ---------- province context ---------- */
function recProv(c, r) {
  if (r.province) return r.province;
  if (r.projectId) return byId('projects', r.projectId)?.province;
  return null;
}
function inCtx(c, r) {
  if (CTX === 'ALL' || ['users', 'audit', 'documents', 'sessions', 'gis'].includes(c)) return true;
  if (c === 'landowners') return r.province === CTX || (r.shares || []).some(s => byId('surveys', s.surveyId)?.province === CTX);
  const p = recProv(c, r); return !p || p === CTX;
}
const ctxRows = c => S[c].filter(r => inCtx(c, r));

/* ---------- roles (SoW §4.2: Admin, Approver, User, Viewer) ---------- */
const ROLES = {
  Admin: 'Full access: configuration, users, all approvals, delete',
  Approver: 'Review & approve workflows, create/edit records',
  User: 'Data entry: create/edit draft records, submit for approval, upload documents',
  Viewer: 'Read-only: view records, dashboards and reports, export'
};
const isRole = (...r) => ME && r.includes(ME.role);
const can = {
  create: () => !isRole('Viewer'),
  edit: (c, r) => { if (isRole('Viewer')) return false; if (isLocked(c, r)) return false; if (WF[c]?.editOnlyFirst && r.stage !== WF[c].stages[0]) return false; return true; }, // SoR Sc14: once submitted, case cannot be edited — cancel only
  del: (c, r) => isRole('Admin') && !isLocked(c, r) && !(WF[c]?.noDeleteAfterSubmit && r.stage !== WF[c].stages[0]),
  approve: () => isRole('Admin', 'Approver'),
  upload: () => !isRole('Viewer'),
  admin: () => isRole('Admin')
};

/* ---------- workflows (SoW §3.8) ---------- */
const WF = {
  acquisitions: { stages: ['Identification', 'Negotiation', 'Approval', 'Acquisition / Lease', 'Handover'], lockAt: 'Handover', cancel: true },
  cases: { stages: ['Prepared', 'Checked', 'Reviewed', 'Verified', 'Field Approved', 'HO Approved'], lockAt: 'HO Approved', cancel: true, editOnlyFirst: true, noDeleteAfterSubmit: true,
    step: { Checked: 'Checked by Negotiation Group', Reviewed: 'Reviewed by Legal Advisor', Verified: 'Verified by Sr. Administrator LMS (Field)', 'Field Approved': 'Approval 1 — Field (DM / TL)', 'HO Approved': 'Approval 2 — Kharat (HO / RMS)' } },
  leases: { stages: ['Draft', 'Under Review', 'Approved'], cancel: false },
  rows: { stages: ['Draft', 'Under Review', 'Approved'] },
  payments: { stages: ['Requested', 'Verified', 'Released'], lockAt: 'Released', stop: true, editOnlyFirst: true, noDeleteAfterSubmit: true,
    step: { Requested: 'Payment request initiated', Verified: 'Verified by Finance', Released: 'Released — cheque generated' } },
  dbpfc: { stages: ['Estimated', 'Referred to DBPFC', 'Rate Fixed'], stop: true },
  grievances: { stages: ['Registered', 'Assigned', 'In Progress', 'Resolved', 'Closed'], lockAt: 'Closed', escalate: true },
  encroachments: { stages: ['Reported', 'Assessed', 'Action Approved', 'Legal Follow-up', 'Resolved'], lockAt: 'Resolved', escalate: true },
  mutations: { stages: ['Initiated', 'Revenue Verified', 'Legal Cleared', 'Approved & Applied'], lockAt: 'Approved & Applied', cancel: true, editOnlyFirst: true, noDeleteAfterSubmit: true,
    step: { 'Revenue Verified': 'Mutation verified against revenue record', 'Legal Cleared': 'Legal heirs / succession cleared', 'Approved & Applied': 'Approved — shares transferred' } }
};
const STAGE_LABEL = { 'HO Approved': 'Kharat Approved (HO / RMS)' };
const stLabel = s => STAGE_LABEL[s] || s;
/* positions / departments that approval steps are assigned to (SoW §4.2 "rights to nominated positions & departments") */
const GROUPS = ['Land Officer (Field)', 'Negotiation Group', 'Legal Advisor', 'Sr. Administrator LMS (Field)', 'DM / Team Lead (Field)', 'Manager Land (HO)', 'Finance Officer', 'Internal Audit', 'System Administrator'];
const MATRIX_DEFAULT = {
  cases: { Checked: ['Negotiation Group'], Reviewed: ['Legal Advisor'], Verified: ['Sr. Administrator LMS (Field)'], 'Field Approved': ['DM / Team Lead (Field)'], 'HO Approved': ['Manager Land (HO)'] },
  payments: { Verified: ['Finance Officer'], Released: ['Manager Land (HO)'] },
  acquisitions: { Negotiation: ['Negotiation Group', 'Land Officer (Field)'], Approval: ['DM / Team Lead (Field)'], 'Acquisition / Lease': ['Manager Land (HO)'], Handover: ['Sr. Administrator LMS (Field)', 'Land Officer (Field)'] },
  leases: { 'Under Review': ['Sr. Administrator LMS (Field)', 'Land Officer (Field)'], Approved: ['Manager Land (HO)'] },
  rows: { 'Under Review': ['Sr. Administrator LMS (Field)', 'Land Officer (Field)'], Approved: ['Manager Land (HO)'] },
  dbpfc: { 'Referred to DBPFC': ['Sr. Administrator LMS (Field)', 'Land Officer (Field)'], 'Rate Fixed': ['Manager Land (HO)'] },
  grievances: { Assigned: ['DM / Team Lead (Field)', 'Manager Land (HO)'], 'In Progress': ['Land Officer (Field)', 'Sr. Administrator LMS (Field)', 'Legal Advisor', 'Negotiation Group'], Resolved: ['DM / Team Lead (Field)', 'Legal Advisor', 'Sr. Administrator LMS (Field)'], Closed: ['Manager Land (HO)'] },
  encroachments: { Assessed: ['Sr. Administrator LMS (Field)', 'Land Officer (Field)'], 'Action Approved': ['DM / Team Lead (Field)'], 'Legal Follow-up': ['Legal Advisor'], Resolved: ['Manager Land (HO)', 'DM / Team Lead (Field)'] },
  mutations: { 'Revenue Verified': ['Sr. Administrator LMS (Field)', 'Land Officer (Field)'], 'Legal Cleared': ['Legal Advisor'], 'Approved & Applied': ['Manager Land (HO)'] }
};
const TERMINAL = ['Cancelled', 'Stopped'];
function isLocked(c, r) { const w = WF[c]; if (!w || !r) return false; return TERMINAL.includes(r.stage) || (w.lockAt && r.stage === w.lockAt); }
function stageIdx(c, r) { return WF[c] ? WF[c].stages.indexOf(r.stage) : -1; }
const myGroups = () => ME ? (ME.groups && ME.groups.length ? ME.groups : []) : [];
const stepGroups = (c, to) => (S.settings.matrix?.[c]?.[to]) || [];
const usersInGroups = gs => S.users.filter(u => u.status === 'Active' && (u.groups || []).some(g => gs.includes(g)));
/* Why a step is blocked for the signed-in user ('' = allowed). Segregation of duties: creator / earlier approvers cannot act again */
function advanceBlock(c, r) {
  const w = WF[c]; if (!w) return 'No workflow'; if (isLocked(c, r)) return 'Record is ' + r.stage;
  if (isRole('Viewer')) return 'Viewer role is read-only';
  const i = stageIdx(c, r); if (i < 0 || i >= w.stages.length - 1) return 'Final stage reached';
  const to = w.stages[i + 1]; const gs = stepGroups(c, to);
  const adminOk = isRole('Admin') && S.settings.adminOverride;
  if (!adminOk && gs.length && !myGroups().some(g => gs.includes(g))) return 'Step "' + ((w.step && w.step[to]) || stLabel(to)) + '" is assigned to: ' + gs.join(' / ');
  if (S.settings.sod !== 'off') {
    const acted = (r.history || []).filter(h => ['Created', 'Submitted', 'Approved'].includes(h.action) || /^Imported/.test(h.action)).map(h => h.user);
    if (S.settings.sod === 'strict' ? acted.includes(ME.username) : r.createdBy === ME.username) return 'Segregation of duties: you already ' + (r.createdBy === ME.username ? 'prepared' : 'acted on') + ' this record — another officer must perform this step';
  }
  return '';
}
function canAdvance(c, r) { return advanceBlock(c, r) === ''; }
function canReturn(c, r) { return WF[c] && !isLocked(c, r) && stageIdx(c, r) > 0 && can.approve(); }
/* simulated e-mail / SMS notification to the next step's officers */
function notifyNext(c, r) {
  const w = WF[c]; const i = stageIdx(c, r); if (i < 0 || i >= w.stages.length - 1) return;
  const to = w.stages[i + 1]; const gs = stepGroups(c, to); const users = usersInGroups(gs);
  users.forEach(u => S.notifications.unshift({ id: uid(), at: nowStr(), to: u.username, toName: u.fullName, channel: 'Email + SMS', coll: c, recId: r.id, code: r.code, msg: `${SPEC[c].title} ${r.code} awaits your action: ${(w.step && w.step[to]) || stLabel(to)}`, status: 'Sent (simulated)' }));
  if (S.notifications.length > 600) S.notifications.length = 600;
}
function stageBadge(stage) {
  const map = { 'HO Approved': 'g', Approved: 'g', Released: 'g', Handover: 'g', Resolved: 'g', Closed: 'g', 'Rate Fixed': 'g', Active: 'g',
    Cancelled: 'd', Stopped: 'd', Escalated: 'd', Expired: 'd', Critical: 'd', High: 'd', Disputed: 'd',
    Prepared: 'n', Draft: 'n', Requested: 'n', Registered: 'n', Reported: 'n', Estimated: 'n', Identification: 'n', Proposed: 'n',
    'Expiring': 'w', Medium: 'w', 'Under Acquisition': 'w', 'Due for Renewal': 'w', Leased: 'p', Acquired: 'g', Low: 'i' };
  return `<span class="b b-${map[stage] || 'i'}">${esc(stLabel(stage) || '-')}</span>`;
}
function pushHist(r, action, from, to, note) { (r.history = r.history || []).push({ at: nowStr(), user: ME?.username || 'system', name: ME?.fullName || 'System', role: ME?.role || '', action, from, to, note: note || '' }); }

/* ---------- audit trail (SoW §4.2) ---------- */
const AUDIT_SKIP = ['history', 'updatedAt', 'updatedBy'];
function audit(c, r, action, before, after, note) {
  const ch = [];
  if (before && after) { for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) { if (AUDIT_SKIP.includes(k)) continue; const a = JSON.stringify(before[k] ?? ''), b = JSON.stringify(after[k] ?? ''); if (a !== b) ch.push({ f: k, from: before[k], to: after[k] }); } }
  S.audit.unshift({ id: uid(), at: nowStr(), user: ME?.username || 'system', role: ME?.role || '', coll: c, recId: r?.id, code: r?.code || '', action, changes: ch, note: note || '' });
  if (S.audit.length > 4000) S.audit.length = 4000;
}

/* ---------- dialogs ---------- */
function openModal(id) { $('#' + id).classList.remove('hidden'); }
function closeModal(id) { $('#' + id).classList.add('hidden'); }
function dialog({ title, html, ok = 'OK', danger = false, onOpen }) {
  return new Promise(res => {
    $('#dTitle').textContent = title; $('#dBody').innerHTML = html;
    $('#dOk').textContent = ok; $('#dOk').className = 'btn ' + (danger ? 'btn-d' : 'btn-p');
    const done = v => { closeModal('dlg'); $('#dOk').onclick = $('#dCancel').onclick = $('#dX').onclick = null; res(v); };
    $('#dOk').onclick = () => { const vals = {}; $$('#dBody [data-k]').forEach(e => vals[e.dataset.k] = e.value); done(vals); };
    $('#dCancel').onclick = $('#dX').onclick = () => done(null);
    openModal('dlg'); onOpen && onOpen(); setTimeout(() => $('#dBody input,#dBody textarea')?.focus(), 50);
  });
}
const confirmBox = (title, msg, ok = 'Confirm', danger = true) => dialog({ title, html: `<p>${msg}</p>`, ok, danger }).then(v => !!v);
const askText = (title, label, val = '') => dialog({ title, html: `<div class="fg"><label>${esc(label)}</label><input data-k="v" value="${esc(val)}"></div>` }).then(v => v ? v.v.trim() : null);
const askNote = (title, label = 'Remarks / note (recorded in history)', req = false) => dialog({ title, html: `<div class="fg"><label>${esc(label)}${req ? ' <span class="req">*</span>' : ''}</label><textarea data-k="v" rows="3"></textarea></div>` }).then(v => { if (!v) return null; if (req && !v.v.trim()) { toast('A note is required', 'warning'); return null; } return v.v.trim(); });

/* =====================================================================
   FORM ENGINE
   field: {k,l,t,req,opt,coll,filter,full,help,when,depth,cols,ro,ph,step,sec}
   types: text number date textarea select ref multiref area loc sub checks calc ro sec
   ===================================================================== */
let CUR = null; // {coll, id, spec, rec}
const FL = (f, rec) => typeof f.l === 'function' ? f.l(rec) : f.l;
function optList(f, rec) { const o = typeof f.opt === 'function' ? f.opt(rec) : f.opt; return (o || []).map(x => Array.isArray(x) ? x : [x, x]); }
function refRows(f, rec) {
  // landowners & users are national masters (same landowner may hold land in several provinces — SoR Proto 5)
  let rows = S[f.coll];
  if (!f.allProv && rec.province && !['landowners', 'users'].includes(f.coll)) rows = rows.filter(r => (recProv(f.coll, r) || rec.province) === rec.province);
  if (f.filter) rows = rows.filter(r => f.filter(r, rec));
  return rows;
}
function fieldHTML(f, v, rec) {
  if (f.t === 'sec') return `<div class="sec-t">${esc(FL(f, rec))}</div>`;
  const id = 'f_' + f.k, lab = `<label>${esc(FL(f, rec))}${f.req ? ' <span class="req">*</span>' : ''}</label>`;
  let inp = '';
  const dis = f.ro ? 'disabled' : '';
  switch (f.t) {
    case 'select': inp = `<select id="${id}" ${dis} ${f.rerender ? 'data-rr="1"' : ''}>${f.blank === false ? '' : '<option value="">— select —</option>'}${optList(f, rec).map(([val, lb]) => `<option value="${esc(val)}" ${String(val) === String(v ?? '') ? 'selected' : ''}>${esc(lb)}</option>`).join('')}</select>`; break;
    case 'ref': inp = `<select id="${id}" ${dis} ${f.rerender ? 'data-rr="1"' : ''}><option value="">— select —</option>${refRows(f, rec).map(r => `<option value="${r.id}" ${r.id === v ? 'selected' : ''}>${esc(LABEL[f.coll](r))}</option>`).join('')}</select>`; break;
    case 'multiref': { const vv = v || []; inp = `<select id="${id}" multiple ${dis}>${refRows(f, rec).map(r => `<option value="${r.id}" ${vv.includes(r.id) ? 'selected' : ''}>${esc(LABEL[f.coll](r))}</option>`).join('')}</select><small>Hold Ctrl / Cmd to select several</small>`; break; }
    case 'textarea': inp = `<textarea id="${id}" ${dis} placeholder="${esc(f.ph || '')}">${esc(v ?? '')}</textarea>`; break;
    case 'area': inp = `<div class="area-in"><input type="number" step="any" min="0" id="${id}" value="${v ?? ''}" ${dis}><span class="u">acres</span><button type="button" class="btn btn-s btn-sm" data-act="openConverter" data-a1="${id}">⇄ Enter in ${esc(PROV[rec.province]?.units.slice(1).join(' / ') || 'other units')}</button></div><small data-comp="${f.k}__ag"></small>`; break;
    case 'loc': inp = `<div class="loc" id="${id}" data-val="${esc(v || '')}"></div>`; break;
    case 'sub': inp = subHTML(f, v); break;
    case 'checks': { const vv = v || []; inp = `<div class="checks" id="${id}">${optList(f, rec).map(([val, lb]) => `<label><input type="checkbox" value="${esc(val)}" ${vv.includes(val) ? 'checked' : ''} ${dis}> ${esc(lb)}</label>`).join('')}</div>`; break; }
    case 'calc': inp = `<div class="calc" data-comp="${f.k}">—</div>`; break;
    case 'ro': inp = `<div class="ro">${esc(typeof f.val === 'function' ? f.val(rec) : (v ?? '-'))}</div>`; break;
    default: inp = `<input id="${id}" type="${f.t || 'text'}" ${f.t === 'number' ? `step="${f.step || 'any'}"` : ''} value="${esc(v ?? '')}" placeholder="${esc(f.ph || '')}" ${dis}>`;
  }
  const full = f.full || ['textarea', 'sub', 'checks', 'loc', 'multiref'].includes(f.t);
  return `<div class="fg ${full ? 'full' : ''}" data-fk="${f.k}">${lab}${inp}${f.help ? `<small>${esc(typeof f.help === 'function' ? f.help(rec) : f.help)}</small>` : ''}</div>`;
}
/* ---- sub tables (repeating rows) ---- */
function subHTML(f, rows) {
  rows = rows && rows.length ? rows : (f.minRows === 0 ? [] : [{}]);
  return `<div class="sub" data-sub="${f.k}"><table><thead><tr>${f.cols.map(c => `<th>${esc(c.l)}</th>`).join('')}<th></th></tr></thead><tbody>${rows.map(r => subRow(f, r)).join('')}</tbody></table>
  <div class="foot"><button type="button" class="btn btn-s btn-sm" data-act="addSubRow" data-a1="${f.k}">+ Add row</button><span data-comp="${f.k}__tot"></span></div></div>`;
}
function subRow(f, r) {
  return `<tr>${f.cols.map(c => `<td>${cellInput(c, r[c.k])}</td>`).join('')}<td><button type="button" class="bx" title="Remove row" data-act="subRowDelete">×</button></td></tr>`;
}
function cellInput(c, v) {
  const rec = CUR?.rec || {};
  if (c.t === 'ref') return `<select data-c="${c.k}"><option value="">—</option>${refRows(c, rec).map(r => `<option value="${r.id}" ${r.id === v ? 'selected' : ''}>${esc((c.lab || LABEL[c.coll])(r))}</option>`).join('')}</select>`;
  if (c.t === 'select') return `<select data-c="${c.k}"><option value="">—</option>${optList(c, rec).map(([val, lb]) => `<option value="${esc(val)}" ${String(val) === String(v ?? '') ? 'selected' : ''}>${esc(lb)}</option>`).join('')}</select>`;
  if (c.t === 'calc') return `<span data-cc="${c.k}" class="mono">-</span>`;
  return `<input data-c="${c.k}" type="${c.t || 'text'}" ${c.t === 'number' ? 'step="any"' : ''} value="${esc(v ?? '')}" data-minw="${c.w ? c.w + 'px' : ''}">`;
}
function addSubRow(k) { const f = CUR.spec.fields.find(x => x.k === k); const tb = document.querySelector(`[data-sub="${k}"] tbody`); tb.insertAdjacentHTML('beforeend', subRow(f, {})); formCompute(); }
function readSub(el, f) {
  return [...el.querySelectorAll('tbody tr')].map(tr => { const o = {}; f.cols.forEach(c => { const e = tr.querySelector(`[data-c="${c.k}"]`); if (!e) return; o[c.k] = c.t === 'number' ? (e.value === '' ? null : parseFloat(e.value)) : e.value; }); return o; })
    .filter(o => Object.values(o).some(v => v !== '' && v != null));
}
/* ---- cascading location (SoW §3.1: province-specific administrative hierarchy, dropdown mandatory) ---- */
function initLoc(f, rec) {
  const el = document.getElementById('f_' + f.k); if (!el) return;
  const prov = rec.province; const P = PROV[prov]; if (!P) { el.innerHTML = '<span class="note">Select a province first</span>'; return; }
  const depth = typeof f.depth === 'function' ? f.depth(rec) : (f.depth ?? P.levels.length - 1);
  if (depth < 0) { el.innerHTML = '<span class="note">Not required for top level</span>'; return; }
  const chain = unitChain(el.dataset.val).map(u => u.id);
  el.innerHTML = P.levels.slice(0, depth + 1).map((lv, i) => `<div class="loc-row"><span>${esc(lv)}</span><select data-l="${i}"></select><button type="button" class="addb" data-add="${i}" title="Add new ${esc(lv)}" ${can.create() ? '' : 'disabled'}>+</button></div>`).join('');
  const fill = (i, parent, sel) => {
    const s = el.querySelector(`select[data-l="${i}"]`); if (!s) return;
    const opts = S.units.filter(u => u.province === prov && u.level === i && (i === 0 || u.parentId === parent)).sort((a, b) => a.name.localeCompare(b.name));
    s.innerHTML = '<option value="">— select ' + esc(P.levels[i]) + ' —</option>' + opts.map(o => `<option value="${o.id}" ${o.id === sel ? 'selected' : ''}>${esc(o.name)} · ${esc(o.code)}</option>`).join('');
    s.disabled = i > 0 && !parent;
  };
  for (let i = 0; i <= depth; i++) fill(i, chain[i - 1], chain[i]);
  el.onchange = e => { const s = e.target; if (s.dataset.l == null) return; const i = +s.dataset.l; for (let k = i + 1; k <= depth; k++) fill(k, k === i + 1 ? s.value : null, null); formCompute(); };
  el.onclick = async e => {
    const b = e.target.closest('[data-add]'); if (!b) return; const i = +b.dataset.add;
    const parent = i > 0 ? el.querySelector(`select[data-l="${i - 1}"]`).value : null;
    if (i > 0 && !parent) { toast('Select ' + P.levels[i - 1] + ' first', 'warning'); return; }
    const name = await askText('Add ' + P.levels[i] + ' (' + P.name + ')', P.levels[i] + ' name'); if (!name) return;
    const u = addUnit(prov, i, name, parent); persist(); fill(i, parent, u.id); for (let k = i + 1; k <= depth; k++) fill(k, k === i + 1 ? u.id : null, null);
    toast(P.levels[i] + ' "' + name + '" added with code ' + u.code, 'success');
  };
}
const LV_ABBR = lv => lv.split(/[\s\/-]+/).filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 3);
function addUnit(prov, level, name, parentId, silent) {
  const ex = S.units.find(u => u.province === prov && u.level === level && (u.parentId || null) === (parentId || null) && u.name.toLowerCase() === name.toLowerCase());
  if (ex) return ex;
  const u = { id: uid(), code: nextCode(prov + '-' + LV_ABBR(PROV[prov].levels[level]) + '-', 3), province: prov, level, name, parentId: parentId || null, createdAt: nowStr(), createdBy: ME?.username || 'system' };
  S.units.push(u); if (!silent) audit('units', u, 'Created', null, u); return u;
}
function readLoc(el) { const ss = [...el.querySelectorAll('select')]; let v = ''; ss.forEach(s => { if (s.value) v = s.value; }); return { v, complete: ss.length > 0 && ss.every(s => s.value) }; }

/* ---- open / read / compute / save ---- */
function visibleFields(spec, rec) { return spec.fields.filter(f => !f.when || f.when(rec)); }
function openForm(c, id, preset) {
  const spec = SPEC[c];
  if (id && !can.edit(c, byId(c, id))) { toast('This record is locked or you do not have edit rights.', 'warning'); return; }
  if (!id && !can.create()) { toast('Your role (Viewer) is read-only.', 'warning'); return; }
  const base = id ? JSON.parse(JSON.stringify(byId(c, id))) : Object.assign({}, spec.defaults ? spec.defaults() : {}, preset || {});
  if (!base.province && spec.provincial !== false) base.province = CTX !== 'ALL' ? CTX : (preset?.province || '');
  CUR = { c, id, spec, rec: base };
  renderForm();
  openModal('frm');
}
function renderForm() {
  const { c, id, spec, rec } = CUR;
  $('#fTitle').textContent = (id ? 'Edit ' : 'New ') + spec.title + (id ? ' · ' + (rec.code || '') : '');
  let head = '';
  if (spec.provincial !== false) {
    if (id || CTX !== 'ALL') head = `<div class="fg"><label>Province</label><div class="ro">${esc(provName(rec.province))}</div></div>`;
    else head = `<div class="fg"><label>Province <span class="req">*</span></label><select id="f_province" data-rr="1"><option value="">— select —</option>${Object.entries(PROV).map(([k, p]) => `<option value="${k}" ${rec.province === k ? 'selected' : ''}>${p.name}</option>`).join('')}</select></div>`;
  }
  const autoInfo = id ? `<div class="fg"><label>Record code (auto)</label><div class="ro mono">${esc(rec.code)}</div></div>` : `<div class="fg"><label>Record code</label><div class="ro note">Auto-generated on save</div></div>`;
  $('#fBody').innerHTML = (spec.formNote ? `<div class="demo-banner">ℹ ${spec.formNote}</div>` : '') + `<div class="fgrid">${head}${spec.noCode ? '' : autoInfo}${visibleFields(spec, rec).map(f => fieldHTML(f, rec[f.k], rec)).join('')}</div>`;
  visibleFields(spec, rec).filter(f => f.t === 'loc').forEach(f => initLoc(f, rec));
  $('#fBody').oninput = formCompute;
  $('#fBody').onchange = e => { if (e.target.dataset.rr) { const { vals } = readForm(true); CUR.rec = Object.assign(CUR.rec, vals); if (e.target.id === 'f_province') CUR.rec.province = e.target.value; renderForm(); } else formCompute(); };
  formCompute();
}
function readForm(loose) {
  const { spec } = CUR; const rec = CUR.rec; const vals = {}; const errs = [];
  const pe = $('#f_province'); if (pe) vals.province = pe.value;
  const r2 = Object.assign({}, rec, vals);
  visibleFields(spec, r2).forEach(f => {
    if (['sec', 'calc', 'ro'].includes(f.t)) return;
    const el = document.getElementById('f_' + f.k); const sub = document.querySelector(`[data-sub="${f.k}"]`);
    let v;
    if (f.t === 'sub') v = sub ? readSub(sub, f) : [];
    else if (!el) return;
    else if (f.t === 'multiref') v = [...el.selectedOptions].map(o => o.value);
    else if (f.t === 'checks') v = [...el.querySelectorAll('input:checked')].map(i => i.value);
    else if (f.t === 'loc') { const r = readLoc(el); v = r.v; if (f.req && !r.complete && !loose) { errs.push(FL(f, r2) + ' (all levels)'); el.classList.add('err'); } }
    else if (f.t === 'number' || f.t === 'area') v = el.value === '' ? null : parseFloat(el.value);
    else v = el.value.trim ? el.value.trim() : el.value;
    vals[f.k] = v;
    const empty = v == null || v === '' || (Array.isArray(v) && !v.length);
    if (f.req && empty && !loose) { errs.push(FL(f, r2)); (el || sub)?.classList.add('err'); } else if (el && f.t !== 'loc') el.classList.remove('err');
  });
  if (!loose && spec.provincial !== false && !(vals.province || rec.province)) errs.push('Province');
  return { vals, errs };
}
function formCompute() {
  if (!CUR) return; const { vals } = readForm(true); const r = Object.assign({}, CUR.rec, vals);
  visibleFields(CUR.spec, r).filter(f => f.t === 'area').forEach(f => { const e = document.querySelector(`[data-comp="${f.k}__ag"]`); if (e) e.textContent = r[f.k] != null ? '= ' + areaTxt(r[f.k], r.province) : ''; });
  const out = CUR.spec.compute ? CUR.spec.compute(r) : {};
  Object.entries(out).forEach(([k, v]) => { const e = document.querySelector(`[data-comp="${k}"]`); if (e) e.innerHTML = v; });
  // per-row calc cells
  $$('#fBody [data-sub]').forEach(sub => { const f = CUR.spec.fields.find(x => x.k === sub.dataset.sub); if (!f?.rowCalc) return; sub.querySelectorAll('tbody tr').forEach(tr => { const o = {}; f.cols.forEach(c => { const e = tr.querySelector(`[data-c="${c.k}"]`); if (e) o[c.k] = e.value; }); const res = f.rowCalc(o, r); Object.entries(res).forEach(([k, v]) => { const e = tr.querySelector(`[data-cc="${k}"]`); if (e) e.textContent = v; }); }); });
}
function saveForm() {
  const { c, id, spec } = CUR; const { vals, errs } = readForm(false);
  if (errs.length) { toast('Please complete required fields: ' + errs.join(', '), 'error'); return; }
  const rec = Object.assign({}, CUR.rec, vals);
  if (spec.prepare) spec.prepare(rec);
  const err = spec.validate ? spec.validate(rec, id) : null;
  if (err) { toast(err, 'error'); return; }
  if (id) {
    const i = S[c].findIndex(r => r.id === id); const before = S[c][i];
    const ver = r => (r.history || []).length + '|' + (r.updatedAt || '');
    if (!before) { toast('This record was deleted by another user.', 'error'); closeModal('frm'); return; }
    if (ver(before) !== ver(CUR.rec)) { toast('Save blocked: ' + before.code + ' was changed by ' + (before.updatedBy || (before.history || []).at(-1)?.user || 'another user') + ' after you opened it. Close and re-open to see the latest version (optimistic locking).', 'error'); return; }
    rec.updatedAt = nowStr(); rec.updatedBy = ME.username; pushHist(rec, 'Edited', rec.stage, rec.stage);
    S[c][i] = rec; audit(c, rec, 'Updated', before, rec);
    spec.afterSave && spec.afterSave(rec, before);
    toast(spec.title + ' ' + rec.code + ' updated', 'success');
  } else {
    rec.id = uid(); rec.code = spec.code ? spec.code(rec) : nextCode(spec.prefix); rec.createdAt = nowStr(); rec.createdBy = ME.username;
    if (WF[c]) rec.stage = WF[c].stages[0];
    rec.history = []; pushHist(rec, 'Created', '', rec.stage || '');
    S[c].push(rec); audit(c, rec, 'Created', null, rec);
    spec.afterSave && spec.afterSave(rec, null);
    toast(spec.title + ' ' + rec.code + ' created', 'success');
  }
  persist(); closeModal('frm'); CUR = null; render();
}
async function deleteRec(c, id) {
  const r = byId(c, id); const spec = SPEC[c];
  if (!can.del(c, r)) { toast(isRole('Admin') ? 'Submitted / approved records cannot be deleted — use Cancel or Stop so the number stays in the register.' : 'Only an Admin can delete records.', 'warning'); return; }
  const used = spec.usage ? spec.usage(r) : '';
  if (used) { toast('Cannot delete ' + r.code + ': it is referenced by ' + used + '.', 'error'); return; }
  const note = await askNote('Delete ' + spec.title + ' ' + r.code + '?', 'Reason for deletion (kept in audit trail)', true); if (note == null) return;
  S[c] = S[c].filter(x => x.id !== id); audit(c, r, 'Deleted', r, null, note);
  S.documents.filter(d => d.recId === id).forEach(d => { d.deleted = true; });
  persist(); toast(spec.title + ' ' + r.code + ' deleted', 'warning'); closeModal('view'); render();
}

/* ---------- workflow actions ---------- */
async function wfAdvance(c, id) {
  const r = byId(c, id); const w = WF[c]; const i = stageIdx(c, r); const to = w.stages[i + 1];
  const blk = advanceBlock(c, r); if (blk) { toast(blk, 'warning'); return; }
  const g = SPEC[c].guard ? SPEC[c].guard(r, to) : null; if (g) { toast(g, 'error'); return; }
  const label = (w.step && w.step[to]) || to;
  const note = await askNote((i === 0 ? 'Submit' : 'Approve') + ' → ' + label); if (note == null) return;
  const before = JSON.parse(JSON.stringify(r)); const from = r.stage; r.stage = to; pushHist(r, i === 0 ? 'Submitted' : 'Approved', from, to, note);
  SPEC[c].onStage && SPEC[c].onStage(r, to); notifyNext(c, r);
  audit(c, r, 'Workflow: ' + from + ' → ' + stLabel(to), before, r, note); persist(); toast(r.code + ' moved to "' + stLabel(to) + '"' + (stageIdx(c, r) < WF[c].stages.length - 1 ? ' — next officers notified (email/SMS simulated)' : ''), 'success'); refreshView(c, id);
}
async function wfReturn(c, id) {
  const r = byId(c, id); if (!canReturn(c, r)) return; const i = stageIdx(c, r); const to = WF[c].stages[i - 1];
  const note = await askNote('Return ' + r.code + ' to "' + to + '"', 'Reason for return', true); if (note == null) return;
  const before = JSON.parse(JSON.stringify(r)); const from = r.stage; r.stage = to; pushHist(r, 'Returned', from, to, note); audit(c, r, 'Workflow return: ' + from + ' → ' + to, before, r, note); persist(); refreshView(c, id);
}
async function wfTerminal(c, id, kind) { // Cancel / Stop
  const r = byId(c, id); if (!can.approve()) { toast('Only Approver/Admin can ' + kind.toLowerCase() + '.', 'warning'); return; }
  if (c === 'cases' && S.payments.some(p => p.caseId === id && p.stage === 'Released')) { toast('Case has released payments — it cannot be cancelled. Raise an adjustment / recovery instead.', 'error'); return; }
  if (c === 'cases' && S.payments.some(p => p.caseId === id && !TERMINAL.includes(p.stage))) { toast('Stop the pending payment requests of this case first.', 'warning'); return; }
  const note = await askNote(kind + ' ' + r.code + '?', 'Reason (mandatory, kept in register)', true); if (note == null) return;
  const before = JSON.parse(JSON.stringify(r)); const from = r.stage; r.stage = kind === 'Cancel' ? 'Cancelled' : 'Stopped'; r.status = r.stage;
  pushHist(r, kind === 'Cancel' ? 'Cancelled' : 'Stopped', from, r.stage, note); audit(c, r, kind, before, r, note); persist(); toast(r.code + ' ' + r.stage.toLowerCase(), 'warning'); refreshView(c, id);
}
async function wfEscalate(c, id) {
  const r = byId(c, id); if (isRole('Viewer')) return; const note = await askNote('Escalate ' + r.code, 'Escalation reason / escalated to', true); if (note == null) return;
  const before = JSON.parse(JSON.stringify(r)); r.escalated = true; r.escalationLevel = (r.escalationLevel || 0) + 1; pushHist(r, 'Escalated (level ' + r.escalationLevel + ')', r.stage, r.stage, note); audit(c, r, 'Escalated', before, r, note); persist(); refreshView(c, id);
}

/* ---------- documents / attachments (SoW §3.4, 3.6, 3.7: upload, edit, delete with history) ---------- */
const MAX_STORE_BYTES = 450 * 1024;
function attachFiles(c, id, files) {
  if (!can.upload()) { toast('Viewer role cannot upload documents.', 'warning'); return; }
  const r = byId(c, id); let n = 0;
  [...files].forEach(file => {
    const doc = { id: uid(), code: nextCode('DOC-', 5), coll: c, recId: id, recCode: r?.code, name: file.name, size: file.size, type: file.type || 'application/octet-stream', category: guessDocCat(file.name), version: 1, uploadedBy: ME.username, at: nowStr(), deleted: false, stored: false, history: [{ at: nowStr(), user: ME.username, action: 'Uploaded' }] };
    const prev = S.documents.find(d => d.recId === id && d.name === file.name && !d.deleted); if (prev) { doc.version = prev.version + 1; prev.deleted = true; prev.history.push({ at: nowStr(), user: ME.username, action: 'Superseded by v' + doc.version }); }
    S.documents.push(doc); n++;
    if (file.size <= MAX_STORE_BYTES) { const fr = new FileReader(); fr.onload = () => { doc.data = fr.result; doc.stored = true; persist(); }; fr.readAsDataURL(file); }
    audit('documents', doc, 'Uploaded to ' + (r?.code || ''), null, { name: doc.name, size: doc.size });
  });
  persist(); toast(n + ' document(s) attached to ' + (r?.code || ''), 'success'); refreshView(c, id);
}
function guessDocCat(n) { n = n.toLowerCase(); if (/cnic|nic/.test(n)) return 'CNIC Copy'; if (/fard|ror|vii|7b/.test(n)) return 'Record of Rights / Fard'; if (/lease|agreement/.test(n)) return 'Agreement'; if (/consent/.test(n)) return 'Consent Form'; if (/\.(jpg|jpeg|png|heic)$/.test(n)) return 'Photograph'; if (/km[lz]$/.test(n)) return 'GIS File'; if (/measure/.test(n)) return 'Measurement Report'; return 'Supporting Document'; }
async function docDelete(docId) {
  const d = S.documents.find(x => x.id === docId); if (!d || !can.upload()) return;
  const note = await askNote('Remove document "' + d.name + '"?', 'Reason (document is kept in history as deleted)', true); if (note == null) return;
  d.deleted = true; d.history.push({ at: nowStr(), user: ME.username, action: 'Deleted', note }); audit('documents', d, 'Deleted', { deleted: false }, { deleted: true }, note); persist(); refreshView(d.coll, d.recId); if (SCREEN === 'documents') render();
}
async function docRename(docId) {
  const d = S.documents.find(x => x.id === docId); if (!d || !can.upload()) return;
  const v = await dialog({ title: 'Edit document details', html: `<div class="fg"><label>Document name</label><input data-k="name" value="${esc(d.name)}"></div><div class="fg u-mt-10"><label>Category</label><select data-k="category">${DOC_CATS.map(x => `<option ${x === d.category ? 'selected' : ''}>${x}</option>`).join('')}</select></div>` });
  if (!v) return; const before = { name: d.name, category: d.category }; d.name = v.name || d.name; d.category = v.category; d.history.push({ at: nowStr(), user: ME.username, action: 'Edited details' }); audit('documents', d, 'Edited', before, { name: d.name, category: d.category }); persist(); refreshView(d.coll, d.recId); if (SCREEN === 'documents') render();
}
const DOC_CATS = ['Record of Rights / Fard', 'CNIC Copy', 'Consent Form', 'Agreement', 'Measurement Report', 'Power of Attorney', 'DC / Revenue Report', 'Photograph', 'GIS File', 'Court Document', 'Correspondence', 'Supporting Document'];
function docOpen(docId) {
  const d = S.documents.find(x => x.id === docId); if (!d) return;
  if (!d.stored || !d.data) { toast('Demo storage keeps file contents up to 450 KB only; this file\'s metadata is recorded. Production stores all files in the document repository.', 'info'); return; }
  const a = document.createElement('a'); a.href = d.data; a.download = d.name; a.click();
}
function docsFor(id) { return S.documents.filter(d => d.recId === id); }

/* ---------- number to words (receipts) ---------- */
function words(n) {
  n = Math.round(num(n)); if (n === 0) return 'Zero';
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const h = x => { let s = ''; if (x >= 100) { s += a[Math.floor(x / 100)] + ' Hundred '; x %= 100; } if (x >= 20) { s += b[Math.floor(x / 10)] + ' '; x %= 10; } if (x > 0) s += a[x] + ' '; return s; };
  let s = ''; [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand']].forEach(([v, w]) => { if (n >= v) { s += h(Math.floor(n / v)) + w + ' '; n %= v; } }); s += h(n);
  return s.trim();
}

/* ---------- export helpers ---------- */
function exportXLSX(name, headers, rows) {
  try { const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 30).replace(/[\\\/\?\*\[\]:]/g, '')); XLSX.writeFile(wb, 'LMS_' + name.replace(/\s+/g, '_') + '_' + today() + '.xlsx'); toast('Excel exported', 'success'); }
  catch (e) { toast('Excel export failed: ' + e.message, 'error'); }
}
function exportPDF(title, headers, rows, sub) {
  try {
    const { jsPDF } = window.jspdf; const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    doc.setFontSize(14); doc.setTextColor(22, 70, 122); doc.text('Land Management System — ' + title, 14, 14);
    doc.setFontSize(9); doc.setTextColor(90); doc.text((S.settings.company || '') + ' · Province: ' + (CTX === 'ALL' ? 'All' : provName(CTX)) + ' · Generated ' + fdtt(new Date()) + ' by ' + ME.fullName + (sub ? ' · ' + sub : ''), 14, 20);
    doc.autoTable({ startY: 25, head: [headers], body: rows.map(r => r.map(x => x == null ? '' : String(x))), theme: 'striped', headStyles: { fillColor: [22, 70, 122], fontSize: 7.5 }, bodyStyles: { fontSize: 7 }, margin: { left: 10, right: 10 } });
    doc.save('LMS_' + title.replace(/\s+/g, '_') + '_' + today() + '.pdf'); toast('PDF exported', 'success');
  } catch (e) { toast('PDF export failed: ' + e.message, 'error'); }
}
function printHTML(title, body) {
  const fr = document.createElement('iframe'); fr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'; document.body.appendChild(fr);
  const d = fr.contentWindow.document;
  d.open();
  d.write(`<!doctype html><html><head><meta charset="utf-8">`
    + `<title>${esc(title)}</title>`
    + `<link rel="stylesheet" href="${PRINT_CSS}">`
    + `</head><body>${body}`
    + `<p class="small p-mt-20">Generated by Land Management System (demo build ${APP_VER})`
    + ` on ${fdtt(new Date())} · ${esc(ME.fullName)}</p>`
    + `</body></html>`);
  d.close(); printWhenReady(fr, d);
}
