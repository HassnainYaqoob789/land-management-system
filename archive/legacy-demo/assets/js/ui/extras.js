/* Icons, user switch, approval matrix, notifications, calendar, project dashboard, Urdu prints
   Part of the LMS multi-page build. Loaded as a classic script;
   top-level declarations are shared across the bundle. */
/* =====================================================================
   v3 ADDITIONS — icons, demo user switch, approval matrix, architecture,
   calendar, project dashboard, notifications, Urdu prints, volume test
   ===================================================================== */
/* ---------- professional line icons (replace emoji at render time) ---------- */
const ICONS = {
  dash: '<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  bank: '<path d="M3 22h18M6 18v-7M10 18v-7M14 18v-7M18 18v-7M12 2l9 5H3z"/>',
  rig: '<path d="M12 2v5M8 7h8l3 15H5z"/><path d="M7 14h10M9.5 7l5 7M14.5 7l-5 7"/>',
  map: '<path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15M15 6v15"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  clip: '<rect x="5" y="4" width="14" height="18" rx="2"/><path d="M9 4V2h6v2M9 11h6M9 15h6"/>',
  doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  scale: '<path d="M12 3v18M5 21h14M3 7h18M6 7l-3 7a3 3 0 0 0 6 0zM18 7l-3 7a3 3 0 0 0 6 0z"/>',
  route: '<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/>',
  warn: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  repeat: '<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  wallet: '<rect x="2" y="6" width="20" height="14" rx="2"/><path d="M2 10h20M16 15h2"/>',
  bldg: '<rect x="4" y="2" width="16" height="20" rx="1"/><path d="M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
  mega: '<path d="M3 11l18-5v12L3 14z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  calc: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  down: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  up: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  receipt: '<path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 3 2V2l-3 2-3-2-3 2-3-2-3 2z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  compass: '<circle cx="12" cy="12" r="10"/><path d="M16.2 7.8l-2.1 6.3-6.3 2.1 2.1-6.3z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  layers: '<path d="M12 2l10 5-10 5L2 7z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  print: '<path d="M6 9V2h12v7"/><rect x="6" y="14" width="12" height="8"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>',
  swap: '<path d="M16 3l4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
  esc: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  attach: '<path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/>',
  ruler: '<path d="M21.3 8.7L8.7 21.3a1 1 0 0 1-1.4 0l-4.6-4.6a1 1 0 0 1 0-1.4L15.3 2.7a1 1 0 0 1 1.4 0l4.6 4.6a1 1 0 0 1 0 1.4z"/><path d="M7.5 10.5l2 2M10.5 7.5l2 2M13.5 4.5l2 2"/>',
  poly: '<path d="M12 2l10 7-4 13H6L2 9z"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  pkg: '<path d="M21 16V8l-9-5-9 5v8l9 5z"/><path d="M3.3 7L12 12l8.7-5M12 22V12"/>',
  cbox: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 12l2 2 4-4"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  flask: '<path d="M9 2v7.3L3.5 19a2 2 0 0 0 1.8 3h13.4a2 2 0 0 0 1.8-3L15 9.3V2M8 2h8"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  img: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/>',
  exit: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  zap: '<path d="M13 2L3 14h9l-1 8 10-12h-9z"/>',
  pen: '<path d="M3 17l6-6 4 4 8-8"/><circle cx="3" cy="17" r="1.5"/><circle cx="21" cy="7" r="1.5"/>'
};
const EMO = { '📊': 'dash', '🎯': 'target', '🔔': 'bell', '🗓': 'cal', '📅': 'cal', '📍': 'pin', '🏛': 'bank', '🛢': 'rig', '🗺': 'map', '👤': 'user', '📋': 'clip', '📝': 'doc', '⚖': 'scale', '🛤': 'route', '⚠': 'warn', '🔁': 'repeat', '💰': 'wallet', '🏢': 'bldg', '📈': 'trend', '📢': 'mega', '🧮': 'calc', '📁': 'folder', '📥': 'down', '📤': 'up', '⬇': 'down', '🧾': 'receipt', '🔐': 'lock', '🔒': 'lock', '🧭': 'compass', '⚙': 'gear', '🏗': 'layers', '✏': 'edit', '🗑': 'trash', '👁': 'eye', '📄': 'file', '📕': 'file', '🖨': 'print', '⇄': 'swap', '🌙': 'moon', '☀': 'sun', '➤': 'send', '✔': 'check', '↩': 'undo', '✗': 'x', '⏹': 'stop', '⇪': 'esc', '📎': 'attach', '🔍': 'search', '📏': 'ruler', '⬠': 'poly', '💾': 'save', '📦': 'pkg', '☑': 'cbox', 'ℹ': 'info', '🧪': 'flask', '🔗': 'link', '🖼': 'img', '🇵🇰': 'globe', '🗂': 'inbox', '🚪': 'exit', '⚡': 'zap', '〰': 'pen', '🎉': '', '📨': 'send' };
const EMO_RE = new RegExp('(' + Object.keys(EMO).sort((a, b) => b.length - a.length).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\uFE0F?', 'gu');
const svgIcon = n => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;
function iconize(root) {
  if (!root) return; const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const nodes = [];
  while (w.nextNode()) { const n = w.currentNode; EMO_RE.lastIndex = 0; if (EMO_RE.test(n.nodeValue)) nodes.push(n); }
  nodes.forEach(n => {
    const p = n.parentNode; if (!p) return; EMO_RE.lastIndex = 0;
    if (['OPTION', 'TEXTAREA', 'SCRIPT', 'STYLE', 'TITLE'].includes(p.nodeName) || (p.closest && p.closest('select'))) { n.nodeValue = n.nodeValue.replace(EMO_RE, '').replace(/^\s+/, ''); return; }
    const frag = document.createDocumentFragment(); const parts = n.nodeValue.split(EMO_RE);
    parts.forEach((part, i) => { if (!part) return; if (i % 2 === 1) { const k = EMO[part]; if (k) { const sp = document.createElement('span'); sp.className = 'ico'; sp.innerHTML = svgIcon(k); frag.appendChild(sp); } } else frag.appendChild(document.createTextNode(part)); });
    p.replaceChild(frag, n);
  });
}

/* ---------- demo: switch user (presenter helper) ---------- */
function switchUser(un, keepView) {
  const u = S.users.find(x => x.username === un); if (!u) return; const prevView = keepView && VIEW ? { ...VIEW } : null;
  audit('users', u, 'Signed in (demo user switch from ' + (ME?.username || '-') + ')'); ME = u; ME._prevLogin = u.lastLogin; u.lastLogin = nowStr(); persist();
  $('#uAv').textContent = u.fullName.charAt(0); $('#uName').textContent = u.fullName; $('#uRole').textContent = u.role + ' · ' + ((u.groups || [])[0] || u.position);
  $('#uInfo').innerHTML = `Signed in: <b>${fdtt(u.lastLogin)}</b><br>Approval groups: <b>${esc((u.groups || []).join(', '))}</b><br>Rights: ${esc(ROLES[u.role])}`;
  buildNav(); if (!$('#nav [data-k="' + SCREEN + '"]')) SCREEN = 'dashboard'; render();
  toast('Now signed in as ' + u.fullName + ' — ' + ((u.groups || [])[0] || u.role), 'success');
  if (prevView && byId(prevView.c, prevView.id)) openView(prevView.c, prevView.id);
}
async function switchUserDialog() {
  const v = await dialog({ title: 'Switch user (demo)', html: `<div class="fg"><label>Sign in as</label><select data-k="u">${S.users.filter(u => u.status === 'Active').map(u => `<option value="${esc(u.username)}" ${u.username === ME.username ? 'selected' : ''}>${esc(u.fullName)} — ${esc((u.groups || []).join(', '))} (${esc(u.role)})</option>`).join('')}</select><small>Presenter helper to demonstrate segregation of duties. Disable in Settings for production-like demos.</small></div>`, ok: 'Switch' });
  if (v && v.u) switchUser(v.u, true);
}
function saveGov() {
  const before = { sod: S.settings.sod, adminOverride: S.settings.adminOverride, presentation: S.settings.presentation, demoSwitch: S.settings.demoSwitch };
  S.settings.sod = $('#stSod').value; S.settings.adminOverride = $('#stAo').value === '1'; S.settings.presentation = $('#stPm').value === '1'; S.settings.demoSwitch = $('#stDs').value === '1';
  audit('settings', { code: 'GOVERNANCE' }, 'Governance settings updated', before, { sod: S.settings.sod, adminOverride: S.settings.adminOverride, presentation: S.settings.presentation, demoSwitch: S.settings.demoSwitch }); persist(); toast('Governance settings saved', 'success'); render();
}

/* ---------- approval matrix (SoW §3.8 configurable, §4.2 nominated positions) ---------- */
function scrMatrix() {
  const M = S.settings.matrix; const ed = can.admin();
  const rows = Object.entries(WF).flatMap(([c, w]) => w.stages.slice(1).map(st => ({ c, st, label: (w.step && w.step[st]) || stLabel(st) })));
  return `<div class="card"><div class="card-h"><div><h3>🧭 Approval matrix</h3><p>Who may perform each workflow step — assigned to positions / departments (SoW §3.8, §4.2). Segregation of duties: <b>${{ strict: 'strict', creator: 'basic', off: 'off' }[S.settings.sod]}</b> · Admin override: <b>${S.settings.adminOverride ? 'on' : 'off'}</b> (Settings). Changes are audited.</p></div>
  ${ed ? `<div class="bar u-m-0"><button class="btn btn-p" data-act="saveMatrix">💾 Save matrix</button><button class="btn btn-s" data-act="resetMatrix">↩ Restore default</button></div>` : ''}</div>
  <div class="tw u-mh-none"><table class="t matrix"><thead><tr><th class="u-ta-left">Process</th><th class="u-ta-left">Step</th>${GROUPS.map(g => `<th class="u-wrap-84">${esc(g)}</th>`).join('')}<th>Officers</th></tr></thead><tbody>
  ${rows.map(({ c, st, label }) => { const gs = (M[c] && M[c][st]) || []; return `<tr><td class="u-ta-left"><b>${esc(SPEC[c].title)}</b></td><td class="u-ta-left">${esc(label)}</td>${GROUPS.map(g => `<td><input type="checkbox" data-mx="${c}|${esc(st)}|${esc(g)}" ${gs.includes(g) ? 'checked' : ''} ${ed ? '' : 'disabled'}></td>`).join('')}<td class="u-fs-115 u-ta-left">${esc(usersInGroups(gs).map(u => u.fullName).join(', ') || '— nobody assigned —')}</td></tr>`; }).join('')}
  </tbody></table></div><p class="note u-mt-8">The first stage of each process (preparing / registering the record) is open to all data-entry users. Steps with no position ticked can be performed by any non-viewer.</p></div>`;
}
function saveMatrix() {
  if (!can.admin()) return; const before = JSON.parse(JSON.stringify(S.settings.matrix)); const M = {};
  $$('[data-mx]').forEach(i => { const [c, st, g] = i.dataset.mx.split('|'); M[c] = M[c] || {}; M[c][st] = M[c][st] || []; if (i.checked) M[c][st].push(g); });
  const empty = Object.entries(M).flatMap(([c, o]) => Object.entries(o).filter(([, g]) => !g.length).map(([st]) => SPEC[c].title + ' → ' + stLabel(st)));
  S.settings.matrix = M; audit('settings', { code: 'APPROVAL-MATRIX' }, 'Approval matrix updated', before, M); persist();
  toast('Approval matrix saved' + (empty.length ? ' — open steps (no position): ' + empty.slice(0, 3).join('; ') + (empty.length > 3 ? '…' : '') : ''), empty.length ? 'warning' : 'success'); render();
}
async function resetMatrix() { if (!(await confirmBox('Restore default matrix?', 'Replace the current approval matrix with the default assignment?', 'Restore', false))) return; const before = S.settings.matrix; S.settings.matrix = JSON.parse(JSON.stringify(MATRIX_DEFAULT)); audit('settings', { code: 'APPROVAL-MATRIX' }, 'Approval matrix reset to default', before, S.settings.matrix); persist(); render(); }

/* ---------- notifications (simulated email / SMS) ---------- */
function scrNotif() {
  const mine = S.notifications.filter(n => n.to === ME.username && noteVisible(n)).slice(0, 12); const all = S.notifications.filter(noteVisible).slice(0, 40);
  return `<div class="grid2 u-mt-16"><div class="card"><div class="card-h"><div><h3>📨 My notifications (${S.notifications.filter(n => n.to === ME.username && noteVisible(n)).length})</h3><p>Sent automatically when a record reaches a step assigned to your position</p></div></div>
  ${mine.map(n => `<a class="al i" href="${pageUrl(n.coll)}?view=${encodeURIComponent(n.recId)}" data-act="openView" data-a1="${n.coll}" data-a2="${n.recId}"><span class="i"></span><div class="tx"><b>${esc(n.msg)}</b><small>${fdtt(n.at)} · ${esc(n.channel)}</small></div></a>`).join('') || '<div class="empty">No notifications for you</div>'}</div>
  <div class="card"><div class="card-h"><div><h3>Notification log</h3><p>Email + SMS dispatch log — <b>simulated in demo</b>; production uses Mari SMTP / SMS gateway</p></div></div>
  <div class="tw u-mh-340"><table class="t"><thead><tr><th>When</th><th>To</th><th>Channel</th><th>Message</th><th>Status</th></tr></thead><tbody>${all.map(n => `<tr><td class="u-nowrap">${fdtt(n.at)}</td><td>${esc(n.toName)}</td><td>${esc(n.channel)}</td><td>${esc(n.msg)}</td><td><span class="b b-g">${esc(n.status)}</span></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No notifications yet</td></tr>'}</tbody></table></div></div></div>`;
}
function remind(c, id) { const r = byId(c, id); const gs = WF[c] ? stepGroups(c, WF[c].stages[stageIdx(c, r) + 1] || '') : []; const users = gs.length ? usersInGroups(gs) : S.users.filter(u => ['Manager Land (HO)', 'DM / Team Lead (Field)'].some(g => (u.groups || []).includes(g)));
  users.forEach(u => S.notifications.unshift({ id: uid(), at: nowStr(), to: u.username, toName: u.fullName, channel: 'Email + SMS', coll: c, recId: id, code: r.code, msg: 'Reminder: ' + SPEC[c].title + ' ' + r.code + ' requires attention', status: 'Sent (simulated)' }));
  persist(); toast('Reminder sent to ' + users.map(u => u.fullName).join(', ') + ' (simulated email + SMS)', 'success'); }

/* ---------- calendar (SoR demo Sc 9) ---------- */
function calEvents() {
  const E = []; const add = (d, type, t, c, id, col) => { if (d) E.push({ d, type, t, c, id, col }); };
  ctxRows('leases').filter(l => l.stage !== 'Stopped').forEach(l => { const i = leaseInfo(l); add(i.end, 'Lease expiry', `${l.code} expires`, 'leases', l.id, '#d93a3a');
    if (l.startDate) { const a = new Date(l.startDate); const t = new Date(today()); while (a <= t) a.setFullYear(a.getFullYear() + 1); if (iso(a) < i.end) add(iso(a), 'Rent due', `${l.code} annual rent due (${rs(i.rent)})`, 'leases', l.id, '#2368b0'); } });
  ctxRows('rows').filter(r => r.stage !== 'Stopped').forEach(r => add(rowInfo(r).next, 'ROW renewal', `${r.code} yearly renewal`, 'rows', r.id, '#7a4fc2'));
  ctxRows('legal').filter(legalOpen).forEach(l => add(l.nextHearing, 'Hearing', `Hearing ${l.caseNo} — ${l.court}`, 'legal', l.id, '#b45309'));
  ctxRows('grievances').filter(g => !['Resolved', 'Closed'].includes(g.stage)).forEach(g => add(g.dueDate, 'Grievance due', `${g.code} target date`, 'grievances', g.id, '#e09a1a'));
  ctxRows('dbpfc').forEach(d => add(d.meetingDate, 'DBPFC', `${d.code} committee meeting`, 'dbpfc', d.id, '#16a061'));
  ctxRows('acquisitions').filter(a => !isLocked('acquisitions', a)).forEach(a => add(a.targetDate, 'Handover target', `${a.code} target handover`, 'acquisitions', a.id, '#1597a6'));
  return E;
}
function scrCalendar() {
  const base = UI.calM ? new Date(UI.calM) : new Date(); base.setDate(1); const y = base.getFullYear(), m = base.getMonth();
  const E = calEvents(); const first = (new Date(y, m, 1).getDay() + 6) % 7; const days = new Date(y, m + 1, 0).getDate(); const td = today();
  let cells = ''; for (let i = 0; i < first; i++) cells += '<div class="cal-d off"></div>';
  for (let d = 1; d <= days; d++) { const ds = iso(new Date(y, m, d)); const ev = E.filter(e => e.d === ds);
    cells += `<div class="cal-d ${ds === td ? 'today' : ''}"><div class="n">${d}</div>${ev.slice(0, 4).map(e => `<div class="cal-e" title="${esc(e.type + ': ' + e.t)}" data-act="openView" data-a1="${e.c}" data-a2="${e.id}" data-accent="${esc(e.col)}">${esc(e.t)}</div>`).join('')}${ev.length > 4 ? `<div class="note">+${ev.length - 4} more</div>` : ''}</div>`; }
  const up = E.filter(e => e.d >= td && daysTo(e.d) <= 45).sort((a, b) => a.d.localeCompare(b.d));
  const types = uniq(E.map(e => e.type + '|' + e.col));
  return `<div class="split u-split-330"><div class="card"><div class="card-h"><div><h3>🗓 Land calendar — ${base.toLocaleString('en-GB', { month: 'long', year: 'numeric' })}</h3><p>Lease expiries, rent due dates, ROW renewals, court hearings, grievance targets, DBPFC meetings, handover targets</p></div>
  <div class="bar u-m-0"><button class="btn btn-s btn-sm" data-act="setCalMonth" data-a1="${y}" data-a2="${m - 1}">‹</button><button class="btn btn-s btn-sm" data-act="setCalMonth">Today</button><button class="btn btn-s btn-sm" data-act="setCalMonth" data-a1="${y}" data-a2="${m + 1}">›</button></div></div>
  <div class="cal-h">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div>${d}</div>`).join('')}</div><div class="cal">${cells}</div>
  <div class="bar u-mt-10">${types.map(t => { const [n, c] = t.split('|'); return `<span class="pill" data-accent-full="${esc(c)}">${esc(n)}</span>`; }).join('')}</div></div>
  <div class="card"><div class="card-h"><div><h3>Next 45 days (${up.length})</h3><p>Click to open · send reminder to responsible officers</p></div></div>
  ${up.map(e => `<div class="al" data-accent-full="${esc(e.col)}"><div class="tx" data-act="openView" data-a1="${e.c}" data-a2="${e.id}"><b>${fdt(e.d)}</b> · ${esc(e.type)}<small>${esc(e.t)} · in ${daysTo(e.d)} day(s)</small></div>${!isRole('Viewer') ? `<button class="btn btn-s btn-sm" data-act="remind" data-stop="1" data-a1="${esc(e.c)}" data-a2="${esc(e.id)}">📨</button>` : ''}</div>`).join('') || '<div class="empty">Nothing due</div>'}</div></div>`;
}

/* ---------- project dashboard (SoW §3.9 project-based dashboard) ---------- */
function scrProjDash() {
  const P = ctxRows('projects'); if (!P.length) return '<div class="card empty">No projects</div>';
  if (!UI.pd || !P.some(p => p.id === UI.pd)) UI.pd = P[0].id; const p = byId('projects', UI.pd); const yr = new Date().getFullYear();
  const SV = S.surveys.filter(s => (s.projectIds || []).includes(p.id)); const CS = S.cases.filter(c => c.projectId === p.id); const PY = S.payments.filter(x => x.projectId === p.id);
  const LS = S.leases.filter(l => l.projectId === p.id); const GR = S.grievances.filter(g => g.projectId === p.id); const EN = S.encroachments.filter(e => e.projectId === p.id); const LG = S.legal.filter(l => l.projectId === p.id || (l.surveyIds || []).some(s => SV.some(v => v.id === s)));
  const RW = S.rows.filter(r => r.projectId === p.id); const owners = uniq(SV.flatMap(s => ownersOfSurvey(s.id).map(l => l.id)));
  const appr = CS.filter(c => c.stage === 'HO Approved'); const b = budgetFor(p.id, yr);
  const held = sum(appr, c => caseTotals(c).leaseArea); const paid = sum(PY.filter(x => x.stage === 'Released'), 'net'); const pend = sum(PY.filter(x => ['Requested', 'Verified'].includes(x.stage)), 'net');
  const al = alerts().filter(a => { const r = byId(a.c, a.id); return r && (r.projectId === p.id || (a.c === 'surveys' && (r.projectIds || []).includes(p.id))); });
  return `<div class="card"><div class="bar u-m-0"><b>Project:</b><select class="sel u-minw-380" data-act="setProjectPick">${P.map(x => `<option value="${x.id}" ${x.id === p.id ? 'selected' : ''}>${esc(x.code + ' — ' + x.name)}</option>`).join('')}</select>
   <span class="pill">${esc(p.type)}</span><span class="pill">${esc(p.block)}</span><span class="pill">${esc(unitName(p.districtId))}, ${esc(provName(p.province))}</span>${stageBadge(p.status)}<span class="grow u-flex-1"></span>
   <button class="btn btn-s btn-sm" data-act="openView" data-a1="projects" data-a2="${p.id}">Open record</button><button class="btn btn-s btn-sm" data-act="navigate" data-href="${pageUrl('reports')}?report=r9&project=${esc(p.id)}">📈 Status report</button><button class="btn btn-s btn-sm" data-act="navigate" data-href="${pageUrl('gis')}?lat=${num(p.lat)}&lng=${num(p.lng)}">📍 Map</button></div></div>
  <div class="kpis">${kpi('Land required', p.requiredArea ? ag(p.requiredArea) + ' A-G' : '-', fmt(p.requiredArea, 2) + ' acres planned')}${kpi('Land secured', ag(held) + ' A-G', fmt(held, 2) + ' ac under approved cases · ' + SV.length + ' surveys', held >= num(p.requiredArea) * .99 ? 'g' : 'w')}
   ${kpi('Landowners', owners.length, CS.reduce((a, c) => a + (c.owners || []).length, 0) + ' case participations')}${kpi('Cases', CS.length, appr.length + ' approved · ' + CS.filter(c => !['HO Approved', 'Cancelled'].includes(c.stage)).length + ' in workflow', '')}
   ${kpi('Compensation approved', rsM(sum(appr, c => caseTotals(c).total)), 'paid ' + rsM(paid) + ' · pending ' + rsM(pend), 'g')}${kpi('Budget ' + yr, b ? fmt((b.spent + b.committed) / (b.approved || 1) * 100, 0) + '%' : 'n/a', b ? 'balance ' + rs(b.balance) : 'no budget set', b && b.balance < 0 ? 'd' : b && (b.spent + b.committed) / (b.approved || 1) > .9 ? 'w' : 'g')}
   ${kpi('Leases', LS.filter(l => leaseInfo(l).status !== 'Expired' && l.stage !== 'Stopped').length + ' active', LS.filter(l => leaseInfo(l).status === 'Expiring').length + ' expiring ≤180 d', LS.some(l => leaseInfo(l).status === 'Expiring') ? 'w' : '')}${kpi('Risks', GR.filter(g => !['Resolved', 'Closed'].includes(g.stage)).length + EN.filter(e => e.stage !== 'Resolved').length + LG.filter(legalOpen).length, `${GR.filter(g => !['Resolved', 'Closed'].includes(g.stage)).length} grievances · ${EN.filter(e => e.stage !== 'Resolved').length} encroachments · ${LG.filter(legalOpen).length} court cases`, (EN.some(e => e.stage !== 'Resolved' && ['High', 'Critical'].includes(e.risk)) || LG.some(l => l.stayOrder === 'Yes' && legalOpen(l))) ? 'd' : '')}</div>
  <div class="grid3"><div class="card"><div class="card-h"><div><h3>Compensation case pipeline</h3><p>Cases by approval stage</p></div></div><div class="chartbox"><canvas id="pd1"></canvas></div></div>
   <div class="card"><div class="card-h"><div><h3>Payments ${yr}</h3><p>Released vs pending (Rs)</p></div></div><div class="chartbox"><canvas id="pd2"></canvas></div></div>
   <div class="card"><div class="card-h"><div><h3>Land status of project surveys</h3><p>Acres by status</p></div></div><div class="chartbox"><canvas id="pd3"></canvas></div></div></div>
  <div class="grid2"><div class="card"><div class="card-h"><div><h3>Alerts for this project (${al.length})</h3></div></div>${al.map(a => `<a class="al ${a.sev}" href="${pageUrl(a.c)}?view=${encodeURIComponent(a.id)}" data-act="openView" data-a1="${a.c}" data-a2="${a.id}"><span class="i"></span><div class="tx"><b>${esc(a.t)}</b><small>${esc(a.s)}</small></div></a>`).join('') || '<div class="empty">No alerts</div>'}</div>
   <div class="card"><div class="card-h"><div><h3>Surveys & owners</h3></div></div>${miniTable(['Survey', 'Location', 'Area', 'Status', 'Owners'], SV.map(s => [vlink('surveys', s) + ' ' + esc(surveyNoTxt(s)), esc(unitName(s.unitId)), ag(s.totalArea), stageBadge(s.status), esc(ownersOfSurvey(s.id).map(l => l.name).join(', '))]))}
   ${RW.length ? '<h4 class="u-subhead-2">ROW segments</h4>' + miniTable(['ROW', 'Segment', 'L × W', 'Next renewal'], RW.map(r => [vlink('rows', r), esc(r.name), fmt(r.lengthM) + ' × ' + fmt(r.widthM) + ' m', fdt(rowInfo(r).next)])) : ''}
   ${LG.length ? '<h4 class="u-subhead-2">Court cases</h4>' + miniTable(['Ref', 'Case', 'Next hearing', 'Status'], LG.map(l => [vlink('legal', l), esc(l.caseNo + ' — ' + l.caseType), fdt(l.nextHearing), esc(l.status) + (l.stayOrder === 'Yes' && legalOpen(l) ? ' <span class="b b-d">STAY</span>' : '')])) : ''}</div></div>`;
}
function drawProjDash() {
  const p = byId('projects', UI.pd); if (!p) return; const yr = new Date().getFullYear(); const CS = S.cases.filter(c => c.projectId === p.id); const st = [...WF.cases.stages, 'Cancelled'];
  mkChart('pd1', { type: 'bar', data: { labels: st.map(stLabel), datasets: [{ label: 'Cases', data: st.map(s => CS.filter(c => c.stage === s).length), backgroundColor: st.map(s => s === 'HO Approved' ? PAL.green : s === 'Cancelled' ? PAL.red : PAL.blue) }] }, options: { plugins: { legend: { display: false } }, scales: { x: { ticks: { autoSkip: false, maxRotation: 40 } }, y: { ticks: { precision: 0 } } } } });
  const PY = S.payments.filter(x => x.projectId === p.id); const mons = [...Array(12)].map((_, i) => new Date(yr, i, 1).toLocaleString('en', { month: 'short' }));
  const inM = (x, i) => { const d = new Date(x.chequeDate || x.periodFrom); return d.getFullYear() === yr && d.getMonth() === i; };
  mkChart('pd2', { type: 'bar', data: { labels: mons, datasets: [{ label: 'Released', backgroundColor: PAL.green, data: mons.map((_, i) => sum(PY.filter(x => x.stage === 'Released' && inM(x, i)), 'net')) }, { label: 'Pending', backgroundColor: PAL.amber, data: mons.map((_, i) => sum(PY.filter(x => ['Requested', 'Verified'].includes(x.stage) && inM(x, i)), 'net')) }] }, options: { scales: { x: { stacked: true }, y: { stacked: true } } } });
  const SV = S.surveys.filter(s => (s.projectIds || []).includes(p.id));
  mkChart('pd3', { type: 'doughnut', data: { labels: LAND_STATUS, datasets: [{ data: LAND_STATUS.map(s => +sum(SV.filter(v => v.status === s), 'totalArea').toFixed(2)), backgroundColor: LAND_STATUS.map(s => ST_COL[s]) }] } });
}

/* ---------- architecture & security (for IT department) ---------- */
function scrArch() {
  const ctl = [['Role-based access (Admin / Approver / User / Viewer)', 'Shown in prototype', 'Same model; roles mapped to AD security groups'], ['Approval steps bound to positions / departments', 'Shown in prototype (Approval Matrix)', 'Configured by Mari Admin, no vendor involvement'], ['Segregation of duties (no self-approval)', 'Shown in prototype', 'Enforced server-side in workflow engine'],
    ['Field-level audit trail (before → after)', 'Shown in prototype', 'Append-only audit tables, tamper-evident, retained ≥ 7 years'], ['Optimistic locking (concurrent edits)', 'Shown in prototype', 'Row version checks in database'], ['Concurrent users / live updates', 'Shown across browser windows', 'Central database; real-time push to all users'],
    ['Authentication', 'Local demo accounts', 'Single sign-on with Mari Active Directory (LDAP / SAML / OIDC), optional MFA'], ['Encryption in transit', 'n/a (offline file)', 'TLS 1.2+ (HTTPS only), HSTS'], ['Encryption at rest', 'Browser storage', 'AES-256 database & document store encryption, encrypted backups'],
    ['Document storage', 'Up to 450 KB per file in browser', 'Encrypted object store, versioning, unlimited size, virus scanning'], ['Notifications', 'Simulated log', 'Mari SMTP server and approved SMS gateway'], ['SAP integration', 'Simulated document no.', 'Vendor master sync by landowner unique ID; payment posting & status feedback (OData / RFC / BAPI, as Mari IT prefers)'],
    ['Backup & recovery', 'Manual JSON backup', 'Daily full + hourly incremental; target RPO ≤ 1 h, RTO ≤ 4 h'], ['Hosting', 'Static HTML / CSS / JS pages run in the browser (no server)', 'MERN stack (React, Node.js / Express) with PostgreSQL + PostGIS in place of MongoDB; hosted in the Mari Energies data centre or a Mari-approved private cloud; data stays in Pakistan']];
  return `<div class="card"><div class="card-h"><div><h3>🏗 Proposed production architecture</h3><p>Prepared for Mari IT review. The demo runs as static pages in the browser, with no server or database; the production system follows this tiered design (SoR §9.1: modular, scalable, web-based, high availability).</p></div></div>
  <svg class="u-w-full u-mh-360" viewBox="0 0 1000 330" font-family="Segoe UI,Arial" font-size="12">
   ${[['PRESENTATION', 20, '#2368b0', ['Web browser (HO & field)', 'Mobile / tablet (responsive)', 'Province UI · dashboards · GIS']], ['APPLICATION', 270, '#16a061', ['REST API & business rules', 'Workflow & approval engine', 'GIS service (GeoServer)', 'Reporting & document service', 'Notifications (email / SMS)']], ['DATA', 520, '#b45309', ['PostgreSQL + PostGIS', 'Encrypted document store', 'Append-only audit store', 'Backups / DR replica']], ['INTEGRATION', 770, '#7a4fc2', ['SAP (FI / AP payments)', 'Active Directory (SSO)', 'SMTP / SMS gateway', 'Excel / KML import & export']]].map(([t, x, c, items]) => `<rect x="${x}" y="10" width="210" height="300" rx="10" fill="${c}" opacity=".08" stroke="${c}"/><text x="${x + 105}" y="34" text-anchor="middle" font-weight="700" fill="${c}">${t}</text>${items.map((it, i) => `<rect x="${x + 12}" y="${50 + i * 50}" width="186" height="38" rx="6" fill="#fff" stroke="${c}"/><text x="${x + 105}" y="${74 + i * 50}" text-anchor="middle" fill="#1b2a3d">${esc(it)}</text>`).join('')}`).join('')}
   <path d="M232 160h34" stroke="#5f6f84" stroke-width="2" marker-end="url(#ar)"/><path d="M482 160h34" stroke="#5f6f84" stroke-width="2" marker-end="url(#ar)"/><path d="M732 160h34" stroke="#5f6f84" stroke-width="2" marker-end="url(#ar)"/><defs><marker id="ar" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0 0L8 4L0 8z" fill="#5f6f84"/></marker></defs></svg></div>
  <div class="card"><div class="card-h"><div><h3>Security & control matrix — demo vs production</h3><p>SoR §9.2 security & access control · SoW §4.2</p></div></div>
  <div class="tw u-mh-none"><table class="t"><thead><tr><th>Control</th><th>In this demo</th><th>Production (proposed)</th></tr></thead><tbody>${ctl.map(r => `<tr><td><b>${esc(r[0])}</b></td><td>${/Shown in prototype/.test(r[1]) ? `<span class="b b-g">${esc(r[1])}</span>` : esc(r[1])}</td><td>${esc(r[2])}</td></tr>`).join('')}</tbody></table></div></div>
  <div class="grid2"><div class="card"><div class="card-h"><div><h3>Data migration approach (SoW §4.3)</h3></div></div><ol class="u-list">
   <li>Assessment of legacy Oracle LMS tables, Excel registers and KMZ files</li><li>Data mapping document (legacy field → LMS field) signed by Mari</li><li>Cleansing: CNIC de-duplication, hierarchy standardisation, unit conversion to acres</li><li>Trial load using the same validators as the Data Upload screen (rejected-row reports)</li><li>Reconciliation: counts, areas and paid amounts per project vs legacy</li><li>Final load, parallel run, Mari sign-off</li></ol></div>
  <div class="card"><div class="card-h"><div><h3>Non-functional targets (proposed)</h3></div></div>${miniTable(['Area', 'Target'], [['Users', '300+ named, 100 concurrent'], ['Records', '1 M+ landowner / survey / payment rows'], ['Page response', '< 2 s for 95% of screens'], ['GIS', '50,000+ parcels with clustering & tiling'], ['Availability', '99.5% business hours'], ['Audit retention', '≥ 7 years'], ['Browser support', 'Chrome, Edge (latest 2 versions)']].map(r => r.map(esc)))}</div></div>`;
}

/* ---------- Urdu / bilingual prints (consent form in English & Urdu; receipt in Urdu) ---------- */
const UR_STYLE = ''; /* .ur is defined in assets/css/print-form.css */
function printConsent(id) {
  const r = byId('cases', id); const p = byId('projects', r.projectId); const t = caseTotals(r); const s0 = byId('surveys', r.leaseLines?.[0]?.surveyId); const lc = locCols(s0);
  const svs = uniq((r.leaseLines || []).map(l => surveyNoTxt(byId('surveys', l.surveyId)))).join(', ');
  printHTML('Consent ' + r.code, `${UR_STYLE}<h2>${esc(S.settings.company)}</h2><h3>CONSENT FOR LEASE & COMPENSATION · رضامندی نامہ برائے لیز و معاوضہ</h3>
  <div class="kv"><span>Case No:</span><b>${esc(r.code)}</b><span>Project:</span><b>${esc(p?.code)} — ${esc(p?.name)}</b><span>Survey No(s):</span><b>${esc(svs)}</b><span>Location:</span><b>${esc(lc.low)}, ${esc(lc.mid)}, ${esc(lc.dist)}</b><span>Lease area:</span><b>${ag(t.leaseArea)} (A-G)</b><span>Total compensation:</span><b>Rs ${fmt(t.total)}</b></div>
  <p class="p-just-17">I / We, the undersigned owner(s) / attorney of the land described above, hereby consent to lease the said land to <b>${esc(S.settings.company)}</b> for <b>${esc(r.landUsage)}</b> at Rs ${fmt(r.leaseRate)} per acre per annum for ${fmt(r.leaseTerm)} month(s) w.e.f. ${fdt(r.effectiveDate)}, and accept the compensation recorded in Case No. ${esc(r.code)} (Rupees ${esc(words(t.total))} Only) as full and final for the crops, trees and structures assessed.</p>
  <p class="ur">میں / ہم، نیچے دستخط کرنے والے، مندرجہ بالا زمین کے مالک / مختار، اس امر پر رضامندی ظاہر کرتے ہیں کہ مذکورہ زمین <b>${esc(S.settings.company)}</b> کو <b>${esc(r.landUsage)}</b> کے لیے ${fmt(r.leaseRate)} روپے فی ایکڑ سالانہ کی شرح پر ${fmt(r.leaseTerm)} ماہ کے لیے مورخہ ${fdt(r.effectiveDate)} سے لیز پر دی جائے، اور کیس نمبر ${esc(r.code)} میں درج فصلوں، درختوں اور تعمیرات کے معاوضے (کل ${fmt(t.total)} روپے) کو مکمل اور حتمی تسلیم کرتے ہیں۔</p>
  <table><tr><th>Code</th><th>Landowner · مالک</th><th>CNIC · شناختی کارڈ</th><th>Share %</th><th>Signature / Thumb · دستخط / انگوٹھا</th></tr>${(r.owners || []).map(o => { const lo = byId('landowners', o.landownerId); return `<tr><td>${esc(lo?.code)}</td><td>${esc(lo?.name)} s/o ${esc(lo?.father)}</td><td>${esc(lo?.cnic)}</td><td class="r">${fmt(o.share, 2)}</td><td class="p-h-38"></td></tr>`; }).join('')}</table>
  <div class="sig"><div>WITNESS 1 · گواہ نمبر 1</div><div>WITNESS 2 · گواہ نمبر 2</div><div>LAND OFFICER · لینڈ آفیسر</div><div>DATE · تاریخ</div></div>
  <p class="small p-mt-14">Urdu text is a draft translation for demonstration; final wording (Urdu and Sindhi) to follow Mari Legal's approved consent template.</p>`);
}
function printReceiptUr(id) {
  const p = byId('payments', id); const lo = byId('landowners', p.landownerId); const c = byId('cases', p.caseId) || byId('cases', byId('leases', p.leaseId)?.caseId); const lease = byId('leases', p.leaseId);
  const sids = c ? uniq(c.leaseLines.map(l => l.surveyId)) : lease?.surveyIds || []; const lc = locCols(byId('surveys', sids[0])); const area = c ? caseTotals(c).leaseArea : lease ? leaseInfo(lease).area : 0;
  printHTML('رسید ' + p.code, `${UR_STYLE}<h2>${esc(S.settings.company)}</h2><h3 class="ur p-tc">وصولی رسید — RECEIPT OF PAYMENT</h3><p class="p-tc"><b><u>REF-${esc(p.code)}</u></b></p>
  <p class="ur">میں نے <b>${esc(S.settings.company)}</b> سے چیک / ڈرافٹ نمبر <b>${esc(p.chequeNo)}</b> مورخہ <b>${fdt(p.chequeDate)}</b> مبلغ <b>${fmt(p.net, 2)}</b> روپے وصول کیے، جو سروے / بلاک نمبر <b>${esc(sids.map(x => surveyNoTxt(byId('surveys', x))).join('، '))}</b>، ${esc(lc.lowL)} ${esc(lc.low)}، ${esc(lc.midL)} ${esc(lc.mid)}، ضلع ${esc(lc.dist)} میں واقع ${ag(area)} ایکڑ زمین کے سلسلے میں ہیں۔ (In words: Rupees ${esc(words(p.net))} Only)</p>
  <table class="ur p-w-70"><tr><td class="p-nb">${esc(p.category)} (${fdt(p.periodFrom)}${p.periodTo ? ' تا ' + fdt(p.periodTo) : ''})</td><td class="p-nb">=</td><td class="p-nb">${fmt(p.gross, 2)}</td></tr><tr><td class="p-nb">منہا: ودہولڈنگ ٹیکس</td><td class="p-nb">=</td><td class="p-nb">${fmt(p.wht, 2)}</td></tr><tr><td class="p-nb"><b>کل رقم (روپے)</b></td><td class="p-nb">=</td><td class="p-nb"><b>${fmt(p.net, 2)}</b></td></tr></table>
  <p class="ur">میں تصدیق کرتا / کرتی ہوں کہ یہ ادائیگی مذکورہ زمین سے متعلق میرے تمام دعووں اور مطالبات کا مکمل اور حتمی تصفیہ ہے۔ اگر پیشگی کرایہ کی مدت کے دوران لیز کی شرح میں اضافہ ہو تو میں اضافی رقم کا مطالبہ نہیں کروں گا / گی، جو پیشگی ادائیگی کے مقابل تصور ہوگی۔</p>
  <div class="ur p-mt-30">وصول کنندہ: ____________________ &nbsp; <b>${esc(lo?.name || p.payee)}</b> &nbsp; شناختی کارڈ نمبر: ${esc(lo?.cnic || '')}</div>
  <div class="ur">تاریخ: ______________ &nbsp;&nbsp; گواہ 1: ______________ &nbsp;&nbsp; گواہ 2: ______________</div>
  <p class="small">Urdu text is a draft translation for demonstration; final wording to follow Mari Legal's approved receipt template.</p>`);
}

/* ---------- volume / performance test ---------- */
function volumeTest(nL, nS) {
  volumeClear(true); const t0 = performance.now();
  const FN = ['Muhammad', 'Ghulam', 'Abdul', 'Ali', 'Allah Dino', 'Imdad', 'Rasool Bux', 'Nazir', 'Sher', 'Gul', 'Habib', 'Karim', 'Noor', 'Rahim', 'Wali', 'Zahid', 'Sajjad', 'Hajran', 'Zainab', 'Fatima'];
  const LN = ['Mahar', 'Lund', 'Junejo', 'Shaikh', 'Mallah', 'Tareen', 'Marri', 'Khattak', 'Awan', 'Jatoi', 'Soomro', 'Chandio', 'Bhutto', 'Abro', 'Pitafi', 'Dahar', 'Bugti', 'Kakar'];
  const low = S.units.filter(u => u.level === PROV[u.province].levels.length - 1); const projs = S.projects.filter(p => p.lat);
  const sv = []; for (let i = 0; i < nS; i++) { const p = projs[i % projs.length]; const u = low.filter(x => x.province === p.province)[i % Math.max(1, low.filter(x => x.province === p.province).length)] || low[0];
    sv.push({ id: 'v' + uid(), _vol: true, code: 'VOL-S' + String(i + 1).padStart(6, '0'), province: p.province, unitId: u.id, surveyNo: String(2000 + i), blockNo: '', totalArea: +(2 + (i % 30)).toFixed(2), landClass: i % 9 ? 'Private' : 'Government', status: LAND_STATUS[i % 5], projectIds: [p.id], lat: +(p.lat + ((i * 7919) % 1000 - 500) / 9000).toFixed(5), lng: +(p.lng + ((i * 104729) % 1000 - 500) / 9000).toFixed(5), createdAt: nowStr(), createdBy: 'volume-test', history: [] }); }
  const lo = []; for (let i = 0; i < nL; i++) { const prov = sv[i % nS].province; lo.push({ id: 'v' + uid(), _vol: true, code: 'VOL-' + String(i + 1).padStart(6, '0'), province: prov, name: FN[i % FN.length] + ' ' + FN[(i * 7) % FN.length] + ' ' + LN[i % LN.length], father: FN[(i * 3) % FN.length] + ' ' + LN[(i * 5) % LN.length], cnic: '9' + String(1000 + (i % 9000)).padStart(4, '0') + '-' + String(1000000 + i).slice(-7) + '-' + (i % 10), ownerType: 'O', status: 'Active', filer: i % 3 ? 'Filer' : 'Non-Filer', shares: [{ surveyId: sv[i % nS].id, share: 100 / Math.ceil(nL / nS) }], createdAt: nowStr(), createdBy: 'volume-test', history: [] }); }
  const ls = [], py = []; for (let i = 0; i < nS; i++) { const s = sv[i]; const st = dOff(-(i % 1800)); ls.push({ id: 'v' + uid(), _vol: true, code: 'VOL-L' + String(i + 1).padStart(6, '0'), province: s.province, projectId: s.projectIds[0], kind: 'Private Land', landownerIds: [lo[i % nL].id], surveyIds: [s.id], initialArea: s.totalArea / 4, subsequentArea: s.totalArea / 4, startDate: st, termYears: 1 + (i % 5), ratePerAcre: 30000 + (i % 40) * 1000, escalation: 10, stage: 'Approved', createdAt: nowStr(), createdBy: 'volume-test', history: [] });
    py.push({ id: 'v' + uid(), _vol: true, code: 'VOL-P' + String(i + 1).padStart(6, '0'), province: s.province, landownerId: lo[i % nL].id, projectId: s.projectIds[0], category: 'Lease Rent', payType: 'Yearly Lease', periodFrom: st, gross: 50000 + (i % 50) * 3000, whtPct: 10, wht: 0, net: 0, stage: ['Requested', 'Verified', 'Released'][i % 3], chequeNo: i % 3 === 2 ? String(30000000 + i) : '', chequeDate: i % 3 === 2 ? st : '', landClass: 'Private', createdAt: nowStr(), createdBy: 'volume-test', history: [] }); py[i].wht = Math.round(py[i].gross * .1); py[i].net = py[i].gross - py[i].wht; }
  S.surveys.push(...sv); S.landowners.push(...lo); S.leases.push(...ls); S.payments.push(...py); clearCache();
  const gen = performance.now() - t0; const t1 = performance.now(); const hit = S.landowners.filter(l => (l.name + ' ' + l.cnic + ' ' + l.code).toLowerCase().includes('junejo')).length; const sq = performance.now() - t1;
  S.meta.volMsg = `Loaded ${fmt(nL)} landowners, ${fmt(nS)} surveys, ${fmt(nS)} leases and ${fmt(nS)} payments in ${fmt(gen, 0)} ms (memory only). Sample search across ${fmt(S.landowners.length)} landowners for “Junejo”: ${fmt(hit)} hits in ${fmt(sq, 1)} ms.`;
  toast(S.meta.volMsg, 'success'); render();
}
function volumeClear(silent) { COLLS.forEach(c => { if (Array.isArray(S[c])) S[c] = S[c].filter(r => !r || !r._vol); }); S.meta.volMsg = ''; clearCache(); if (!silent) { toast('Volume test data removed', 'info'); render(); } }
