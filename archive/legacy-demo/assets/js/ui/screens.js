/* Screens — lists, record view, dashboard, inbox, audit, documents, settings, converter
   Part of the LMS multi-page build. Loaded as a classic script;
   top-level declarations are shared across the bundle. */
/* =====================================================================
   SCREENS — login, province, navigation, lists, record view, dashboard,
   inbox/alerts, documents, audit, users, settings, converter, prints
   ===================================================================== */
const NAV = [
  ['Overview', [['dashboard', '', 'Executive Dashboard'], ['projdash', '', 'Project Dashboard'], ['inbox', '', 'Approvals & Alerts'], ['calendar', '', 'Calendar'], ['gis', '', 'GIS Land Map']]],
  ['Master Data', [['units', '', 'Administrative Hierarchy'], ['projects', '', 'Projects / Well Locations'], ['surveys', '', 'Survey / Khasra Register'], ['landowners', '', 'Landowners']]],
  ['Land Operations', [['acquisitions', '', 'Acquisition & Title'], ['cases', '', 'Compensation Cases'], ['leases', '', 'Leases & Agreements'], ['rows', '', 'ROW & Pipelines'], ['encroachments', '', 'Encroachments'], ['mutations', '', 'Mutation & Succession'], ['legal', '', 'Legal & Litigation']]],
  ['Finance', [['payments', '', 'Payments & Cheques'], ['dbpfc', '', 'DBPFC — Sindh Govt Land'], ['budgets', '', 'Budgets']]],
  ['Community', [['grievances', '', 'Grievances & IIR']]],
  ['Records & Reports', [['reports', '', 'Reports'], ['documents', '', 'Documents'], ['import', '', 'Data Upload'], ['audit', '', 'Audit Trail']]],
  ['System', [['users', '', 'Users & Roles'], ['matrix', '', 'Approval Matrix'], ['settings', '', 'Settings'], ['arch', '', 'Architecture & Security']]]
];
const navLabel = k => { for (const [, items] of NAV) for (const [kk, , l] of items) if (kk === k) return l; return k; };
const navGroup = k => { for (const [g, items] of NAV) for (const [kk] of items) if (kk === k) return g; return ''; };
const stripTags = s => String(s ?? '').replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
const charts = {};

function render() {
  if (!ME) return; clearCache();
  $$('.nav-i').forEach(n => n.classList.toggle('active', n.dataset.k === SCREEN));
  $('#pgTitle').textContent = navLabel(SCREEN);
  $('#pgSub').textContent = 'LMS / ' + navGroup(SCREEN) + ' / ' + navLabel(SCREEN);
  const p = PROV[CTX]; $('#provChip').innerHTML = `<span class="dot" data-bg="${esc(p ? p.color : '#888')}"></span>${CTX === 'ALL' ? 'All provinces' : p.name} ▾`;
  const al = alerts(); const q = myQueue().length; const n = al.filter(a => a.sev === 'd').length + q;
  $('#bellN').textContent = n; $('#bellN').classList.toggle('hidden', !n);
  const nc = $('#navCnt'); if (nc) { nc.textContent = q; nc.classList.toggle('hidden', !q); }
  Object.values(charts).forEach(ch => ch.destroy && ch.destroy()); for (const k in charts) delete charts[k];
  if (window._map && (SCREEN !== 'gis' || !document.getElementById('map'))) { try { window._map.off(); window._map.stop && window._map.stop(); window._map.remove(); } catch (e) { } window._map = null; }
  if (window._map && SCREEN === 'gis') { try { window._map.off(); window._map.remove(); } catch (e) { } window._map = null; }
  const el = $('#content');
  try {
    if (SCREEN === 'dashboard') el.innerHTML = scrDashboard(), drawDashboard();
    else if (SCREEN === 'inbox') el.innerHTML = scrInbox() + scrNotif();
    else if (SCREEN === 'gis') el.innerHTML = scrGIS(), drawGIS();
    else if (SCREEN === 'reports') el.innerHTML = scrReports();
    else if (SCREEN === 'documents') el.innerHTML = scrDocuments();
    else if (SCREEN === 'import') el.innerHTML = scrImport(), initImport();
    else if (SCREEN === 'audit') el.innerHTML = scrAudit();
    else if (SCREEN === 'settings') el.innerHTML = scrSettings();
    else if (SCREEN === 'users') el.innerHTML = renderList('users') + scrUsersExtra();
    else if (SCREEN === 'matrix') el.innerHTML = scrMatrix();
    else if (SCREEN === 'arch') el.innerHTML = scrArch();
    else if (SCREEN === 'calendar') el.innerHTML = scrCalendar();
    else if (SCREEN === 'projdash') el.innerHTML = scrProjDash(), drawProjDash();
    else if (SPEC[SCREEN]) el.innerHTML = renderList(SCREEN);
  } catch (err) { console.error(err); el.innerHTML = `<div class="card"><b>Screen error:</b> ${esc(err.message)}</div>`; }
  iconize(el); iconize($('#nav'));
}

/* ---------- generic list ---------- */
function listRows(c) {
  const sp = SPEC[c]; let rows = ctxRows(c).slice(); const q = (UI.q[c] || '').toLowerCase(); const st = UI.stage[c] || '';
  if (st) rows = rows.filter(r => (r.stage || r.status) === st || (st === '__esc' && r.escalated));
  if (q) rows = rows.filter(r => searchText(c, r).includes(q));
  return sp.sort ? rows.sort(sp.sort) : rows.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}
function searchText(c, r) { // lightweight search string (record scalars + key labels) — fast at 20k+ rows
  let t = Object.values(r).filter(v => typeof v === 'string' || typeof v === 'number').join(' ');
  if (r.projectId) t += ' ' + projCode(r.projectId); if (r.landownerId) t += ' ' + (byId('landowners', r.landownerId)?.name || '');
  (r.landownerIds || []).forEach(i => t += ' ' + (byId('landowners', i)?.name || '')); (r.owners || []).forEach(o => t += ' ' + (byId('landowners', o.landownerId)?.name || ''));
  if (r.unitId) t += ' ' + unitPath(r.unitId); return t.toLowerCase();
}
function renderList(c) {
  const sp = SPEC[c]; const t0 = performance.now(); const all = listRows(c); const ms = performance.now() - t0;
  const PS = 50; const pages = Math.max(1, Math.ceil(all.length / PS)); UI.page = UI.page || {}; const pgn = Math.min(UI.page[c] || 0, pages - 1); const rows = all.slice(pgn * PS, pgn * PS + PS);
  const stages = WF[c] ? [...WF[c].stages, ...(WF[c].cancel ? ['Cancelled'] : []), ...(WF[c].stop ? ['Stopped'] : [])] : uniq(S[c].map(r => r.status));
  const head = sp.cols.map(col => `<th class="${col.num ? 'num' : ''}">${esc(col.l)}</th>`).join('') + '<th>Actions</th>';
  const body = rows.length ? rows.map(r => `<tr class="is-link">${sp.cols.map((col, i) => `<td class="${col.num ? 'num' : ''}">${i === 0 ? `<a class="cell-link" href="${pageUrl(c)}?view=${encodeURIComponent(r.id)}" data-act="openView" data-a1="${c}" data-a2="${r.id}">${col.v(r)}</a>` : col.v(r)}</td>`).join('')}
    <td><div class="acts"><a title="View ${esc(sp.title)}" href="${pageUrl(c)}?view=${encodeURIComponent(r.id)}" data-act="openView" data-a1="${c}" data-a2="${r.id}">👁</a>${can.edit(c, r) ? `<button title="Edit" data-act="openForm" data-a1="${c}" data-a2="${r.id}">✏️</button>` : ''}${can.del(c, r) ? `<button class="del" title="Delete" data-act="deleteRec" data-a1="${c}" data-a2="${r.id}">🗑</button>` : ''}</div></td></tr>`).join('')
    : `<tr><td colspan="${sp.cols.length + 1}" class="empty">No records${UI.q[c] || UI.stage[c] ? ' match the filter' : ' yet'}. ${can.create() ? 'Use “+ Add” for manual entry or “Upload Excel” for bulk upload.' : ''}</td></tr>`;
  const impOK = IMP[c] && can.create();
  return `<div class="card"><div class="card-h"><div><h3>${sp.icon || ''} ${esc(navLabel(c))}</h3><p>${esc(sp.sub || '')}</p></div>
    <div class="bar u-m-0">${!can.create() ? `<button class="btn btn-p" disabled title="Your role (${esc(ME.role)}) is read-only \u2014 you can open and export records, but not add them.">+ Add ${esc(sp.title)}</button>` : (c === 'dbpfc' && CTX !== 'ALL' && CTX !== 'SND') ? `<button class="btn btn-p" disabled title="DBPFC applies to Sindh government land \u2014 switch province to Sindh to add records.">+ Add ${esc(sp.title)}</button>` : `<button class="btn btn-p" data-act="openForm" data-a1="${c}">+ Add ${esc(sp.title)}</button>`}${impOK ? `<button class="btn btn-g" data-act="navigate" data-href="${pageUrl('import')}?coll=${esc(c)}">📥 Upload Excel / CSV</button>` : IMP[c] ? `<button class="btn btn-g" disabled title="Bulk upload needs data-entry rights.">📥 Upload Excel / CSV</button>` : ''}</div></div>
    ${c === 'dbpfc' && CTX !== 'ALL' && CTX !== 'SND' ? '<div class="demo-banner">DBPFC applies to Sindh government land. Switch province to Sindh to add records.</div>' : ''}
    <div class="bar"><input class="search" placeholder="Search ${esc(navLabel(c).toLowerCase())}…" value="${esc(UI.q[c] || '')}" data-act="listSearch" data-a1="${esc(c)}">
    ${stages.length ? `<select class="sel" data-act="setStage" data-a1="${esc(c)}"><option value="">All ${WF[c] ? 'stages' : 'statuses'}</option>${stages.map(s => `<option ${UI.stage[c] === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}${WF[c]?.escalate ? `<option value="__esc" ${UI.stage[c] === '__esc' ? 'selected' : ''}>Escalated only</option>` : ''}</select>` : ''}
    <span class="grow"></span><span class="note">${fmt(all.length)} record(s)${all.length > 500 ? ' · filtered in ' + fmt(ms, 0) + ' ms' : ''}</span>
    <button class="btn btn-s btn-sm" data-act="listExport" data-a1="${c}" data-a2="x">Excel</button><button class="btn btn-s btn-sm" data-act="listExport" data-a1="${c}" data-a2="p">PDF</button><button class="btn btn-s btn-sm" data-act="printPage">Print</button></div>
    <div class="tw"><table class="t"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    ${pages > 1 ? `<div class="bar u-pager"><span class="note">Showing ${fmt(pgn * PS + 1)}–${fmt(Math.min(all.length, pgn * PS + PS))} of ${fmt(all.length)}</span><button class="btn btn-s btn-sm" ${pgn ? '' : 'disabled'} data-act="setPage" data-a1="${esc(c)}" data-a2="${pgn - 1}">‹ Prev</button><span class="note">Page ${pgn + 1} / ${fmt(pages)}</span><button class="btn btn-s btn-sm" ${pgn < pages - 1 ? '' : 'disabled'} data-act="setPage" data-a1="${esc(c)}" data-a2="${pgn + 1}">Next ›</button></div>` : ''}</div>`;
}
function listExport(c, kind) { const sp = SPEC[c]; const rows = listRows(c).slice(0, 20000); const H = sp.cols.map(x => x.l); const R = rows.map(r => sp.cols.map(col => col.x ? col.x(r) : stripTags(col.v(r)))); kind === 'x' ? exportXLSX(navLabel(c), H, R) : exportPDF(navLabel(c), H, R); }

/* ---------- record view ---------- */
let VIEW = null;
function fmtVal(f, v, r) {
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '<span class="note">—</span>';
  switch (f.t) {
    case 'ref': return `<a href="${pageUrl(f.coll)}?view=${encodeURIComponent(v)}" data-act="openView" data-a1="${esc(f.coll)}" data-a2="${esc(v)}">${esc(lbl(f.coll, v))}</a>`;
    case 'multiref': return v.map(id => `<a href="${pageUrl(f.coll)}?view=${encodeURIComponent(id)}" class="pill" data-act="openView" data-a1="${f.coll}" data-a2="${id}">${esc(codeOf(f.coll, id))}</a>`).join(' ');
    case 'area': return esc(areaTxt(v, r.province));
    case 'loc': return esc(unitPath(v));
    case 'date': return fdt(v);
    case 'number': return fmt(v, 2).replace(/\.00$/, '');
    case 'checks': return `${(v || []).length} / ${optList(f, r).length} — ` + optList(f, r).map(([val, lb]) => `<span class="pill ${v.includes(val) ? '' : 'is-off'}">${v.includes(val) ? '✓' : '✗'} ${esc(lb)}</span>`).join(' ');
    case 'select': { const o = optList(f, r).find(([val]) => String(val) === String(v)); return esc(o ? o[1] : v); }
    case 'sub': return `<div class="sub"><table><thead><tr>${f.cols.filter(c => c.t !== 'calc').map(c => `<th>${esc(c.l)}</th>`).join('')}</tr></thead><tbody>${v.filter(row => subRowVisible(f, row)).map(row => `<tr>${f.cols.filter(c => c.t !== 'calc').map(c => `<td>${c.t === 'ref' ? esc(codeOf(c.coll, row[c.k]) + (c.coll === 'landowners' ? ' — ' + (byId('landowners', row[c.k])?.name || '') : c.coll === 'surveys' ? ' · ' + surveyNoTxt(byId('surveys', row[c.k])) : '')) : c.t === 'number' ? fmt(row[c.k], 3).replace(/\.?0+$/, '') : esc(row[c.k] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    default: return esc(v);
  }
}
function openView(c, id) { if (!byId(c, id)) { toast('Record not found', 'warning'); return; } VIEW = { c, id, tab: VIEW && VIEW.id === id ? VIEW.tab : 'd' }; drawView(); openModal('view'); }
function refreshView(c, id) { if (VIEW && VIEW.id === id && !$('#view').classList.contains('hidden')) drawView(); render(); }
function drawView() {
  const { c, id, tab } = VIEW; const r = byId(c, id); const sp = SPEC[c];
  if (!r) { closeModal('view'); return; }
  $('#vTitle').innerHTML = `${sp.icon || ''} ${esc(sp.title)} · <span class="mono">${esc(r.code)}</span> ${r.stage ? stageBadge(r.stage) : ''}`;
  const w = WF[c]; let wf = '';
  if (w) { const i = w.stages.indexOf(r.stage); const term = TERMINAL.includes(r.stage); const lastOk = term ? [...(r.history || [])].reverse().find(h => w.stages.includes(h.from))?.from : null; const li = term ? w.stages.indexOf(lastOk) : i;
    wf = `<div class="wf">${w.stages.map((s, k) => `<div class="st ${k < li || (k === li && !term && k === w.stages.length - 1) ? 'done' : k === li && !term ? 'cur' : ''}">${k < li ? '✓ ' : ''}${esc(stLabel(s))}${w.step && w.step[s] ? `<br><small class="u-fw-400">${esc(w.step[s])}</small>` : ''}${S.settings.matrix?.[c]?.[s] ? `<br><small class="u-fw-400 u-dim">👤 ${esc(S.settings.matrix[c][s].join(' / '))}</small>` : ''}</div>`).join('')}${term ? `<div class="st x">✗ ${esc(r.stage)}</div>` : ''}</div>`; }
  const docs = docsFor(id); const live = docs.filter(d => !d.deleted).length;
  const wfPills = w ? '' : '';
  const tabs = `<div class="tabs">${[['d', 'Details'], ['h', 'History & Audit (' + ((r.history || []).length) + ')'], ['f', 'Documents (' + live + ')']].map(([k, l]) => `<div class="tab ${tab === k ? 'active' : ''}" data-act="setViewTab" data-a1="${esc(k)}">${l}</div>`).join('')}</div>`;
  let body = '';
  if (tab === 'd') {
    const meta = `<div class="dl">${sp.provincial !== false ? `<div><small>Province</small><span>${esc(provName(r.province || recProv(c, r)))}</span></div>` : ''}<div><small>Created</small><span>${fdtt(r.createdAt)} · ${esc(uName(r.createdBy))}</span></div>${r.updatedAt ? `<div><small>Last updated</small><span>${fdtt(r.updatedAt)} · ${esc(uName(r.updatedBy))}</span></div>` : ''}${extraMeta(c, r)}</div>`;
    const flds = visibleFields(sp, r).filter(f => !['sec', 'calc', 'ro'].includes(f.t) && f.k !== 'password');
    body = meta + `<div class="dl">${flds.filter(f => f.t !== 'sub').map(f => `<div class="${['multiref', 'checks', 'textarea'].includes(f.t) ? 'is-wide' : ''}"><small>${esc(FL(f, r))}</small><span>${fmtVal(f, r[f.k], r)}</span></div>`).join('')}</div>`
      + flds.filter(f => f.t === 'sub').map(f => `<h4 class="u-subhead">${esc(FL(f, r))}</h4>${fmtVal(f, r[f.k], r)}`).join('') + (VIEWX[c] ? VIEWX[c](r) : '');
  } else if (tab === 'h') {
    const au = S.audit.filter(a => a.recId === id);
    body = `<h4 class="u-mb-8">Workflow & activity history</h4><div class="tl">${(r.history || []).slice().reverse().map(h => `<div><b>${esc(h.action)}</b> ${h.from || h.to ? `<span class="note">${esc(h.from || '')}${h.from && h.to && h.from !== h.to ? ' → ' + esc(h.to) : ''}</span>` : ''}<br><small>${fdtt(h.at)} · ${esc(h.name || h.user)} (${esc(h.role || '')})</small>${h.note ? `<br><i>“${esc(h.note)}”</i>` : ''}</div>`).join('') || '<div class="note">No history</div>'}</div>
    <h4 class="u-sec-head">Field-level audit trail (before → after)</h4>${auditTable(au)}`;
  } else {
    body = `${can.upload() && !isLocked(c, r) || can.upload() && ['cases', 'encroachments', 'payments', 'grievances'].includes(c) ? `<label class="drop" id="dropZ" data-dropzone="1"  data-drop-coll="${esc(c)}" data-drop-id="${esc(id)}">📎 Drag & drop files here or click to upload (photos, scans, PDF, KMZ, Word, Excel)<input type="file" multiple class="hidden" data-act="attachPick" data-a1="${esc(c)}" data-a2="${esc(id)}"></label>` : ''}
    <div class="u-mt-10">${docs.length ? docs.slice().reverse().map(d => `<div class="att ${d.deleted ? 'deleted' : ''}"><span>${/image/.test(d.type) ? '🖼️' : /pdf/.test(d.type) ? '📕' : '📄'}</span><div class="nm"><b>${esc(d.name)}</b> <span class="pill">v${d.version}</span> <span class="pill">${esc(d.category)}</span><small>${esc(d.code)} · ${fmt(d.size / 1024, 1)} KB · ${fdtt(d.at)} · ${esc(uName(d.uploadedBy))}${d.deleted ? ' · REMOVED / SUPERSEDED' : ''} · ${(d.history || []).map(h => esc(h.action)).join(' → ')}</small></div>
      ${!d.deleted ? `<button class="btn btn-s btn-sm" data-act="docOpen" data-a1="${d.id}">⬇ Open</button>${can.upload() ? `<button class="btn btn-s btn-sm" data-act="docRename" data-a1="${d.id}">✏️</button><button class="btn btn-s btn-sm" data-act="docDelete" data-a1="${d.id}">🗑</button>` : ''}` : ''}</div>`).join('') : '<div class="empty">No documents attached</div>'}</div>`;
  }
  $('#vBody').innerHTML = wf + tabs + body;
  // footer actions
  const A = [];
  if (w && canAdvance(c, r)) { const nx = w.stages[w.stages.indexOf(r.stage) + 1]; A.push(`<button class="btn btn-g" data-act="wfAdvance" data-a1="${c}" data-a2="${id}">${w.stages.indexOf(r.stage) === 0 && c !== 'cases' ? '➤ Submit' : '✔ Approve'} → ${esc(stLabel(nx))}</button>`); }
  else if (w && !isLocked(c, r) && stageIdx(c, r) < w.stages.length - 1 && !isRole('Viewer')) { const nx = w.stages[stageIdx(c, r) + 1]; const who = usersInGroups(stepGroups(c, nx)).filter(u => u.username !== ME.username && !(r.history || []).some(h => h.user === u.username && ['Created', 'Submitted', 'Approved'].includes(h.action)));
    A.push(`<span class="note u-mw-380">🔒 ${esc(advanceBlock(c, r))}</span>` + (S.settings.demoSwitch !== false && who[0] ? `<button class="btn btn-s" title="Demo helper — sign in as the responsible officer" data-act="switchUser" data-a1="${esc(who[0].username)}" data-a2="${esc(true)}">⇄ Switch to ${esc(who[0].fullName)} (${esc(who[0].groups[0])})</button>` : '')); }
  if (w && canReturn(c, r)) A.push(`<button class="btn btn-s" data-act="wfReturn" data-a1="${c}" data-a2="${id}">↩ Return</button>`);
  if (w?.cancel && !TERMINAL.includes(r.stage) && can.approve() && !(c === 'acquisitions' && r.stage === 'Handover')) A.push(`<button class="btn btn-d" data-act="wfTerminal" data-a1="${c}" data-a2="${id}" data-a3="Cancel">✗ Cancel ${c === 'cases' ? 'case' : ''}</button>`);
  if (w?.stop && !TERMINAL.includes(r.stage) && can.approve() && !(c === 'payments' && r.stage === 'Released')) A.push(`<button class="btn btn-d" data-act="wfTerminal" data-a1="${c}" data-a2="${id}" data-a3="Stop">⏹ Stop ${c === 'payments' ? 'payment' : ''}</button>`);
  if (w?.escalate && !isLocked(c, r) && !isRole('Viewer') && r.stage !== 'Resolved') A.push(`<button class="btn btn-w" data-act="wfEscalate" data-a1="${c}" data-a2="${id}">⇪ Escalate</button>`);
  if (VACT[c]) A.push(VACT[c](r));
  if (can.edit(c, r)) A.push(`<button class="btn btn-p" data-act="openForm" data-close="view" data-a1="${c}" data-a2="${id}">✏️ Edit</button>`);
  if (can.del(c, r)) A.push(`<button class="btn btn-s" data-act="deleteRec" data-a1="${c}" data-a2="${id}">🗑 Delete</button>`);
  if (isLocked(c, r) && !isRole('Viewer')) A.push(`<span class="note">🔒 ${esc(r.stage)} — record locked</span>`);
  $('#vFoot').innerHTML = A.join('') + `<button class="btn btn-s" data-act="closeModal" data-a1="view">Close</button>`;
  iconize($('#vTitle')); iconize($('#vBody')); iconize($('#vFoot'));
}
function extraMeta(c, r) {
  if (c === 'cases') { const t = caseTotals(r); return `<div><small>Lease No.</small><span class="mono">${esc(r.leaseNo || '-')}</span></div><div><small>Block code</small><span>${esc(r.blockCode || '-')}</span></div><div><small>Case date</small><span>${fdt(r.caseDate)}</span></div><div><small>Total compensation</small><span class="u-accent">${rs(t.total)}</span></div>`; }
  if (c === 'leases') { const i = leaseInfo(r); return `<div><small>Expiry</small><span>${fdt(i.end)}</span></div><div><small>Days left</small><span>${expiryBadge(i.days, i.status)}</span></div><div><small>Annual rent</small><span>${rs(i.rent)}</span></div>`; }
  if (c === 'rows') { const i = rowInfo(r); return `<div><small>ROW area</small><span>${fmt(i.area, 3)} ac (${ag(i.area)})</span></div><div><small>Next yearly renewal</small><span>${fdt(i.next)} (${i.nextDays} d)</span></div><div><small>Tenure ends</small><span>${fdt(i.end)}</span></div>`; }
  if (c === 'payments') return `<div><small>Net payable</small><span class="u-accent">${rs(r.net)}</span></div><div><small>Amount in words</small><span>Rupees ${esc(words(r.net))} Only</span></div>${r.chequeNo ? `<div><small>Cheque</small><span class="mono">${esc(r.chequeNo)} · ${fdt(r.chequeDate)}</span></div><div><small>Finance / SAP document (simulated)</small><span class="mono">${esc(r.sapDoc || '-')}</span></div>` : ''}`;
  if (c === 'landowners') return `<div><small>Paid to date</small><span>${rs(paidTo(r.id))}</span></div><div><small>Pending</small><span>${rs(sum(S.payments.filter(p => p.landownerId === r.id && ['Requested', 'Verified'].includes(p.stage)), 'net'))}</span></div>`;
  if (c === 'surveys') return `<div><small>Occupied by company</small><span>${areaTxt(occupiedArea(r.id), r.province)}</span></div><div><small>Owner shares recorded</small><span>${fmt(ownerShareTotal(r.id), 2)}%</span></div>`;
  return '';
}
function miniTable(H, R) { return `<div class="sub u-mt-6"><table><thead><tr>${H.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${R.length ? R.map(r => `<tr>${r.map(x => `<td>${x}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${H.length}" class="note">None</td></tr>`}</tbody></table></div>`; }
const vlink = (c, r) => `<a href="${pageUrl(c)}?view=${encodeURIComponent(r.id)}" data-act="openView" data-a1="${c}" data-a2="${r.id}" class="mono">${esc(r.code)}</a>`;
const VIEWX = {
  landowners: r => `<h4 class="u-vh">Holdings</h4>${hiddenNote(r.shares, 'surveys', 'surveyId', 'holding')}${miniTable(['Survey', 'Location', 'Share %', 'Survey total', 'Ref'], (r.shares || []).filter(s => refVisible('surveys', s.surveyId)).map(s => { const sv = byId('surveys', s.surveyId); return [sv ? vlink('surveys', sv) + ' ' + esc(surveyNoTxt(sv)) : '-', esc(sv ? unitPath(sv.unitId) : ''), fmt(s.share, 2), sv ? areaTxt(sv.totalArea, sv.province) : '', esc(s.ref || '')]; }))}
   <h4 class="u-vh">Compensation cases</h4>${miniTable(['Case', 'Project', 'Share', 'Case total', 'Stage'], S.cases.filter(c => (c.owners || []).some(o => o.landownerId === r.id)).map(c => [vlink('cases', c), esc(projCode(c.projectId)), fmt(c.owners.find(o => o.landownerId === r.id).share, 1) + '%', rs(caseTotals(c).total), stageBadge(c.stage)]))}
   <h4 class="u-vh">Leases</h4>${miniTable(['Lease', 'Project', 'Expiry', 'Days', 'Renewals'], S.leases.filter(l => (l.landownerIds || []).includes(r.id)).map(l => [vlink('leases', l), esc(projCode(l.projectId)), fdt(leaseInfo(l).end), expiryBadge(leaseInfo(l).days, leaseInfo(l).status), (l.renewals || []).length]))}
   <h4 class="u-vh">Payments</h4>${miniTable(['Voucher', 'Category', 'Period', 'Net', 'Cheque', 'Stage'], S.payments.filter(p => p.landownerId === r.id).map(p => [vlink('payments', p), esc(p.category), fdt(p.periodFrom), rs(p.net), esc(p.chequeNo || '-'), stageBadge(p.stage)]))}
   <h4 class="u-vh">Grievances</h4>${miniTable(['Ticket', 'Category', 'Received', 'Stage'], S.grievances.filter(g => g.landownerId === r.id).map(g => [vlink('grievances', g), esc(g.category), fdt(g.receivedDate), stageBadge(g.stage)]))}`,
  surveys: r => `<h4 class="u-vh">Owners (record of rights)</h4>${miniTable(['Landowner', 'CNIC', 'Share %', 'Status'], S.landowners.filter(l => (l.shares || []).some(s => s.surveyId === r.id)).map(l => [vlink('landowners', l) + ' ' + esc(l.name), esc(l.cnic), fmt(l.shares.find(s => s.surveyId === r.id).share, 2), stageBadge(l.status)]))}
   <h4 class="u-vh">Cases on this survey</h4>${miniTable(['Case', 'Project', 'Lease area', 'Stage'], S.cases.filter(c => (c.leaseLines || []).some(l => l.surveyId === r.id)).map(c => [vlink('cases', c), esc(projCode(c.projectId)), ag(sum(c.leaseLines.filter(l => l.surveyId === r.id), 'leaseArea')), stageBadge(c.stage)]))}
   <h4 class="u-vh">Encroachments</h4>${miniTable(['Ref', 'Category', 'Risk', 'Stage'], S.encroachments.filter(e => e.surveyId === r.id).map(e => [vlink('encroachments', e), esc(e.category), stageBadge(e.risk), stageBadge(e.stage)]))}`,
  projects: r => { const cs = S.cases.filter(c => c.projectId === r.id); return `<div class="totals u-mt-10"><div><small>Cases</small><b>${cs.length}</b></div><div><small>Approved compensation</small><b>${rs(sum(cs.filter(c => c.stage === 'HO Approved'), c => caseTotals(c).total))}</b></div><div><small>Paid</small><b>${rs(sum(S.payments.filter(p => p.projectId === r.id && p.stage === 'Released'), 'net'))}</b></div><div><small>Land under lease</small><b>${ag(sum(cs.filter(c => c.stage === 'HO Approved'), c => caseTotals(c).leaseArea))}</b></div></div>
   <h4 class="u-vh">Cases</h4>${miniTable(['Case', 'Date', 'Owners', 'Total', 'Stage'], cs.map(c => [vlink('cases', c), fdt(c.caseDate), (c.owners || []).length, rs(caseTotals(c).total), stageBadge(c.stage)]))}`; },
  cases: r => { const t = caseTotals(r); return `<div class="totals u-mt-12"><div><small>Total lease area</small><b>${ag(t.leaseArea)}</b></div><div><small>Lease amount</small><b>${rs(t.leaseAmt)}</b></div><div><small>Crop</small><b>${rs(t.crop)}</b></div><div><small>Trees</small><b>${rs(t.tree)}</b></div><div><small>Misc</small><b>${rs(t.misc)}</b></div><div><small>Total compensation</small><b class="u-accent">${rs(t.total)}</b></div></div>
   <h4 class="u-vh">Linked records</h4>${miniTable(['Type', 'Ref', 'Detail', 'Stage'], [...S.leases.filter(l => l.caseId === r.id).map(l => ['Lease', vlink('leases', l), fdt(leaseInfo(l).end), stageBadge(l.stage)]), ...S.payments.filter(p => p.caseId === r.id).map(p => ['Payment', vlink('payments', p), esc(byId('landowners', p.landownerId)?.name || p.payee) + ' · ' + rs(p.net), stageBadge(p.stage)])])}`; },
  leases: r => `<h4 class="u-vh">Renewal history</h4>${miniTable(['Date', 'By', 'Previous expiry', 'New expiry', 'Rate before → after'], (r.renewals || []).map(n => [fdt(n.at), esc(uName(n.user)), fdt(n.prevEnd), fdt(n.newEnd), fmt(n.prevRate) + ' → ' + fmt(n.newRate)]))}
   <h4 class="u-vh">Rent payments</h4>${miniTable(['Voucher', 'Payee', 'Period', 'Net', 'Stage'], S.payments.filter(p => p.leaseId === r.id).map(p => [vlink('payments', p), esc(byId('landowners', p.landownerId)?.name || p.payee), fdt(p.periodFrom) + ' – ' + fdt(p.periodTo), rs(p.net), stageBadge(p.stage)]))}`,
  rows: r => `<h4 class="u-vh">Violations / conflicts</h4>${miniTable(['Ref', 'Category', 'Detected', 'Risk', 'Stage'], S.encroachments.filter(e => e.rowId === r.id).map(e => [vlink('encroachments', e), esc(e.category), fdt(e.detectedOn), stageBadge(e.risk), stageBadge(e.stage)]))}`,
  dbpfc: r => `<h4 class="u-vh">Rate change history</h4>${miniTable(['Date', 'By', 'Estimated rate', 'DBPFC fixed rate'], (r.rateHistory || []).map(h => [fdtt(h.at), esc(uName(h.user)), fmt(h.estRate), h.fixedRate ? fmt(h.fixedRate) : 'pending']))}
   <h4 class="u-vh">Payments</h4>${miniTable(['Voucher', 'Period', 'Net', 'Stage'], S.payments.filter(p => p.dbpfcId === r.id).map(p => [vlink('payments', p), fdt(p.periodFrom), rs(p.net), stageBadge(p.stage)]))}`,
  acquisitions: r => { const iss = titleIssues(r.surveyIds); return `<h4 class="u-vh">Automatic title validation</h4>${iss.length ? iss.map(i => `<div class="al w"><span class="i"></span><div class="tx">${esc(i)}</div></div>`).join('') : '<div class="al i"><span class="i"></span><div class="tx">All surveys: owner shares total 100%, owners alive with valid CNIC, no dispute flag.</div></div>'}`; },
  budgets: r => { const b = budgetFor(r.projectId, r.year); return `<div class="totals u-mt-10"><div><small>Approved</small><b>${rs(b.approved)}</b></div><div><small>Committed</small><b>${rs(b.committed)}</b></div><div><small>Spent</small><b>${rs(b.spent)}</b></div><div><small>Balance</small><b>${rs(b.balance)}</b></div></div>`; },
  encroachments: r => `<p class="note u-mt-10">📍 ${fmt(r.lat, 5)}, ${fmt(r.lng, 5)} — <a href="${pageUrl('gis')}?lat=${num(r.lat)}&amp;lng=${num(r.lng)}">show on GIS map</a></p>`
};
const VACT = {
  cases: r => [r.stage === 'HO Approved' && !S.leases.some(l => l.caseId === r.id) && num(r.leaseRate) > 0 && !isRole('Viewer') ? `<button class="btn btn-s" data-act="caseToLease" data-a1="${r.id}">📅 Generate lease</button>` : '',
    r.stage === 'HO Approved' && !S.payments.some(p => p.caseId === r.id) && !isRole('Viewer') ? `<button class="btn btn-s" data-act="caseToPayments" data-a1="${r.id}">💰 Generate payment requests</button>` : '',
    !TERMINAL.includes(r.stage) && r.stage !== 'HO Approved' && !isRole('Viewer') ? `<button class="btn btn-s" data-act="caseDocs" data-a1="${r.id}">☑ Documents received (${(r.docChecks || []).length}/${CASE_DOCS.length})</button>` : '',
    `<button class="btn btn-s" data-act="printCase" data-a1="${r.id}">🖨 Case form</button><button class="btn btn-s" data-act="printConsent" data-a1="${r.id}">🖨 Consent form (Eng / اردو)</button>`].join(''),
  leases: r => [r.stage !== 'Stopped' && can.approve() ? `<button class="btn btn-s" data-act="leaseRenew" data-a1="${r.id}">🔁 Renew</button><button class="btn btn-d" data-act="wfTerminal" data-a1="leases" data-a2="${r.id}" data-a3="Stop">⏹ Stop lease</button>` : '',
    r.stage === 'Approved' && !isRole('Viewer') ? `<button class="btn btn-s" data-act="leaseRent" data-a1="${r.id}">💰 Rent payment</button>` : '', `<button class="btn btn-s" data-act="printAgreement" data-a1="${r.id}">🖨 Lease agreement</button>`].join(''),
  rows: r => (!isRole('Viewer') ? `<button class="btn btn-w" data-act="openForm" data-close="view" data-a1="encroachments" data-a2="" data-aj="${esc(JSON.stringify({ category: 'ROW Violation / Conflict', rowId: r.id, projectId: r.projectId, province: r.province }))}">⚠ Log violation</button>` : '') + (r.stage !== 'Stopped' && can.approve() ? `<button class="btn btn-d" data-act="wfTerminal" data-a1="rows" data-a2="${r.id}" data-a3="Stop">⏹ Stop ROW lease</button>` : ''),
  payments: r => r.stage === 'Released' ? `<button class="btn btn-s" data-act="printReceipt" data-a1="${r.id}">🧾 Receipt (English)</button><button class="btn btn-s" data-act="printReceiptUr" data-a1="${r.id}">🧾 رسید (اردو)</button>` : '',
  dbpfc: r => !TERMINAL.includes(r.stage) && !isRole('Viewer') ? `<button class="btn btn-s" data-act="dbpfcPay" data-a1="${r.id}">💰 Generate cheque request</button>` : '',
  landowners: r => (r.status === 'Deceased' && can.create() && !S.mutations.some(m => m.deceasedId === r.id && !TERMINAL.includes(m.stage) && m.stage !== 'Approved & Applied') ? `<button class="btn btn-w" data-act="openForm" data-close="view" data-a1="mutations" data-a2="" data-aj="${esc(JSON.stringify({ deceasedId: r.id, surveyIds: (r.shares || []).map(s => s.surveyId), province: r.province }))}">🔁 Start succession mutation</button>` : '') + `<button class="btn btn-s" data-act="printOwner" data-a1="${r.id}">🖨 Landowner statement</button>` + (can.create() ? `<button class="btn btn-s" data-act="openForm" data-close="view" data-a1="cases" data-a2="" data-aj="${esc(JSON.stringify({ owners: [{ landownerId: r.id, status: r.ownerType, share: 100 }] }))}">⚖ New case</button>` : ''),
  surveys: r => r.lat ? `<button class="btn btn-s" data-act="navigate" data-href="${pageUrl('gis')}?lat=${num(r.lat)}&lng=${num(r.lng)}&id=${esc(r.id)}">📍 Map</button>` : '',
  projects: r => `<button class="btn btn-s" data-act="navigate" data-href="${pageUrl('reports')}?report=r9&project=${esc(r.id)}">📈 Project status report</button>`
};

/* ---------- module actions ---------- */
async function caseToLease(id) {
  const c = byId('cases', id); const t = caseTotals(c);
  const l = { id: uid(), code: nextCode('LSE-', 5), province: c.province, projectId: c.projectId, caseId: c.id, kind: byId('surveys', c.leaseLines[0]?.surveyId)?.landClass === 'Government' ? 'Government Land' : 'Private Land', registrationNo: c.leaseNo,
    landownerIds: c.owners.map(o => o.landownerId), surveyIds: uniq(c.leaseLines.map(x => x.surveyId)), initialArea: +t.leaseArea.toFixed(4), subsequentArea: +t.subArea.toFixed(4),
    startDate: c.effectiveDate || today(), termYears: Math.max(1, num(c.leaseTerm) / 12), ratePerAcre: num(c.leaseRate), escalation: 10, autoExtend: 'Yes — extends unless terminated by lessee', stage: 'Draft', createdAt: nowStr(), createdBy: ME.username, history: [] };
  pushHist(l, 'Created from case ' + c.code, '', 'Draft'); S.leases.push(l); audit('leases', l, 'Created from case', null, l); persist(); toast('Lease ' + l.code + ' generated from ' + c.code, 'success'); openView('leases', l.id); render();
}
async function caseDocs(id) {
  const c = byId('cases', id);
  const v = await dialog({ title: 'Supporting documents received — ' + c.code, html: `<p class="note">The case itself stays locked after submission; the document checklist can be updated until HO approval and every change is logged.</p><div class="checks u-cols-1 u-mt-10">${CASE_DOCS.map((d, i) => `<label><input type="checkbox" class="cdk" value="${i}" ${(c.docChecks || []).includes(d) ? 'checked' : ''}> ${esc(d)}</label>`).join('')}</div>` });
  if (!v) return; const before = JSON.parse(JSON.stringify(c)); c.docChecks = $$('.cdk').filter(x => x.checked).map(x => CASE_DOCS[+x.value]);
  pushHist(c, 'Document checklist updated (' + c.docChecks.length + '/' + CASE_DOCS.length + ')', c.stage, c.stage); audit('cases', c, 'Document checklist updated', before, c); persist(); refreshView('cases', id);
}
function caseToPayments(id) {
  const c = byId('cases', id); const t = caseTotals(c);
  const made = payOwners(c.owners.map(o => ({ landownerId: o.landownerId, gross: t.total * num(o.share) / 100 })), { province: c.province, projectId: c.projectId, caseId: c.id, category: 'Case Compensation', payType: num(c.leaseRate) ? 'Yearly Lease' : 'One-time', periodFrom: c.effectiveDate || today(), periodTo: num(c.leaseTerm) ? addYears(c.effectiveDate || today(), num(c.leaseTerm) / 12) : '', landClass: 'Private', remarks: 'Generated from approved case ' + c.code });
  persist(); toast(made.length + ' payment request(s) generated — pending verification & release', 'success'); refreshView('cases', id);
}
async function leaseRenew(id) {
  const l = byId('leases', id); const i = leaseInfo(l); const newRate = Math.round(num(l.ratePerAcre) * (1 + num(l.escalation) / 100));
  const v = await dialog({ title: 'Renew lease ' + l.code, html: `<p class="note">Current expiry ${fdt(i.end)} · rate ${rs(l.ratePerAcre)}/acre. Renewal is sent for approval.</p><div class="fgrid u-mt-10"><div class="fg"><label>Extend by (years)</label><input data-k="y" type="number" value="${num(l.termYears) >= 5 ? 5 : 1}"></div><div class="fg"><label>New rate (Rs/acre/yr) — escalated ${num(l.escalation)}%</label><input data-k="r" type="number" value="${newRate}"></div><div class="fg"><label>Subsequent area (acres)</label><input data-k="a" type="number" step="any" value="${l.subsequentArea ?? l.initialArea}"></div><div class="fg"><label>Remarks</label><input data-k="n"></div></div>` });
  if (!v || !num(v.y)) return; const before = JSON.parse(JSON.stringify(l));
  l.renewals = l.renewals || []; l.termYears = num(l.termYears) + num(v.y); const newEnd = addYears(l.startDate, l.termYears);
  l.renewals.push({ at: nowStr(), user: ME.username, prevEnd: i.end, newEnd, prevRate: l.ratePerAcre, newRate: num(v.r) }); l.ratePerAcre = num(v.r); l.subsequentArea = num(v.a);
  const from = l.stage; l.stage = 'Under Review'; pushHist(l, 'Renewal requested (+' + v.y + ' yr)', from, 'Under Review', v.n); audit('leases', l, 'Renewed', before, l, v.n); persist(); toast('Renewal recorded — new expiry ' + fdt(newEnd) + ', pending approval', 'success'); refreshView('leases', id);
}
async function leaseRent(id) {
  const l = byId('leases', id); const i = leaseInfo(l); const paid = S.payments.filter(p => p.leaseId === id && !TERMINAL.includes(p.stage)); const years = uniq(paid.map(p => p.periodFrom)).length;
  const v = await dialog({ title: 'Lease rent payment — ' + l.code, html: `<p class="note">Annual rent ${rs(i.rent)} · ${years} period(s) already raised.</p><div class="fgrid u-mt-10"><div class="fg"><label>Payment type</label><select data-k="t"><option>Yearly Lease</option><option>Advance Lease (multi-year)</option></select></div><div class="fg"><label>Number of years</label><input data-k="y" type="number" value="1" min="1"></div></div>` });
  if (!v) return; const ny = Math.max(1, Math.floor(num(v.y))); const from = years ? iso(new Date(new Date(addYears(l.startDate, years)).getTime() + 864e5)) : l.startDate; const to = addYears(from, ny);
  const owners = l.caseId ? byId('cases', l.caseId).owners.map(o => ({ landownerId: o.landownerId, share: o.share })) : (l.landownerIds || []).map(x => ({ landownerId: x, share: 100 / l.landownerIds.length }));
  const made = payOwners(owners.map(o => ({ landownerId: o.landownerId, gross: i.rent * ny * num(o.share) / 100 })), { province: l.province, projectId: l.projectId, leaseId: l.id, category: 'Lease Rent', payType: v.t, periodFrom: from, periodTo: to, landClass: l.kind === 'Government Land' ? 'Government' : 'Private', remarks: `Rent ${ny} yr for lease ${l.code}` });
  persist(); toast(made.length + ' rent payment request(s) created for ' + fdt(from) + ' – ' + fdt(to), 'success'); refreshView('leases', id);
}
function dbpfcPay(id) {
  const d = byId('dbpfc', id); const n = S.payments.filter(p => p.dbpfcId === id && !TERMINAL.includes(p.stage)).length; const base = new Date(d.periodStart || d.createdAt || today()); base.setFullYear(base.getFullYear() + n); const from = iso(base);
  const made = payOwners([{ payee: 'Government of Sindh — Board of Revenue (' + unitName(d.districtId) + ')', gross: d.annual }], { province: 'SND', projectId: d.projectId, dbpfcId: d.id, category: 'Govt Land Rent (DBPFC)', payType: 'Yearly Lease', periodFrom: from, periodTo: addYears(from, 1), landClass: 'Government', whtPct: 0, remarks: (d.fixedRate ? 'DBPFC fixed rate' : 'ESTIMATED rate — subject to DBPFC') + ' · ' + d.code });
  made.forEach(p => p.whtPct = 0); persist(); if (made.length) toast('Cheque request ' + made[0].code + ' created (' + (d.fixedRate ? 'fixed' : 'estimated') + ' rate)', 'success'); refreshView('dbpfc', id);
}

/* ---------- alerts & approvals ---------- */
function alerts() {
  const A = []; const push = (sev, t, s, c, id) => A.push({ sev, t, s, c, id });
  ctxRows('leases').forEach(l => { const i = leaseInfo(l); if (l.stage === 'Stopped') return; if (i.days < 0) push('d', `Lease ${l.code} expired ${-i.days} days ago`, projCode(l.projectId) + ' · renew or stop the lease', 'leases', l.id); else if (i.days <= 180) push(i.days <= 60 ? 'd' : 'w', `Lease ${l.code} expires in ${i.days} days (${i.days <= 30 ? '30' : i.days <= 60 ? '60' : i.days <= 90 ? '90' : '180'}-day alert)`, projCode(l.projectId) + ' · expiry ' + fdt(i.end), 'leases', l.id); });
  ctxRows('rows').forEach(r => { const i = rowInfo(r); if (r.stage !== 'Stopped' && i.nextDays <= 60) push('w', `ROW ${r.code} yearly renewal due in ${i.nextDays} days`, r.name + ' · ' + fdt(i.next), 'rows', r.id); });
  ctxRows('encroachments').forEach(e => { if (e.stage !== 'Resolved' && ['High', 'Critical'].includes(e.risk)) push('d', `${e.risk} risk: ${e.category} (${e.code})`, projCode(e.projectId) + ' · open since ' + fdt(e.detectedOn), 'encroachments', e.id); });
  ctxRows('grievances').forEach(g => { if (!['Resolved', 'Closed'].includes(g.stage) && g.dueDate && daysTo(g.dueDate) < 0) push('w', `Grievance ${g.code} overdue by ${-daysTo(g.dueDate)} days`, g.complainant + ' · ' + g.category, 'grievances', g.id); });
  ctxRows('dbpfc').forEach(d => { if (!num(d.fixedRate) && d.stage !== 'Stopped') push('i', `DBPFC ${d.code}: rate not yet fixed by committee`, 'Paying on estimated rate ' + rs(d.estRate) + '/acre', 'dbpfc', d.id); });
  ctxRows('budgets').forEach(b => { const x = budgetFor(b.projectId, b.year); if (x && x.approved && (x.spent + x.committed) / x.approved > .9) push((x.balance < 0 ? 'd' : 'w'), `Budget ${projCode(b.projectId)} ${b.year} at ${fmt((x.spent + x.committed) / x.approved * 100, 0)}% utilisation`, 'Balance ' + rs(x.balance), 'budgets', b.id); });
  ctxRows('landowners').forEach(lo => { if (lo.status === 'Deceased' && S.leases.some(l => (l.landownerIds || []).includes(lo.id) && leaseInfo(l).status !== 'Expired' && l.stage !== 'Stopped')) { const m = S.mutations.find(x => x.deceasedId === lo.id && !TERMINAL.includes(x.stage)); push('w', `Deceased landowner ${lo.code} on an active lease`, m ? 'Mutation ' + m.code + ' in progress — ' + stLabel(m.stage) : 'Start a succession mutation to transfer shares to legal heirs', m ? 'mutations' : 'landowners', m ? m.id : lo.id); } });
  ctxRows('legal').forEach(l => { if (!legalOpen(l)) return; const d = daysTo(l.nextHearing); if (d != null && d >= 0 && d <= 7) push('w', `Court hearing in ${d} day(s): ${l.caseNo} (${l.court})`, l.parties + ' · ' + l.code, 'legal', l.id); if (l.stayOrder === 'Yes') push('d', `Stay order in force — ${l.caseNo}`, 'Payments to linked landowners / surveys are blocked · ' + l.code, 'legal', l.id); });
  ctxRows('surveys').forEach(s => { const t = ownerShareTotal(s.id); if (t > 0 && Math.abs(t - 100) > .5) push('i', `Survey ${s.code}: owner shares total ${fmt(t, 1)}%`, 'Title gap — update ownership shares', 'surveys', s.id); });
  return A.sort((a, b) => 'dwi'.indexOf(a.sev) - 'dwi'.indexOf(b.sev));
}
function myQueue() {
  const out = []; ['cases', 'payments', 'acquisitions', 'leases', 'rows', 'dbpfc', 'grievances', 'encroachments', 'mutations'].forEach(c => ctxRows(c).forEach(r => {
    if (!canAdvance(c, r)) return; const i = stageIdx(c, r);
    out.push({ c, r, next: WF[c].stages[i + 1] });
  }));
  return out;
}
function scrInbox() {
  const q = myQueue(); const al = alerts();
  return `<div class="grid2"><div class="card"><div class="card-h"><div><h3>🗂 My approval queue (${q.length})</h3><p>Items waiting for your action as <b>${esc(ME.role)}</b> — multi-level approvals per SoW §3.8</p></div></div>
  <div class="tw"><table class="t"><thead><tr><th>Module</th><th>Ref</th><th>Summary</th><th>Current</th><th>Next step</th><th>Waiting</th></tr></thead><tbody>${q.length ? q.map(({ c, r, next }) => { const last = (r.history || []).at(-1); return `<tr class="u-clickable" data-act="openView" data-a1="${c}" data-a2="${r.id}"><td>${esc(SPEC[c].title)}</td><td class="code">${esc(r.code)}</td><td>${esc(queueSummary(c, r))}</td><td>${stageBadge(r.stage)}</td><td>${esc((WF[c].step && WF[c].step[next]) || next)}</td><td>${last ? Math.max(0, Math.round((Date.now() - new Date(last.at)) / 864e5)) + 'd' : '-'}</td></tr>`; }).join('') : '<tr><td colspan="6" class="empty">Nothing waiting for you 🎉</td></tr>'}</tbody></table></div></div>
  <div class="card"><div class="card-h"><div><h3>🔔 System alerts (${al.length})</h3><p>Automatic: lease expiry (180/90/60/30 days), ROW yearly renewals, high-risk encroachments, overdue grievances, budget limits, title gaps</p></div></div>
  ${al.map(a => `<a class="al ${a.sev}" href="${pageUrl(a.c)}?view=${encodeURIComponent(a.id)}" data-act="openView" data-a1="${a.c}" data-a2="${a.id}"><span class="i"></span><div class="tx"><b>${esc(a.t)}</b><small>${esc(a.s)}</small></div></a>`).join('') || '<div class="empty">No alerts</div>'}</div></div>`;
}
function queueSummary(c, r) {
  if (c === 'cases') return projCode(r.projectId) + ' · ' + (r.owners || []).length + ' owner(s) · ' + rs(caseTotals(r).total);
  if (c === 'payments') return (byId('landowners', r.landownerId)?.name || r.payee) + ' · ' + rs(r.net);
  if (c === 'grievances') return r.complainant + ' · ' + r.category;
  if (c === 'encroachments') return r.category + ' · ' + r.risk;
  return projCode(r.projectId);
}

/* ---------- dashboard ---------- */
function kpi(l, v, s, cls, go_) { const t = go_ ? 'a' : 'div'; return `<${t} class="kpi ${cls || ''}"${go_ ? ` href="${pageUrl(go_)}"` : ''}><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></${t}>`; }
function scrDashboard() {
  const yr = new Date().getFullYear(); const P = ctxRows('payments'); const L = ctxRows('leases'); const SV = ctxRows('surveys');
  const held = sum(SV.filter(s => ['Acquired', 'Leased'].includes(s.status)), 'totalArea');
  const leaseAct = L.filter(l => l.stage !== 'Stopped' && leaseInfo(l).days >= 0); const exp180 = leaseAct.filter(l => leaseInfo(l).days <= 180).length;
  const paidY = sum(P.filter(p => p.stage === 'Released' && new Date(p.chequeDate || p.periodFrom).getFullYear() === yr), 'net');
  const pend = sum(P.filter(p => ['Requested', 'Verified'].includes(p.stage)), 'net') + sum(ctxRows('cases').filter(c => c.stage === 'HO Approved' && !S.payments.some(p => p.caseId === c.id)), c => caseTotals(c).total);
  const openG = ctxRows('grievances').filter(g => !['Resolved', 'Closed'].includes(g.stage)).length;
  const encHi = ctxRows('encroachments').filter(e => e.stage !== 'Resolved' && ['High', 'Critical'].includes(e.risk)).length; const encO = ctxRows('encroachments').filter(e => e.stage !== 'Resolved').length;
  const q = myQueue().length; const al = alerts();
  const casesP = ctxRows('cases').filter(c => !['HO Approved', 'Cancelled'].includes(c.stage)).length;
  return `<div class="demo-banner ${S.settings.presentation ? 'hidden' : ''}">🧪 <b>Demonstration build ${APP_VER}</b> — sample data, stored in this browser only. Production release: central database, Active Directory sign-in, encrypted storage, SAP integration.</div>
  <div class="kpis">${kpi('Landowners', fmt(ctxRows('landowners').length), 'unique CNIC-based IDs', '', 'landowners')}${kpi('Land held (acquired / leased)', fmt(held, 1) + ' ac', SV.length + ' surveys registered', 'g', 'surveys')}
  ${kpi('Active leases', leaseAct.length, exp180 + ' expiring within 180 days', exp180 ? 'w' : 'g', 'leases')}${kpi('Cases in approval', casesP, 'compensation cases in workflow', '', 'cases')}
  ${kpi('Paid ' + yr, rsM(paidY), 'released cheques (net)', 'g', 'payments')}${kpi('Pending liabilities', rsM(pend), 'requested + approved unpaid', 'w', 'payments')}
  ${kpi('Open grievances / IIR', openG, ctxRows('grievances').filter(g => g.escalated && !['Resolved', 'Closed'].includes(g.stage)).length + ' escalated', openG ? 'w' : 'g', 'grievances')}${kpi('Open encroachments', encO, encHi + ' high / critical risk', encHi ? 'd' : 'g', 'encroachments')}</div>
  <div class="grid3">
   <div class="card"><div class="card-h"><div><h3>Land status by ${CTX === 'ALL' ? 'province' : 'district'}</h3><p>Acres per status (Survey register)</p></div></div><div class="chartbox"><canvas id="c1"></canvas></div></div>
   <div class="card"><div class="card-h"><div><h3>Financial position — Government vs Private</h3><p>Commitments, actuals and pending liabilities (Rs M)</p></div></div><div class="chartbox"><canvas id="c2"></canvas></div></div>
   <div class="card"><div class="card-h"><div><h3>Payments released ${yr}</h3><p>Net, by cheque month (Rs M)</p></div></div><div class="chartbox"><canvas id="c3"></canvas></div></div>
   <div class="card"><div class="card-h"><div><h3>Lease expiry profile</h3><p>Alert bands 30 / 60 / 90 / 180 days</p></div></div><div class="chartbox"><canvas id="c4"></canvas></div></div>
   <div class="card"><div class="card-h"><div><h3>Budget vs utilisation ${yr}</h3><p>Approved, spent and committed by project (Rs M)</p></div></div><div class="chartbox"><canvas id="c5"></canvas></div></div>
   <div class="card"><div class="card-h"><div><h3>Grievances & IIR by category</h3><p>Open vs resolved — recurring-issue analytics</p></div></div><div class="chartbox"><canvas id="c6"></canvas></div></div>
  </div>
  <div class="grid2"><div class="card"><div class="card-h"><div><h3>🔔 Alerts (${al.length})</h3><p>Automatic system alerts</p></div><button class="btn btn-s btn-sm" data-act="navigate" data-href="${pageUrl('inbox')}">Open queue (${q})</button></div>${al.slice(0, 7).map(a => `<a class="al ${a.sev}" href="${pageUrl(a.c)}?view=${encodeURIComponent(a.id)}" data-act="openView" data-a1="${a.c}" data-a2="${a.id}"><span class="i"></span><div class="tx"><b>${esc(a.t)}</b><small>${esc(a.s)}</small></div></a>`).join('') || '<div class="empty">No alerts</div>'}</div>
  <div class="card"><div class="card-h"><div><h3>🧾 Recent activity</h3><p>From the audit trail</p></div><button class="btn btn-s btn-sm" data-act="navigate" data-href="${pageUrl('audit')}">Full audit trail</button></div>${auditTable(visibleAudit().filter(a => a.action !== 'Login' && a.action !== 'Logout').slice(0, 9), true)}</div></div>`;
}
function chartTheme() { const d = document.documentElement.dataset.theme === 'dark'; return { t: d ? '#c2cedd' : '#3e4c5e', g: d ? '#2a3b56' : '#e6ebf2' }; }
function mkChart(id, cfg) {
  const el = document.getElementById(id); if (!el || !window.Chart) return; const th = chartTheme();
  cfg.options = Object.assign({ responsive: true, maintainAspectRatio: false, plugins: {} }, cfg.options || {});
  cfg.options.plugins.legend = Object.assign({ labels: { color: th.t, boxWidth: 12, font: { size: 11 } } }, cfg.options.plugins.legend || {});
  if (cfg.type !== 'doughnut' && cfg.type !== 'pie') { cfg.options.scales = cfg.options.scales || { x: {}, y: {} }; Object.values(cfg.options.scales).forEach(s => { s.ticks = Object.assign({ color: th.t, font: { size: 10.5 } }, s.ticks || {}); s.grid = { color: th.g }; }); }
  charts[id] = new Chart(el, cfg);
}
const PAL = { blue: '#2368b0', green: '#16a061', amber: '#e09a1a', red: '#d93a3a', purple: '#7a4fc2', teal: '#1597a6', grey: '#8a9bb0' };
function drawDashboard() {
  const yr = new Date().getFullYear();
  // c1 land status
  const SV = ctxRows('surveys'); const groups = CTX === 'ALL' ? Object.keys(PROV) : uniq(SV.map(s => unitChain(s.unitId)[0]?.id));
  const gl = g => CTX === 'ALL' ? PROV[g].name : unitName(g); const inG = (s, g) => CTX === 'ALL' ? s.province === g : unitChain(s.unitId)[0]?.id === g;
  const stCol = { Proposed: PAL.grey, 'Under Acquisition': PAL.amber, Acquired: PAL.green, Leased: PAL.blue, Disputed: PAL.red };
  mkChart('c1', { type: 'bar', data: { labels: groups.map(gl), datasets: LAND_STATUS.map(st => ({ label: st, backgroundColor: stCol[st], data: groups.map(g => +sum(SV.filter(s => inG(s, g) && s.status === st), 'totalArea').toFixed(1)) })) }, options: { scales: { x: { stacked: true }, y: { stacked: true, title: { display: true, text: 'acres' } } } } });
  // c2 govt vs private
  const P = ctxRows('payments'); const cls = p => p.landClass === 'Government' ? 'Government' : 'Private';
  const caseCls = c => byId('surveys', c.leaseLines?.[0]?.surveyId)?.landClass === 'Government' ? 'Government' : 'Private';
  const cats = ['Government', 'Private'];
  const commit = k => (sum(ctxRows('cases').filter(c => c.stage === 'HO Approved' && caseCls(c) === k), c => caseTotals(c).total) + sum(ctxRows('dbpfc').filter(d => k === 'Government' && d.stage !== 'Stopped'), 'annual')) / 1e6;
  mkChart('c2', { type: 'bar', data: { labels: cats, datasets: [{ label: 'Commitments', backgroundColor: PAL.blue, data: cats.map(commit) }, { label: 'Actuals (released)', backgroundColor: PAL.green, data: cats.map(k => sum(P.filter(p => p.stage === 'Released' && cls(p) === k), 'net') / 1e6) }, { label: 'Pending liabilities', backgroundColor: PAL.amber, data: cats.map(k => sum(P.filter(p => ['Requested', 'Verified'].includes(p.stage) && cls(p) === k), 'net') / 1e6) }] }, options: { scales: { x: {}, y: { title: { display: true, text: 'Rs million' } } } } });
  // c3 monthly
  const mons = [...Array(12)].map((_, i) => new Date(yr, i, 1).toLocaleString('en', { month: 'short' }));
  mkChart('c3', { type: 'bar', data: { labels: mons, datasets: [{ label: 'Released (Rs M)', backgroundColor: PAL.green, data: mons.map((_, i) => sum(P.filter(p => p.stage === 'Released' && p.chequeDate && new Date(p.chequeDate).getFullYear() === yr && new Date(p.chequeDate).getMonth() === i), 'net') / 1e6) }] }, options: { plugins: { legend: { display: false } }, scales: { x: {}, y: { title: { display: true, text: 'Rs million' } } } } });
  // c4 lease expiry
  const b = { 'Expired': 0, '≤30 d': 0, '31–60 d': 0, '61–90 d': 0, '91–180 d': 0, '> 180 d': 0 };
  ctxRows('leases').filter(l => l.stage !== 'Stopped').forEach(l => { const d = leaseInfo(l).days; if (d == null) return; const k = d < 0 ? 'Expired' : d <= 30 ? '≤30 d' : d <= 60 ? '31–60 d' : d <= 90 ? '61–90 d' : d <= 180 ? '91–180 d' : '> 180 d'; b[k]++; });
  mkChart('c4', { type: 'bar', data: { labels: Object.keys(b), datasets: [{ label: 'Leases', data: Object.values(b), backgroundColor: [PAL.red, PAL.red, PAL.red, PAL.amber, PAL.amber, PAL.green] }] }, options: { plugins: { legend: { display: false } }, scales: { x: {}, y: { ticks: { precision: 0 }, title: { display: true, text: 'leases' } } } } });
  // c5 budgets
  const B = ctxRows('budgets').filter(x => +x.year === yr).slice(0, 8).map(x => ({ p: projCode(x.projectId), ...budgetFor(x.projectId, x.year) }));
  mkChart('c5', { type: 'bar', data: { labels: B.map(x => x.p), datasets: [{ label: 'Approved', backgroundColor: '#b9cde6', data: B.map(x => x.approved / 1e6) }, { label: 'Spent', backgroundColor: PAL.green, data: B.map(x => x.spent / 1e6) }, { label: 'Committed', backgroundColor: PAL.amber, data: B.map(x => x.committed / 1e6) }] }, options: { scales: { x: { ticks: { autoSkip: false, maxRotation: 45 } }, y: { title: { display: true, text: 'Rs million' } } } } });
  // c6 grievances
  const G = ctxRows('grievances'); const gc = uniq(G.map(g => g.category));
  mkChart('c6', { type: 'bar', data: { labels: gc, datasets: [{ label: 'Open', backgroundColor: PAL.amber, data: gc.map(c => G.filter(g => g.category === c && !['Resolved', 'Closed'].includes(g.stage)).length) }, { label: 'Resolved / closed', backgroundColor: PAL.green, data: gc.map(c => G.filter(g => g.category === c && ['Resolved', 'Closed'].includes(g.stage)).length) }] }, options: { indexAxis: 'y', scales: { x: { stacked: true, ticks: { precision: 0 } }, y: { stacked: true } } } });
}

/* ---------- audit ---------- */
function auditTable(rows, compact) {
  if (!rows.length) return '<div class="empty">No audit entries</div>';
  const show = v => { if (v == null || v === '') return '∅'; if (typeof v === 'object') { const s = JSON.stringify(v); return s.length > 70 ? s.slice(0, 70) + '…' : s; } return String(v).length > 70 ? String(v).slice(0, 70) + '…' : v; };
  return `<div class="tw ${compact ? 'is-compact' : 'is-tall'}"><table class="t"><thead><tr><th>When</th><th>User</th><th>Module</th><th>Record</th><th>Action</th>${compact ? '' : '<th>Changes (before → after)</th>'}</tr></thead><tbody>${rows.map(a => `<tr><td class="u-nowrap">${fdtt(a.at)}</td><td>${esc(a.user)}<br><small class="note">${esc(a.role)}</small></td><td>${esc(SPEC[a.coll]?.title || a.coll)}</td><td>${a.recId && byId(a.coll, a.recId) && screenAllowed(a.coll) ? `<a href="${pageUrl(a.coll)}?view=${encodeURIComponent(a.recId)}" class="mono" data-act="openView" data-a1="${a.coll}" data-a2="${a.recId}">${esc(a.code) || 'View record'}</a>` : `<span class="mono">${esc(a.code)}</span>`}</td><td>${esc(a.action)}${a.note ? `<br><i class="note">“${esc(a.note)}”</i>` : ''}</td>${compact ? '' : `<td class="u-fs-115">${(a.changes || []).filter(c => !['createdAt', 'createdBy'].includes(c.f)).slice(0, 8).map(c => `<div><b>${esc(c.f)}</b>: <span class="u-danger">${esc(show(c.from))}</span> → <span class="u-accent">${esc(show(c.to))}</span></div>`).join('') || '<span class="note">—</span>'}</td>`}</tr>`).join('')}</tbody></table></div>`;
}
function scrAudit() {
  const f = UI.af || {}; let rows = visibleAudit();
  if (f.m) rows = rows.filter(a => a.coll === f.m); if (f.u) rows = rows.filter(a => a.user === f.u); if (f.q) rows = rows.filter(a => (a.code + ' ' + a.action + ' ' + (a.note || '')).toLowerCase().includes(f.q.toLowerCase()));
  const shown = rows.slice(0, 400);
  return `<div class="card"><div class="card-h"><div><h3>Audit trail</h3><p>Every login, create, edit (field-level before → after), approval, return, cancellation, upload and deletion — SoW §4.2 comprehensive audit logs</p></div></div>
  <div class="bar"><select class="sel" data-act="setAuditFilter" data-a1="m"><option value="">All modules</option>${uniq(visibleAudit().map(a => a.coll)).map(m => `<option value="${m}" ${f.m === m ? 'selected' : ''}>${esc(SPEC[m]?.title || m)}</option>`).join('')}</select>
  <select class="sel" data-act="setAuditFilter" data-a1="u"><option value="">All users</option>${uniq(visibleAudit().map(a => a.user)).map(u => `<option ${f.u === u ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select>
  <input class="search" placeholder="Search record / action…" value="${esc(f.q || '')}" data-act="setAuditFilter" data-a1="q"><span class="grow"></span><span class="note">${rows.length} entries${rows.length > 400 ? ' (showing latest 400)' : ''}</span>
  <button class="btn btn-s btn-sm" data-act="auditExport">Export Excel</button></div>${auditTable(shown)}</div>`;
}

/* ---------- documents ---------- */
function scrDocuments() {
  const f = UI.df || {}; let docs = visibleDocs().filter(d => f.del ? true : !d.deleted);
  docs = docs.filter(d => { const r = byId(d.coll, d.recId); return !r || inCtx(d.coll, r); });
  if (f.q) docs = docs.filter(d => (d.name + ' ' + d.recCode + ' ' + d.category).toLowerCase().includes(f.q.toLowerCase())); if (f.cat) docs = docs.filter(d => d.category === f.cat);
  return `<div class="card"><div class="card-h"><div><h3>📁 Document & record repository</h3><p>All uploaded documents with version and deletion history, linked to their land records. Upload from any record's “Documents” tab.</p></div></div>
  <div class="bar"><input class="search" placeholder="Search file / record…" value="${esc(f.q || '')}" data-act="setDocFilter" data-a1="q">
  <select class="sel" data-act="setDocFilter" data-a1="cat"><option value="">All categories</option>${DOC_CATS.map(c => `<option ${f.cat === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
  <label class="note"><input type="checkbox" ${f.del ? 'checked' : ''} data-act="setDocFilter" data-a1="del" data-src="checked"> include removed / superseded</label><span class="grow"></span><span class="note">${docs.length} document(s)</span></div>
  <div class="tw"><table class="t"><thead><tr><th>Doc ID</th><th>File</th><th>Category</th><th>Linked record</th><th>Ver.</th><th>Size</th><th>Uploaded</th><th>History</th><th>Actions</th></tr></thead><tbody>
  ${docs.length ? docs.slice().reverse().map(d => `<tr class="${d.deleted ? 'is-deleted' : ''}"><td class="mono">${esc(d.code)}</td><td><b>${esc(d.name)}</b>${d.stored ? '' : ' <small class="note">(metadata only)</small>'}</td><td>${esc(d.category)}</td><td>${byId(d.coll, d.recId) ? `<a href="${pageUrl(d.coll)}?view=${encodeURIComponent(d.recId)}" data-act="openView" data-a1="${d.coll}" data-a2="${d.recId}">${esc(SPEC[d.coll]?.title)} ${esc(d.recCode)}</a>` : esc(d.recCode)}</td><td>v${d.version}</td><td class="num">${fmt(d.size / 1024, 1)} KB</td><td>${fdtt(d.at)}<br><small class="note">${esc(uName(d.uploadedBy))}</small></td><td class="u-fs-11">${(d.history || []).map(h => esc(h.action)).join(' → ')}</td><td><div class="acts">${!d.deleted ? `<button data-act="docOpen" data-a1="${d.id}">⬇</button>${can.upload() ? `<button data-act="docRename" data-a1="${d.id}">✏️</button><button class="del" data-act="docDelete" data-a1="${d.id}">🗑</button>` : ''}` : '<span class="note">removed</span>'}</div></td></tr>`).join('') : '<tr><td colspan="9" class="empty">No documents</td></tr>'}</tbody></table></div></div>`;
}

/* ---------- users extra ---------- */
function scrUsersExtra() {
  const perms = [['View records, dashboards, reports, export', 1, 1, 1, 1], ['Create & edit draft records, upload documents', 1, 1, 1, 0], ['Bulk upload (Excel / CSV / KML)', 1, 1, 1, 0], ['Submit records for approval', 1, 1, 1, 0], ['Approve / return workflow steps', 1, 1, 0, 0], ['Cancel cases, stop payments / leases', 1, 1, 0, 0], ['Delete draft records', 1, 0, 0, 0], ['Users, roles, settings, unit factors', 1, 0, 0, 0]];
  return `<div class="grid2"><div class="card"><div class="card-h"><div><h3>Role permission matrix</h3><p>SoW §4.2 RBAC — enforced in this demo; production maps roles to Mari positions / departments via Active Directory</p></div></div>
  <div class="tw"><table class="t matrix"><thead><tr><th class="u-ta-left">Permission</th>${Object.keys(ROLES).map(r => `<th>${r}</th>`).join('')}</tr></thead><tbody>${perms.map(p => `<tr><td class="u-ta-left">${p[0]}</td>${p.slice(1).map(x => `<td>${x ? '✅' : '—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>
  <div class="card"><div class="card-h"><div><h3>Login history</h3><p>Session log (latest 30)</p></div></div><div class="tw u-mh-330"><table class="t"><thead><tr><th>When</th><th>User</th><th>Role</th><th>Device</th></tr></thead><tbody>${S.sessions.slice(0, 30).map(s => `<tr><td>${fdtt(s.at)}</td><td>${esc(s.user)}</td><td>${esc(s.role)}</td><td>${esc(s.agent)}</td></tr>`).join('')}</tbody></table></div></div></div>`;
}

/* ---------- settings ---------- */
function scrSettings() {
  const U = UNITS(); const bytes = (() => { try { return (localStorage.getItem(STORE) || '').length; } catch (e) { return 0; } })();
  return `<div class="grid2"><div class="card"><div class="card-h"><div><h3>Organisation</h3></div></div><div class="fgrid">
   <div class="fg"><label>Company name</label><input id="stCo" value="${esc(S.settings.company)}"></div><div class="fg"><label>Head office</label><input id="stHo" value="${esc(S.settings.ho)}"></div>
   <div class="fg"><label>Default WHT % (filer; non-filer = 2×)</label><input id="stWht" type="number" value="${S.settings.wht}"></div><div class="fg"><label>Theme</label><select id="stTh"><option value="light">Light</option><option value="dark" ${S.settings.theme === 'dark' ? 'selected' : ''}>Dark</option></select></div></div>
   <div class="bar u-mt-12"><button class="btn btn-p" data-act="saveSettings">Save settings</button></div></div>
  <div class="card"><div class="card-h"><div><h3>Unit conversion factors</h3><p>Acre is the primary unit (SoW §3.2). Factors marked “to confirm” must be confirmed by Mari Land Dept — SoW: “Unit conversions will be provided when required”.</p></div></div>
   <div class="tw"><table class="t"><thead><tr><th>Unit</th><th class="num">Sq ft per unit</th><th class="num">Per acre</th><th>Used in</th><th>Confirmed</th></tr></thead><tbody>${Object.entries(U).map(([u, x]) => `<tr><td><b>${u}</b></td><td class="num"><input class="u-w-110 u-ta-right" type="number" step="any" data-unit="${u}" value="${x.sqft}" ${can.admin() ? '' : 'disabled'}></td><td class="num">${fmt(43560 / x.sqft, 4)}</td><td>${Object.values(PROV).filter(p => p.units.includes(u)).map(p => p.name).join(', ') || 'all'}</td><td><input type="checkbox" data-uok="${u}" ${x.ok ? 'checked' : ''}> ${x.ok ? '' : '<span class="b b-w">to confirm</span>'}</td></tr>`).join('')}</tbody></table></div>
   <div class="bar u-mt-10"><button class="btn btn-p btn-sm" data-act="saveUnits">Save factors</button><button class="btn btn-s btn-sm" data-act="openConverter">Open converter</button></div></div>
  <div class="card"><div class="card-h"><div><h3>Approval hierarchy (configured)</h3><p>SoW §3.8 configurable role-based workflow engine — stages per process</p></div></div>
   ${Object.entries(WF).map(([c, w]) => `<div class="u-mb-8"><b>${esc(SPEC[c].title)}</b><div>${w.stages.map((s, i) => `<span class="pill">${i + 1}. ${esc((w.step && w.step[s]) || s)} — ${i === 0 ? 'User+' : 'Approver / Admin'}</span>`).join(' → ')}${w.cancel ? ' <span class="pill">Cancel</span>' : ''}${w.stop ? ' <span class="pill">Stop</span>' : ''}${w.lockAt ? ` <span class="pill">Locked at ${esc(w.lockAt)}</span>` : ''}</div></div>`).join('')}</div>
  <div class="card"><div class="card-h"><div><h3>Governance & presentation</h3><p>Controls requested by Director Land / Internal Audit</p></div></div><div class="fgrid">
   <div class="fg"><label>Segregation of duties</label><select id="stSod"><option value="strict" ${S.settings.sod === 'strict' ? 'selected' : ''}>Strict — preparer and earlier approvers cannot act again</option><option value="creator" ${S.settings.sod === 'creator' ? 'selected' : ''}>Basic — preparer cannot approve own record</option><option value="off" ${S.settings.sod === 'off' ? 'selected' : ''}>Off (not recommended)</option></select></div>
   <div class="fg"><label>Admin may act on any approval step</label><select id="stAo"><option value="0">No — Admin follows the approval matrix (recommended)</option><option value="1" ${S.settings.adminOverride ? 'selected' : ''}>Yes — emergency override</option></select></div>
   <div class="fg"><label>Presentation mode</label><select id="stPm"><option value="0">Off — show demo accounts & demo banner</option><option value="1" ${S.settings.presentation ? 'selected' : ''}>On — hide demo passwords & banner (client meetings)</option></select></div>
   <div class="fg"><label>Demo helper: quick “Switch user” buttons</label><select id="stDs"><option value="1">On</option><option value="0" ${S.settings.demoSwitch === false ? 'selected' : ''}>Off</option></select></div></div>
   <div class="bar u-mt-12"><button class="btn btn-p" data-act="saveGov">Save governance settings</button></div></div>
  <div class="card"><div class="card-h"><div><h3>Volume / performance test</h3><p>Generates realistic volume in memory (not saved) to show search, list, GIS and report speed at Mari scale</p></div></div>
   <div class="bar u-stack"><button class="btn btn-s" data-act="volumeTest" data-a1="20000" data-a2="5000" data-num="1,2">Load 20,000 landowners + 5,000 surveys / leases / payments</button><button class="btn btn-s" data-act="volumeClear">Remove volume test data</button></div>
   <p class="note" id="volMsg">${S.meta.volMsg ? esc(S.meta.volMsg) : 'No volume data loaded.'}</p></div>
  <div class="card"><div class="card-h"><div><h3>Data management</h3><p>Browser storage in use: ${fmt(bytes / 1024, 0)} KB · ${S.audit.length} audit entries</p></div></div>
   <div class="bar u-stack">
   <button class="btn btn-p" data-act="openSampleDataModal">Generate sample data (multi-province)</button><button class="btn btn-s" data-act="resetDemo">Reload standard demo data (replaces all records)</button>
   <button class="btn btn-s" data-act="backupJSON">Export full backup (JSON)</button>
   <label class="btn btn-s u-jc-center">Restore backup (JSON)<input type="file" accept=".json" class="hidden" data-act="restorePick"></label>
   <button class="btn btn-d" data-act="clearData">Clear all land data (keeps users & settings)</button></div>
   <p class="note u-mt-10">Version ${APP_VER} · single-file demo · offline-capable (map tiles need internet).</p></div></div>`;
}
function saveSettings() { const before = { ...S.settings }; S.settings.company = $('#stCo').value; S.settings.ho = $('#stHo').value; S.settings.wht = num($('#stWht').value); applyTheme($('#stTh').value); audit('settings', { code: 'SETTINGS' }, 'Updated', before, S.settings); persist(); toast('Settings saved', 'success'); render(); }
function saveUnits() { if (!can.admin()) return; const before = JSON.parse(JSON.stringify(S.settings.units)); $$('[data-unit]').forEach(i => { const v = num(i.value); if (v > 0) S.settings.units[i.dataset.unit].sqft = v; }); $$('[data-uok]').forEach(i => S.settings.units[i.dataset.uok].ok = i.checked); audit('settings', { code: 'UNIT-FACTORS' }, 'Unit factors updated', before, S.settings.units); persist(); toast('Unit conversion factors saved', 'success'); render(); }
function applyTheme(t) { document.documentElement.dataset.theme = t; S.settings.theme = t; if ($('#thBtn')) { $('#thBtn').textContent = t === 'dark' ? '☀️' : '🌙'; iconize($('#thBtn')); } }
function toggleTheme() { applyTheme(S.settings.theme === 'dark' ? 'light' : 'dark'); persist(); render(); }
async function resetDemo() { if (!(await confirmBox('Reload demo data?', 'All current records will be replaced by the demo dataset. Users and settings are kept.', 'Reload demo'))) return; const keep = { users: S.users, settings: S.settings, sessions: S.sessions }; S = blankState(); Object.assign(S, keep); buildDemo(); audit('system', { code: 'DEMO' }, 'Demo data loaded'); persist(); toast('Demo data loaded', 'success'); render(); }
async function clearData() { if (!(await confirmBox('Clear all land data?', 'Projects, surveys, landowners, cases, leases, payments, grievances, encroachments, documents and masters will be removed. Users & settings are kept. Export a backup first if needed.', 'Clear data'))) return; const keep = { users: S.users, settings: S.settings, sessions: S.sessions, audit: S.audit }; S = blankState(); Object.assign(S, keep); audit('system', { code: 'ALL' }, 'All land data cleared'); persist(); toast('All land data cleared — start entering or uploading data', 'warning'); render(); }
function backupJSON() { const b = new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'LMS_backup_' + today() + '.json'; a.click(); audit('system', { code: 'BACKUP' }, 'Backup exported'); }
/* record ids/references are embedded in inline handlers — only accept plain identifier characters */
const SAFE_ID = /^[\w.\-]{1,64}$/;
function backupIdProblem(d) {
  for (const c of COLLS) {
    if (!Array.isArray(d[c])) continue;
    for (const r of d[c]) {
      if (!r || typeof r !== 'object' || (r.id != null && !SAFE_ID.test(String(r.id)))) return 'unsafe record id in ' + c;
      for (const k in r) { if (/Ids?$/.test(k) && r[k] != null && [].concat(r[k]).some(x => x !== '' && typeof x !== 'object' && !SAFE_ID.test(String(x)))) return 'unsafe reference ' + k + ' in ' + c; }
    }
  }
  return '';
}
function restoreJSON(file) { if (!file) return; const fr = new FileReader(); fr.onload = async () => { try { const d = JSON.parse(fr.result); if (!d.meta || !d.surveys) throw new Error('Not an LMS backup file'); const bad = backupIdProblem(d); if (bad) throw new Error('Backup rejected — ' + bad); if (!(await confirmBox('Restore backup?', 'Replace all current data with the backup from ' + fdtt(d.meta.created) + '?', 'Restore'))) return; S = d; COLLS.forEach(c => S[c] = S[c] || []); audit('system', { code: 'RESTORE' }, 'Backup restored', null, null, file.name); persist(); toast('Backup restored', 'success'); render(); } catch (e) { toast('Restore failed: ' + e.message, 'error'); } }; fr.readAsText(file); }

/* ---------- unit converter (SoW §3.2 popup) ---------- */
let CONV_TARGET = null;
function openConverter(targetId) {
  CONV_TARGET = targetId || null; const p = PROV[CUR?.rec?.province || CTX] || PROV.SND; const uu = Object.keys(UNITS());
  $('#cvBody').innerHTML = `<p class="note">Acre is the primary unit. Province units: <b>${p.name}</b> — ${p.units.join(', ')}. ${uu.filter(u => !UNITS()[u].ok).length ? 'Factors for ' + uu.filter(u => !UNITS()[u].ok).join(', ') + ' are pending confirmation by Mari.' : ''}</p>
   <h4 class="u-subhead">Revenue-record entry (${p.units.join(' + ')})</h4>
   <div class="fgrid u-cols-3">${p.units.map(u => `<div class="fg"><label>${u}</label><input type="number" step="any" class="cvc" data-u="${u}" value=""></div>`).join('')}</div>
   <h4 class="u-subhead">Or single value</h4>
   <div class="fgrid"><div class="fg"><label>Value</label><input id="cvV" type="number" step="any"></div><div class="fg"><label>Unit</label><select id="cvU">${uu.map(u => `<option ${u === 'Acre' ? 'selected' : ''}>${u}</option>`).join('')}</select></div></div>
   <table class="conv-res" id="cvRes"></table>`;
  const calc = () => { let ac = 0; const comp = $$('.cvc').some(i => i.value !== ''); if (comp) $$('.cvc').forEach(i => ac += toAcres(i.value, i.dataset.u)); else ac = toAcres($('#cvV').value, $('#cvU').value); $('#cvBody').dataset.ac = ac;
    $('#cvRes').innerHTML = `<tr class="hl"><td>Acres (primary)</td><td class="num">${fmt(ac, 4)}</td></tr><tr class="hl"><td>Acre - Ghunta</td><td class="num">${ag(ac)}</td></tr>` + uu.filter(u => u !== 'Acre').map(u => `<tr class="${p.units.includes(u) ? 'hl' : ''}"><td>${u}${UNITS()[u].ok ? '' : ' <span class="b b-w">to confirm</span>'}</td><td class="num">${fmt(fromAcres(ac, u), 3)}</td></tr>`).join(''); };
  $('#cvBody').oninput = calc; calc(); $('#cvUse').classList.toggle('hidden', !CONV_TARGET); openModal('conv');
}
function useConverted() { const ac = num($('#cvBody').dataset.ac); const el = document.getElementById(CONV_TARGET); if (el) { el.value = +ac.toFixed(5); formCompute(); } closeModal('conv'); }
