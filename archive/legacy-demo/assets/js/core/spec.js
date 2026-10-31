/* Module specifications — fields, columns, workflows and validation per module
   Part of the LMS multi-page build. Loaded as a classic script;
   top-level declarations are shared across the bundle. */
/* =====================================================================
   SPEC
   ===================================================================== */
const SPEC = {
/* ---------- Administrative hierarchy master (SoR Sc 9–11, Proto 7) ---------- */
units: {
  title: 'Administrative Unit', prefix: '', noCode: false, icon: '🏛️',
  sub: 'District / Taluka / Tehsil / Qanungo Halka / Sub-Division / Deh / Mouza masters — codes auto-assigned and reused across all modules',
  code: r => nextCode(r.province + '-' + LV_ABBR(PROV[r.province].levels[r.level]) + '-', 3),
  fields: [
    { k: 'level', l: 'Level', t: 'select', req: true, rerender: true, opt: r => (PROV[r.province]?.levels || []).map((x, i) => [i, x]) },
    { k: 'parentId', l: r => 'Parent (' + (PROV[r.province]?.levels[num(r.level) - 1] || '') + ')', t: 'loc', req: true, depth: r => num(r.level) - 1, when: r => r.province && r.level !== '' && r.level != null && num(r.level) > 0 },
    { k: 'name', l: 'Name', t: 'text', req: true }
  ],
  prepare: r => { r.level = num(r.level); r.parentId = r.level === 0 ? null : r.parentId; },
  validate: (r, id) => S.units.some(u => u.id !== id && u.province === r.province && u.level === r.level && (u.parentId || null) === (r.parentId || null) && u.name.toLowerCase() === r.name.toLowerCase()) ? 'This unit already exists under the same parent.' : null,
  usage: r => { const n = S.units.filter(u => u.parentId === r.id).length + S.surveys.filter(s => s.unitId === r.id).length + S.projects.filter(p => p.districtId === r.id).length; return n ? n + ' child unit(s)/survey(s)/project(s)' : ''; },
  cols: [
    { l: 'Code', v: r => `<span class="code">${esc(r.code)}</span>`, x: r => r.code },
    { l: 'Province', v: r => esc(provName(r.province)) },
    { l: 'Level', v: r => esc(PROV[r.province].levels[r.level]) },
    { l: 'Name', v: r => `<b>${esc(r.name)}</b>`, x: r => r.name },
    { l: 'Full path', v: r => esc(unitPath(r.id)), x: r => unitPath(r.id) },
    { l: 'Sub-units', v: r => S.units.filter(u => u.parentId === r.id).length, num: 1 },
    { l: 'Surveys', v: r => S.surveys.filter(s => unitChain(s.unitId).some(u => u.id === r.id)).length, num: 1 }
  ],
  sort: (a, b) => a.province.localeCompare(b.province) || a.level - b.level || a.name.localeCompare(b.name)
},
/* ---------- Projects / Well locations (SoR Sc 15, Proto 3–4) ---------- */
projects: {
  title: 'Project / Well Location', icon: '🛢️', sub: 'Wells, pipelines, camps, compressor stations, access roads — the master list used in every compensation case',
  code: r => (r.projCode || '').toUpperCase().trim(),
  fields: [
    { k: 'projCode', l: 'Project / Location code', t: 'text', req: true, ph: 'e.g. DHRK-001', help: 'Mari convention: XXXX-NNN location, XXXX-NNP pipeline (e.g. DHRK-001, DHRK-10P)' },
    { k: 'name', l: 'Project / Location name', t: 'text', req: true, ph: 'e.g. Daharki Well-01 Location & Access Road' },
    { k: 'type', l: 'Project type', t: 'select', req: true, opt: PROJECT_TYPES },
    { k: 'block', l: 'Block / Concession (block code)', t: 'text', req: true, ph: 'e.g. Daharki D&PL' },
    { k: 'districtId', l: 'District', t: 'loc', depth: 0, req: true },
    { k: 'requiredArea', l: 'Required area', t: 'area' },
    { k: 'lat', l: 'Latitude', t: 'number', ph: '28.0612' }, { k: 'lng', l: 'Longitude', t: 'number', ph: '69.6874' },
    { k: 'status', l: 'Status', t: 'select', req: true, opt: ['Active', 'Completed', 'Cancelled'] },
    { k: 'description', l: 'Description', t: 'textarea' }
  ],
  noCode: true,
  defaults: () => ({ status: 'Active' }),
  validate: (r, id) => S.projects.some(p => p.id !== id && (p.code || '').toUpperCase() === (r.projCode || '').toUpperCase().trim()) ? 'Project code already exists.' : null,
  prepare: r => { if (r.id) r.code = (r.projCode || r.code).toUpperCase().trim(); },
  usage: r => { const n = S.cases.filter(c => c.projectId === r.id).length + S.leases.filter(c => c.projectId === r.id).length + S.payments.filter(c => c.projectId === r.id).length; return n ? n + ' case(s)/lease(s)/payment(s)' : ''; },
  cols: [
    { l: 'Code', v: r => `<span class="code">${esc(r.code)}</span>`, x: r => r.code },
    { l: 'Name', v: r => `<b>${esc(r.name)}</b>`, x: r => r.name },
    { l: 'Type', v: r => esc(r.type) }, { l: 'Province', v: r => esc(provName(r.province)) },
    { l: 'District', v: r => esc(unitName(r.districtId)) }, { l: 'Block', v: r => esc(r.block) },
    { l: 'Surveys', v: r => S.surveys.filter(s => (s.projectIds || []).includes(r.id)).length, num: 1 },
    { l: 'Cases', v: r => S.cases.filter(c => c.projectId === r.id).length, num: 1 },
    { l: 'Paid (Rs)', v: r => fmt(sum(S.payments.filter(p => p.projectId === r.id && p.stage === 'Released'), 'net')), num: 1 },
    { l: 'Status', v: r => stageBadge(r.status), x: r => r.status }
  ]
},
/* ---------- Survey / Khasra register (SoW §3.1, SoR Sc 11, Proto 6–7) ---------- */
surveys: {
  title: 'Survey / Khasra (Area)', icon: '🗺️', sub: 'Land parcels by Survey / Block / Khasra No. with province hierarchy, total vs occupied area and status',
  code: r => nextCode('AREA-', 6),
  fields: [
    { k: 'unitId', l: r => 'Location (' + (PROV[r.province]?.levels.join(' → ') || 'select province') + ')', t: 'loc', req: true },
    { k: 'surveyNo', l: r => PROV[r.province]?.rev || 'Survey / Khasra No.', t: 'text', req: true },
    { k: 'blockNo', l: 'Block No.', t: 'text', when: r => r.province === 'SND' },
    { k: 'khasraType', l: 'Rural (Khasra) / Urban (Survey)', t: 'select', opt: ['Rural', 'Urban'], when: r => r.province === 'KPK', req: true },
    { k: 'totalArea', l: 'Total area of survey (primary unit: acre)', t: 'area', req: true },
    { k: 'landClass', l: 'Land class', t: 'select', req: true, opt: ['Private', 'Government'] },
    { k: 'status', l: 'Land status', t: 'select', req: true, opt: LAND_STATUS },
    { k: 'projectIds', l: 'Linked projects', t: 'multiref', coll: 'projects' },
    { k: 'lat', l: 'Latitude', t: 'number' }, { k: 'lng', l: 'Longitude', t: 'number' },
    { k: 'remarks', l: 'Remarks', t: 'textarea' }
  ],
  defaults: () => ({ landClass: 'Private', status: 'Proposed' }),
  validate: (r, id) => {
    if (S.surveys.some(s => s.id !== id && s.unitId === r.unitId && s.surveyNo.toLowerCase() === r.surveyNo.toLowerCase() && (s.blockNo || '') === (r.blockNo || ''))) return 'This survey/khasra number already exists in the selected ' + PROV[r.province].levels.at(-1) + '.';
    if (num(r.totalArea) <= 0) return 'Total area must be greater than zero.';
    return null;
  },
  usage: r => { const n = S.cases.filter(c => (c.leaseLines || []).some(l => l.surveyId === r.id)).length + S.landowners.filter(l => (l.shares || []).some(s => s.surveyId === r.id)).length; return n ? n + ' case(s)/landowner share(s)' : ''; },
  cols: [
    { l: 'Area ID', v: r => `<span class="code">${esc(r.code)}</span>`, x: r => r.code },
    { l: 'Survey / Khasra', v: r => `<b>${esc(surveyNoTxt(r))}</b>`, x: r => surveyNoTxt(r) },
    { l: 'Location', v: r => esc(unitPath(r.unitId)), x: r => unitPath(r.unitId) },
    { l: 'Total area', v: r => areaTxt(r.totalArea, r.province), x: r => r.totalArea, num: 1 },
    { l: 'Occupied', v: r => areaTxt(occupiedArea(r.id), r.province), x: r => occupiedArea(r.id), num: 1 },
    { l: 'Owner shares', v: r => { const t = ownerShareTotal(r.id); return `<span class="b b-${Math.abs(t - 100) < .5 ? 'g' : 'w'}">${fmt(t, 1)}%</span>`; }, x: r => ownerShareTotal(r.id) },
    { l: 'Class', v: r => esc(r.landClass) }, { l: 'Status', v: r => stageBadge(r.status), x: r => r.status }
  ]
},
/* ---------- Landowner master (SoR Sc 3–7, Proto 5) ---------- */
landowners: {
  title: 'Landowner', icon: '👤', sub: 'Unique landowner ID per CNIC (no duplicates) — one master used across provinces, projects, cases and payments',
  code: r => nextCode(r.province + '-', 6),
  formNote: 'CNIC is the unique key: the system blocks a second landowner with the same CNIC. Unique ID (e.g. SND-000012) is generated on save.',
  fields: [
    { k: 'name', l: 'Full name', t: 'text', req: true }, { k: 'father', l: "Father's / Husband's name", t: 'text', req: true },
    { k: 'cnic', l: 'CNIC', t: 'text', req: true, ph: '45102-1234567-1' }, { k: 'phone', l: 'Mobile', t: 'text', ph: '+92 300 1234567' },
    { k: 'ownerType', l: 'Owner status', t: 'select', req: true, opt: [['O', 'O — Owner'], ['B', 'B — Both (Owner & Attorney)'], ['A', 'A — Attorney']] },
    { k: 'status', l: 'Record status', t: 'select', req: true, opt: ['Active', 'Deceased', 'Inactive'] },
    { k: 'filer', l: 'Tax status', t: 'select', opt: ['Filer', 'Non-Filer'] },
    { k: 'bank', l: 'Bank / Branch', t: 'text' }, { k: 'iban', l: 'IBAN', t: 'text', ph: 'PK00XXXX0000000000000000' },
    { k: 'address', l: 'Address', t: 'textarea' },
    { k: 'shares', l: 'Land holdings (share per Survey / Khasra as per revenue record, e.g. Form VII-B)', t: 'sub', cols: [
      { k: 'surveyId', l: 'Survey / Khasra', t: 'ref', coll: 'surveys', allProv: true }, { k: 'share', l: 'Share %', t: 'number' }, { k: 'ref', l: 'Revenue document ref.', t: 'text' }] }
  ],
  defaults: () => ({ ownerType: 'O', status: 'Active', filer: 'Filer' }),
  prepare: r => { r.cnic = (r.cnic || '').replace(/\s/g, ''); if (/^\d{13}$/.test(r.cnic)) r.cnic = r.cnic.slice(0, 5) + '-' + r.cnic.slice(5, 12) + '-' + r.cnic.slice(12); },
  validate: (r, id) => {
    if (!/^\d{5}-\d{7}-\d$/.test(r.cnic)) return 'CNIC must be in the format 00000-0000000-0 (13 digits).';
    const d = S.landowners.find(l => l.id !== id && l.cnic === r.cnic); if (d) return `Duplicate CNIC: already registered as ${d.code} — ${d.name}. Use the existing unique ID.`;
    for (const s of r.shares || []) { if (!s.surveyId) return 'Each holding row needs a survey.'; if (num(s.share) <= 0 || num(s.share) > 100) return 'Share % must be between 0 and 100.'; const others = sum(S.landowners.filter(l => l.id !== id), l => sum((l.shares || []).filter(x => x.surveyId === s.surveyId), 'share')); if (others + num(s.share) > 100.01) return `Shares for ${codeOf('surveys', s.surveyId)} would exceed 100% (others hold ${fmt(others, 2)}%).`; }
    return null;
  },
  usage: r => { const n = S.cases.filter(c => (c.owners || []).some(o => o.landownerId === r.id)).length + S.payments.filter(p => p.landownerId === r.id).length; return n ? n + ' case(s)/payment(s)' : ''; },
  cols: [
    { l: 'Unique ID', v: r => `<span class="code">${esc(r.code)}</span>`, x: r => r.code },
    { l: 'Name / Father', v: r => `<b>${esc(r.name)}</b><br><small class="note">s/o ${esc(r.father)}</small>`, x: r => r.name + ' s/o ' + r.father },
    { l: 'CNIC', v: r => `<span class="mono">${esc(r.cnic)}</span>`, x: r => r.cnic },
    { l: 'Location / Projects', v: r => esc(uniq((r.shares || []).map(s => unitName(byId('surveys', s.surveyId)?.unitId))).join(', ') || '-'), x: r => uniq((r.shares || []).map(s => unitName(byId('surveys', s.surveyId)?.unitId))).join(', ') },
    { l: 'Surveys', v: r => (r.shares || []).length, num: 1 },
    { l: 'Active leases', v: r => activeLeaseCount(r.id), num: 1 },
    { l: 'Paid to date (Rs)', v: r => fmt(paidTo(r.id)), x: r => paidTo(r.id), num: 1 },
    { l: 'Type', v: r => `<span class="pill">${esc(r.ownerType)}</span>`, x: r => r.ownerType },
    { l: 'Status', v: r => stageBadge(r.status), x: r => r.status }
  ]
},
/* ---------- Land acquisition & title (SoW §3.2) ---------- */
acquisitions: {
  title: 'Acquisition / Lease Process', icon: '📋', sub: 'Identification → Negotiation → Approval → Acquisition / Lease → Handover, with title-completeness validation',
  code: r => nextCode('ACQ-' + new Date().getFullYear() + '-', 4),
  fields: [
    { k: 'projectId', l: 'Project / location', t: 'ref', coll: 'projects', req: true },
    { k: 'type', l: 'Acquisition mode', t: 'select', req: true, opt: ['Private Lease', 'Direct Purchase', 'Government Land (Lease / Allotment)', 'LAA 1894 Acquisition', 'ROW / Easement'] },
    { k: 'surveyIds', l: 'Survey / Khasra numbers', t: 'multiref', coll: 'surveys', req: true },
    { k: 'area', l: 'Area required', t: 'area', req: true },
    { k: 'negRate', l: 'Negotiated rate (Rs / acre / year or lump-sum)', t: 'number' },
    { k: 'targetDate', l: 'Target handover date', t: 'date' },
    { k: 'negotiator', l: 'Negotiation group lead', t: 'select', opt: userOpts },
    { k: 'titleChecks', l: 'Title completeness checklist', t: 'checks', opt: TITLE_CHECKS },
    { k: 'remarks', l: 'Remarks', t: 'textarea' }
  ],
  guard: (r, to) => {
    if (WF.acquisitions.stages.indexOf(to) >= 3) { const miss = TITLE_CHECKS.filter(x => !(r.titleChecks || []).includes(x)); if (miss.length) return 'Title validation incomplete: ' + miss.join('; '); const iss = titleIssues(r.surveyIds); if (iss.length) return 'Title issues: ' + iss.join(' | '); }
    return null;
  },
  onStage: (r, to) => { if (to === 'Handover') (r.surveyIds || []).forEach(id => { const s = byId('surveys', id); if (s) s.status = r.type.includes('Purchase') || r.type.includes('LAA') ? 'Acquired' : 'Leased'; }); else if (to === 'Negotiation') (r.surveyIds || []).forEach(id => { const s = byId('surveys', id); if (s && s.status === 'Proposed') s.status = 'Under Acquisition'; }); },
  cols: [
    { l: 'Ref', v: r => `<span class="code">${esc(r.code)}</span>`, x: r => r.code },
    { l: 'Project', v: r => esc(lbl('projects', r.projectId)), x: r => lbl('projects', r.projectId) },
    { l: 'Mode', v: r => esc(r.type) },
    { l: 'Surveys', v: r => esc((r.surveyIds || []).map(id => codeOf('surveys', id)).join(', ')), x: r => (r.surveyIds || []).map(id => codeOf('surveys', id)).join(', ') },
    { l: 'Area', v: r => areaTxt(r.area, r.province), x: r => r.area, num: 1 },
    { l: 'Title check', v: r => { const n = (r.titleChecks || []).length, iss = titleIssues(r.surveyIds).length; return `<span class="b b-${n === TITLE_CHECKS.length && !iss ? 'g' : 'w'}">${n}/${TITLE_CHECKS.length}${iss ? ' · ' + iss + ' issue(s)' : ''}</span>`; }, x: r => (r.titleChecks || []).length + '/' + TITLE_CHECKS.length },
    { l: 'Target', v: r => fdt(r.targetDate), x: r => r.targetDate },
    { l: 'Stage', v: r => stageBadge(r.stage), x: r => r.stage }
  ]
},
/* ---------- Compensation case (SoR Sc 12–19, Proto 8) ---------- */
cases: {
  title: 'Compensation Case', icon: '⚖️', sub: 'Case No., Lease No. and Block Code auto-generated · Prepared → Checked → Reviewed → Verified → Field approval → HO approval · locked after approval (cancel only)',
  code: r => nextCode('CC-' + new Date().getFullYear() + '-', 4),
  formNote: 'Case No., Lease No., Case Date and Block Code are generated automatically. Once submitted, the case cannot be edited — only cancelled (number retained as Cancelled).',
  fields: [
    { k: 'projectId', l: 'Well location / project', t: 'ref', coll: 'projects', req: true, filter: p => p.status === 'Active' },
    { k: 'landUsage', l: 'Land used for', t: 'select', req: true, opt: LAND_USE },
    { k: 'businessUnit', l: 'Business unit / concession', t: 'text', ph: 'Auto from project block if blank' },
    { k: 'caseRemarks', l: 'Case remarks', t: 'text' },
    { k: 's1', t: 'sec', l: 'Landowners (linked by unique ID)' },
    { k: 'owners', l: 'Landowners in this case', t: 'sub', req: true, cols: [
      { k: 'landownerId', l: 'Landowner (unique ID)', t: 'ref', coll: 'landowners', lab: r => r.code + ' — ' + r.name + ' (' + r.cnic + ')' },
      { k: 'status', l: 'Status', t: 'select', opt: [['O', 'O — Owner'], ['B', 'B — Both'], ['A', 'A — Attorney']] },
      { k: 'share', l: 'Share of case %', t: 'number' }] },
    { k: 's2', t: 'sec', l: 'Lease details (areas in acres — Acre-Ghunta shown)' },
    { k: 'leaseLines', l: 'Lease lines per survey', t: 'sub', cols: [
      { k: 'surveyId', l: 'Survey / Block / Khasra', t: 'ref', coll: 'surveys' },
      { k: 'share', l: 'Survey share %', t: 'number' },
      { k: 'leaseArea', l: 'Lease area (ac)', t: 'number' },
      { k: 'subsequentArea', l: 'Subsequent tora (ac)', t: 'number' },
      { k: 'ag', l: 'Lease A-G', t: 'calc' }], rowCalc: o => ({ ag: o.leaseArea ? ag(o.leaseArea) : '-' }) },
    { k: 'leaseRate', l: 'Lease rate (Rs / acre / year)', t: 'number' },
    { k: 'leaseTerm', l: 'Lease term (months)', t: 'number' },
    { k: 'effectiveDate', l: 'Effective date', t: 'date' },
    { k: 'leaseRemarks', l: 'Lease remarks', t: 'text' },
    { k: 's3', t: 'sec', l: 'Crop details' },
    { k: 'cropLines', l: 'Crop damage', t: 'sub', minRows: 0, cols: [
      { k: 'surveyId', l: 'Survey', t: 'ref', coll: 'surveys' }, { k: 'cropType', l: 'Crop type', t: 'text' },
      { k: 'rate', l: 'Rate / acre (Rs)', t: 'number' }, { k: 'damageArea', l: 'Damage area (ac)', t: 'number' }, { k: 'amt', l: 'Amount', t: 'calc' }],
      rowCalc: o => ({ amt: fmt(num(o.rate) * num(o.damageArea)) }) },
    { k: 'cropRemarks', l: 'Crop remarks', t: 'text', full: true },
    { k: 's4', t: 'sec', l: 'Tree details' },
    { k: 'treeLines', l: 'Trees', t: 'sub', minRows: 0, cols: [
      { k: 'surveyId', l: 'Survey', t: 'ref', coll: 'surveys' }, { k: 'tree', l: 'Tree', t: 'select', opt: TREES },
      { k: 'size', l: 'Size', t: 'select', opt: ['Small', 'Medium', 'Large'] }, { k: 'rate', l: 'Rate (Rs)', t: 'number' }, { k: 'qty', l: 'Qty', t: 'number' }, { k: 'amt', l: 'Amount', t: 'calc' }],
      rowCalc: o => ({ amt: fmt(num(o.rate) * num(o.qty)) }) },
    { k: 'treeRemarks', l: 'Tree remarks', t: 'text', full: true },
    { k: 's5', t: 'sec', l: 'Miscellaneous details' },
    { k: 'miscLines', l: 'Miscellaneous', t: 'sub', minRows: 0, cols: [
      { k: 'surveyId', l: 'Survey', t: 'ref', coll: 'surveys' }, { k: 'paymentType', l: 'Payment type', t: 'text' }, { k: 'amount', l: 'Amount (Rs)', t: 'number' }] },
    { k: 'miscRemarks', l: 'Misc remarks', t: 'text', full: true },
    { k: 's6', t: 'sec', l: 'Totals & documents' },
    { k: 'totals', l: 'Computed totals', t: 'calc', full: true },
    { k: 'docChecks', l: 'Supporting documents received', t: 'checks', opt: CASE_DOCS }
  ],
  defaults: () => ({ leaseTerm: 12, effectiveDate: today(), owners: [], leaseLines: [] }),
  compute: r => { const t = caseTotals(r); const shareT = sum(r.owners || [], 'share');
    return { totals: `<div class="totals"><div><small>Total lease area</small><b>${ag(t.leaseArea)}</b> <small>${fmt(t.leaseArea, 3)} ac</small></div><div><small>Lease amount</small><b>${rs(t.leaseAmt)}</b></div><div><small>Crop</small><b>${rs(t.crop)}</b></div><div><small>Trees</small><b>${rs(t.tree)}</b></div><div><small>Misc</small><b>${rs(t.misc)}</b></div><div><small>Total compensation</small><b class="u-accent">${rs(t.total)}</b></div></div>`,
      owners__tot: `Owner shares: <b class="${Math.abs(shareT - 100) < .5 || !(r.owners || []).length ? '' : 'is-bad'}">${fmt(shareT, 2)}%</b>`,
      leaseLines__tot: `Lease area: <b>${ag(t.leaseArea)}</b> · Amount: <b>${rs(t.leaseAmt)}</b>`, cropLines__tot: `Crop: <b>${rs(t.crop)}</b>`, treeLines__tot: `Trees: <b>${rs(t.tree)}</b>`, miscLines__tot: `Misc: <b>${rs(t.misc)}</b>` }; },
  prepare: r => { const p = byId('projects', r.projectId); r.blockCode = p?.block || ''; if (!r.businessUnit) r.businessUnit = p?.block || ''; if (!r.caseDate) r.caseDate = today(); r.owners = (r.owners || []).filter(o => o.landownerId); r.owners.forEach(o => { if (!o.status) o.status = byId('landowners', o.landownerId)?.ownerType || 'O'; }); Object.assign(r, { totalAmount: caseTotals(r).total }); },
  validate: (r, id) => {
    if (!r.owners.length) return 'Add at least one landowner to the case.';
    if (new Set(r.owners.map(o => o.landownerId)).size !== r.owners.length) return 'The same landowner is listed twice.';
    if (Math.abs(sum(r.owners, 'share') - 100) > 0.5) return 'Landowner shares in the case must total 100%.';
    const t = caseTotals(r); if (t.total <= 0) return 'Case has no compensation amount — add lease, crop, tree or misc lines.';
    for (const l of r.leaseLines || []) { const s = byId('surveys', l.surveyId); if (!s) return 'Each lease line needs a survey.'; if (num(l.leaseArea) > num(s.totalArea) + 1e-6) return `Lease area on ${s.code} exceeds the survey's total area.`; }
    return null;
  },
  afterSave: (r, before) => { if (!before) r.leaseNo = nextCode('LN-', 5); },
  guard: (r, to) => { if (to === 'HO Approved' || to === 'Field Approved') { const miss = CASE_DOCS.filter(d => !(r.docChecks || []).includes(d) && !(d.startsWith('Power') && !(r.owners || []).some(o => o.status !== 'O'))); if (miss.length) return 'Missing documents: ' + miss.join('; ') + ' — tick them with “Documents received” on the case.'; } return null; },
  onStage: (r, to) => { if (to === 'HO Approved') { r.approvedAt = nowStr(); } },
  cols: [
    { l: 'Case No.', v: r => `<span class="code">${esc(r.code)}</span>`, x: r => r.code },
    { l: 'Case date', v: r => fdt(r.caseDate), x: r => r.caseDate },
    { l: 'Project', v: r => esc(lbl('projects', r.projectId)), x: r => lbl('projects', r.projectId) },
    { l: 'Land used for', v: r => esc(r.landUsage) },
    { l: 'Landowners', v: r => esc((r.owners || []).map(o => codeOf('landowners', o.landownerId)).join(', ')), x: r => (r.owners || []).map(o => codeOf('landowners', o.landownerId)).join(', ') },
    { l: 'Lease area (A-G)', v: r => ag(caseTotals(r).leaseArea), x: r => caseTotals(r).leaseArea },
    { l: 'Total (Rs)', v: r => fmt(caseTotals(r).total), x: r => caseTotals(r).total, num: 1 },
    { l: 'Stage', v: r => stageBadge(r.stage), x: r => r.stage }
  ]
},
/* ---------- Lease & agreements (SoW §3.4) ---------- */
leases: {
  title: 'Lease / Agreement', icon: '📅', sub: 'Lease register with renewal history, escalation, obligations, and automatic 180 / 90 / 60 / 30-day expiry alerts',
  code: r => nextCode('LSE-', 5),
  fields: [
    { k: 'projectId', l: 'Project / location', t: 'ref', coll: 'projects', req: true },
    { k: 'caseId', l: 'Source compensation case', t: 'ref', coll: 'cases' },
    { k: 'kind', l: 'Lease of', t: 'select', req: true, opt: ['Private Land', 'Government Land', 'ROW / Easement'] },
    { k: 'registrationNo', l: 'Agreement / registration no.', t: 'text' },
    { k: 'landownerIds', l: 'Lessor(s) — landowners', t: 'multiref', coll: 'landowners', req: true },
    { k: 'surveyIds', l: 'Survey / Khasra numbers', t: 'multiref', coll: 'surveys', req: true },
    { k: 'initialArea', l: 'Initial net lease area', t: 'area', req: true },
    { k: 'subsequentArea', l: 'Subsequent net lease area (after reduction)', t: 'area' },
    { k: 'startDate', l: 'Lease start date', t: 'date', req: true },
    { k: 'termYears', l: 'Term (years)', t: 'number', req: true },
    { k: 'ratePerAcre', l: 'Rent (Rs / acre / year)', t: 'number', req: true },
    { k: 'escalation', l: 'Escalation % per renewal', t: 'number' },
    { k: 'autoExtend', l: 'Auto-extension clause', t: 'select', opt: ['Yes — extends unless terminated by lessee', 'No'] },
    { k: 'calc', l: 'Computed', t: 'calc', full: true },
    { k: 'renewalClause', l: 'Renewal clause', t: 'textarea' },
    { k: 'obligations', l: 'Obligations / dispute & legal terms', t: 'textarea' }
  ],
  defaults: () => ({ kind: 'Private Land', termYears: 5, escalation: 10, startDate: today(), autoExtend: 'Yes — extends unless terminated by lessee' }),
  compute: r => { const i = leaseInfo(r); return { calc: `<div class="totals"><div><small>Expiry date</small><b>${fdt(i.end)}</b></div><div><small>Days to expiry</small><b>${i.days ?? '-'}</b></div><div><small>Annual rent</small><b>${rs(i.rent)}</b></div><div><small>Status</small><b>${esc(i.status)}</b></div></div>` }; },
  usage: r => { const n = S.payments.filter(p => p.leaseId === r.id).length; return n ? n + ' payment(s)' : ''; },
  cols: [
    { l: 'Lease No.', v: r => `<span class="code">${esc(r.code)}</span>`, x: r => r.code },
    { l: 'Project', v: r => esc(projCode(r.projectId)), x: r => projCode(r.projectId) },
    { l: 'Lessor(s)', v: r => esc((r.landownerIds || []).map(id => byId('landowners', id)?.name).filter(Boolean).join(', ')), x: r => (r.landownerIds || []).map(id => byId('landowners', id)?.name).join(', ') },
    { l: 'Kind', v: r => esc(r.kind) },
    { l: 'Initial / subsequent', v: r => `${ag(r.initialArea)} / ${ag(r.subsequentArea ?? r.initialArea)}`, x: r => r.initialArea + ' / ' + (r.subsequentArea ?? r.initialArea) },
    { l: 'Expiry', v: r => fdt(leaseInfo(r).end), x: r => leaseInfo(r).end },
    { l: 'Days left', v: r => expiryBadge(leaseInfo(r).days, leaseInfo(r).status), x: r => leaseInfo(r).days },
    { l: 'Rent / yr (Rs)', v: r => fmt(leaseInfo(r).rent), x: r => leaseInfo(r).rent, num: 1 },
    { l: 'Renewals', v: r => (r.renewals || []).length, num: 1 },
    { l: 'Approval', v: r => stageBadge(r.stage), x: r => r.stage }
  ]
},
/* ---------- ROW (SoW §3.3) ---------- */
rows: {
  title: 'ROW / Pipeline Corridor', icon: '🛤️', sub: 'Right-of-way segments: width × length area, tenure, yearly renewal alerts, stop-lease, violations',
  code: r => nextCode('ROW-', 4),
  fields: [
    { k: 'projectId', l: 'Pipeline / access road project', t: 'ref', coll: 'projects', req: true },
    { k: 'name', l: 'Segment name', t: 'text', req: true, ph: 'e.g. KP 0+000 to KP 4+500' },
    { k: 'rowType', l: 'Type', t: 'select', req: true, opt: ['Pipeline ROW', 'Flowline ROW', 'Access Road', 'Junction / Valve Station', 'Power Line'] },
    { k: 'fromPoint', l: 'From (chainage / point)', t: 'text' }, { k: 'toPoint', l: 'To (chainage / point)', t: 'text' },
    { k: 'lengthM', l: 'Length (m)', t: 'number', req: true }, { k: 'widthM', l: 'Width (m) — as per pipeline spec', t: 'number', req: true },
    { k: 'surveyIds', l: 'Survey / Khasra crossed', t: 'multiref', coll: 'surveys' },
    { k: 'landownerIds', l: 'Landowners', t: 'multiref', coll: 'landowners' },
    { k: 'agreementDate', l: 'Agreement date', t: 'date', req: true }, { k: 'tenureYears', l: 'Tenure (years)', t: 'number', req: true },
    { k: 'annualRent', l: 'Annual ROW rent (Rs)', t: 'number' },
    { k: 'calc', l: 'Computed', t: 'calc', full: true },
    { k: 'path', l: 'Route coordinates (lat,lng; lat,lng …) for map', t: 'textarea', ph: '28.03,69.62; 28.05,69.66' },
    { k: 'obligations', l: 'Obligations', t: 'textarea' }
  ],
  compute: r => { const i = rowInfo(r); return { calc: `<div class="totals"><div><small>ROW area</small><b>${fmt(i.area, 3)} ac</b> <small>${ag(i.area)} A-G</small></div><div><small>Next yearly renewal</small><b>${fdt(i.next)}</b></div><div><small>Tenure ends</small><b>${fdt(i.end)}</b></div></div>` }; },
  cols: [
    { l: 'ROW ID', v: r => `<span class="code">${esc(r.code)}</span>`, x: r => r.code },
    { l: 'Project', v: r => esc(projCode(r.projectId)), x: r => projCode(r.projectId) },
    { l: 'Segment', v: r => `<b>${esc(r.name)}</b><br><small class="note">${esc(r.rowType)}</small>`, x: r => r.name },
    { l: 'L × W (m)', v: r => fmt(r.lengthM) + ' × ' + fmt(r.widthM), x: r => r.lengthM + 'x' + r.widthM },
    { l: 'Area (ac)', v: r => fmt(rowInfo(r).area, 3), x: r => rowInfo(r).area, num: 1 },
    { l: 'Next renewal', v: r => { const i = rowInfo(r); return r.stage === 'Stopped' ? stageBadge('Stopped') : fdt(i.next) + ' ' + (i.nextDays <= 60 ? `<span class="b b-w">${i.nextDays}d</span>` : ''); }, x: r => rowInfo(r).next },
    { l: 'Violations', v: r => { const n = S.encroachments.filter(e => e.rowId === r.id && e.stage !== 'Resolved').length; return n ? `<span class="b b-d">${n} open</span>` : '0'; }, x: r => S.encroachments.filter(e => e.rowId === r.id).length },
    { l: 'Stage', v: r => stageBadge(r.stage), x: r => r.stage }
  ]
},
/* ---------- Payments (SoW §3.5) ---------- */
payments: {
  title: 'Payment', icon: '💰', sub: 'Request → Verification → Release (cheque generated) · linked to landowner ID, case, lease, survey · duplicate-payment block · budget check',
  code: r => nextCode('VCH-' + new Date().getFullYear() + '-', 5),
  formNote: 'Net = Gross − WHT is calculated automatically. The system blocks a second payment for the same payee, category and period.',
  fields: [
    { k: 'landownerId', l: 'Payee — landowner (unique ID)', t: 'ref', coll: 'landowners', lab: r => r.code + ' — ' + r.name },
    { k: 'payee', l: 'Or payee (government / other)', t: 'text', ph: 'e.g. Government of Sindh — Board of Revenue' },
    { k: 'projectId', l: 'Project', t: 'ref', coll: 'projects', req: true },
    { k: 'caseId', l: 'Compensation case', t: 'ref', coll: 'cases', filter: c => c.stage === 'HO Approved' },
    { k: 'leaseId', l: 'Lease', t: 'ref', coll: 'leases' },
    { k: 'category', l: 'Category', t: 'select', req: true, opt: PAY_CATS },
    { k: 'payType', l: 'Payment type', t: 'select', req: true, opt: ['One-time', 'Yearly Lease', 'Advance Lease (multi-year)'] },
    { k: 'landClass', l: 'Land', t: 'select', opt: ['Private', 'Government'] },
    { k: 'periodFrom', l: 'Period from', t: 'date', req: true }, { k: 'periodTo', l: 'Period to', t: 'date' },
    { k: 'gross', l: 'Gross amount (Rs)', t: 'number', req: true }, { k: 'whtPct', l: 'WHT %', t: 'number' },
    { k: 'calc', l: 'Net payable', t: 'calc', full: true },
    { k: 'mode', l: 'Mode', t: 'select', req: true, opt: ['Cross Cheque', 'Pay Order', 'Direct Credit (IBFT)'] },
    { k: 'remarks', l: 'Remarks', t: 'textarea' }
  ],
  defaults: () => ({ payType: 'One-time', mode: 'Cross Cheque', whtPct: S.settings.wht, periodFrom: today(), landClass: 'Private' }),
  compute: r => { const w = Math.round(num(r.gross) * num(r.whtPct) / 100); return { calc: `<div class="totals"><div><small>Gross</small><b>${rs(r.gross)}</b></div><div><small>WHT</small><b>${rs(w)}</b></div><div><small>Net payable</small><b class="u-accent">${rs(num(r.gross) - w)}</b></div><div><small>In words</small><b class="u-fs-115">${esc(words(num(r.gross) - w))} Only</b></div></div>` }; },
  prepare: r => { r.wht = Math.round(num(r.gross) * num(r.whtPct) / 100); r.net = num(r.gross) - r.wht; if (r.landownerId && !r.payee) r.payee = ''; },
  validate: (r, id) => {
    if (!r.landownerId && !r.payee) return 'Select a landowner or enter a payee.';
    if (num(r.gross) <= 0) return 'Gross amount must be greater than zero.';
    const dup = S.payments.find(p => p.id !== id && !TERMINAL.includes(p.stage) && (p.landownerId || p.payee) === (r.landownerId || r.payee) && p.category === r.category && p.periodFrom === r.periodFrom && (p.caseId || '') === (r.caseId || '') && (p.leaseId || '') === (r.leaseId || ''));
    if (dup) return `Duplicate payment blocked: ${dup.code} already exists for this payee, category and period (${fdt(r.periodFrom)}).`;
    const st = stayFor(r); if (st) return `Payment blocked by court stay order: ${st.code} (${st.caseNo}, ${st.court}). Lift / decide the case in Legal & Litigation first.`;
    return null;
  },
  guard: (r, to) => { const st = stayFor(r); if (st) return `Court stay order ${st.code} (${st.caseNo}) applies to this payee / land — payment cannot proceed.`; if (to === 'Verified') { const b = budgetFor(r.projectId, new Date(r.periodFrom || today()).getFullYear()); if (b && b.balance < 0) return `Budget check failed: releasing ${rs(r.net)} would exceed the approved budget of ${projCode(r.projectId)} for ${b.year} (shortfall ${rs(-b.balance)}). Increase the budget first.`; } return null; },
  onStage: (r, to) => { if (to === 'Released') { S.meta.seq.cheque = (S.meta.seq.cheque || 25186400) + 1; r.chequeNo = 'SIM-' + S.meta.seq.cheque; r.chequeDate = today(); r.releasedAt = nowStr(); r.sapDoc = 'SIM-5100' + String(Math.floor(1e6 + Math.random() * 8e6)); } },
  cols: [
    { l: 'Voucher', v: r => `<span class="code">${esc(r.code)}</span>`, x: r => r.code },
    { l: 'Payee', v: r => r.landownerId ? `${esc(byId('landowners', r.landownerId)?.name || '-')}<br><small class="note">${esc(codeOf('landowners', r.landownerId))}</small>` : esc(r.payee), x: r => r.landownerId ? lbl('landowners', r.landownerId) : r.payee },
    { l: 'Project', v: r => esc(projCode(r.projectId)), x: r => projCode(r.projectId) },
    { l: 'Category / type', v: r => `${esc(r.category)}<br><small class="note">${esc(r.payType)}</small>`, x: r => r.category + ' / ' + r.payType },
    { l: 'Period', v: r => fdt(r.periodFrom) + (r.periodTo ? ' – ' + fdt(r.periodTo) : ''), x: r => r.periodFrom + ' – ' + (r.periodTo || '') },
    { l: 'Gross', v: r => fmt(r.gross), x: r => r.gross, num: 1 }, { l: 'WHT', v: r => fmt(r.wht), x: r => r.wht, num: 1 }, { l: 'Net', v: r => `<b>${fmt(r.net)}</b>`, x: r => r.net, num: 1 },
    { l: 'Cheque', v: r => r.chequeNo ? `<span class="mono">${esc(r.chequeNo)}</span><br><small class="note">${fdt(r.chequeDate)}</small>` : '-', x: r => r.chequeNo || '' },
    { l: 'Stage', v: r => stageBadge(r.stage), x: r => r.stage }
  ]
},
/* ---------- DBPFC (SoW §3.5 Sindh government land) ---------- */
dbpfc: {
  title: 'DBPFC Govt Land Estimate', icon: '🏢', sub: 'Sindh government land: estimated yearly lease pending District Base Price Fixation Committee — edit rates, generate cheque request or stop payment',
  code: r => nextCode('DBP-', 4),
  formNote: 'For Sindh government land the final rate is fixed by the District Base Price Fixation Committee (DBPFC). Enter the estimated rate now; update it when the committee notifies the rate — every change is kept in rate history.',
  fields: [
    { k: 'projectId', l: 'Project', t: 'ref', coll: 'projects', req: true },
    { k: 'surveyIds', l: 'Government survey numbers', t: 'multiref', coll: 'surveys', filter: s => s.landClass === 'Government', req: true },
    { k: 'districtId', l: 'District', t: 'loc', depth: 0, req: true },
    { k: 'area', l: 'Area', t: 'area', req: true },
    { k: 'estRate', l: 'Estimated rate (Rs / acre / year)', t: 'number', req: true },
    { k: 'fixedRate', l: 'DBPFC fixed rate (Rs / acre / year)', t: 'number', help: 'Leave blank until the committee notifies the rate' },
    { k: 'committeeRef', l: 'Committee reference / letter no.', t: 'text' }, { k: 'meetingDate', l: 'Committee meeting date', t: 'date' },
    { k: 'calc', l: 'Estimated annual liability', t: 'calc', full: true },
    { k: 'remarks', l: 'Remarks', t: 'textarea' }
  ],
  when: () => true,
  defaults: () => ({ province: 'SND' }),
  compute: r => { const rate = num(r.fixedRate) || num(r.estRate); return { calc: `<div class="totals"><div><small>Rate applied</small><b>${rs(rate)} / ac</b> <small>${r.fixedRate ? 'DBPFC fixed' : 'estimated'}</small></div><div><small>Annual amount</small><b>${rs(rate * num(r.area))}</b></div></div>` }; },
  prepare: r => { r.annual = (num(r.fixedRate) || num(r.estRate)) * num(r.area); },
  validate: r => r.province !== 'SND' ? 'DBPFC applies to Sindh government land only.' : null,
  afterSave: (r, before) => { r.rateHistory = r.rateHistory || []; if (!before || before.estRate !== r.estRate || before.fixedRate !== r.fixedRate) r.rateHistory.push({ at: nowStr(), user: ME.username, estRate: r.estRate, fixedRate: r.fixedRate || null }); },
  guard: (r, to) => to === 'Rate Fixed' && !num(r.fixedRate) ? 'Enter the DBPFC fixed rate (Edit) before marking Rate Fixed.' : null,
  cols: [
    { l: 'Ref', v: r => `<span class="code">${esc(r.code)}</span>`, x: r => r.code },
    { l: 'Project', v: r => esc(projCode(r.projectId)), x: r => projCode(r.projectId) },
    { l: 'District', v: r => esc(unitName(r.districtId)) },
    { l: 'Surveys', v: r => esc((r.surveyIds || []).map(id => codeOf('surveys', id)).join(', ')), x: r => (r.surveyIds || []).map(id => codeOf('surveys', id)).join(', ') },
    { l: 'Area', v: r => areaTxt(r.area, 'SND'), x: r => r.area },
    { l: 'Est. rate', v: r => fmt(r.estRate), num: 1, x: r => r.estRate }, { l: 'Fixed rate', v: r => r.fixedRate ? fmt(r.fixedRate) : '<span class="note">pending</span>', num: 1, x: r => r.fixedRate || '' },
    { l: 'Annual (Rs)', v: r => `<b>${fmt(r.annual)}</b>`, num: 1, x: r => r.annual },
    { l: 'Paid (Rs)', v: r => fmt(sum(S.payments.filter(p => p.dbpfcId === r.id && p.stage === 'Released'), 'net')), num: 1 },
    { l: 'Stage', v: r => stageBadge(r.stage), x: r => r.stage }
  ]
},
/* ---------- Budgets (SoR p.13–14) ---------- */
budgets: {
  title: 'Budget', icon: '📊', sub: 'Approved budget vs committed (approved cases not yet paid) vs spent (released payments) vs balance — per project per year',
  code: r => nextCode('BGT-', 4),
  fields: [
    { k: 'projectId', l: 'Project', t: 'ref', coll: 'projects', req: true },
    { k: 'year', l: 'Financial year (calendar)', t: 'number', req: true },
    { k: 'approved', l: 'Approved budget (Rs)', t: 'number', req: true },
    { k: 'remarks', l: 'Remarks / approval reference', t: 'textarea' }
  ],
  defaults: () => ({ year: new Date().getFullYear() }),
  validate: (r, id) => S.budgets.some(b => b.id !== id && b.projectId === r.projectId && +b.year === +r.year) ? 'A budget already exists for this project and year — edit it instead.' : null,
  cols: [
    { l: 'Ref', v: r => `<span class="code">${esc(r.code)}</span>`, x: r => r.code },
    { l: 'Project', v: r => esc(lbl('projects', r.projectId)), x: r => lbl('projects', r.projectId) }, { l: 'Year', v: r => r.year },
    { l: 'Approved (Rs)', v: r => fmt(r.approved), num: 1, x: r => r.approved },
    { l: 'Committed (Rs)', v: r => fmt(budgetFor(r.projectId, r.year).committed), num: 1, x: r => budgetFor(r.projectId, r.year).committed },
    { l: 'Spent (Rs)', v: r => fmt(budgetFor(r.projectId, r.year).spent), num: 1, x: r => budgetFor(r.projectId, r.year).spent },
    { l: 'Balance (Rs)', v: r => { const b = budgetFor(r.projectId, r.year); return `<b class="${b.balance < 0 ? 'is-bad' : ''}">${fmt(b.balance)}</b>`; }, num: 1, x: r => budgetFor(r.projectId, r.year).balance },
    { l: 'Utilised', v: r => { const b = budgetFor(r.projectId, r.year); const p = b.approved ? (b.spent + b.committed) / b.approved * 100 : 0; return `<span class="b b-${p > 100 ? 'd' : p > 85 ? 'w' : 'g'}">${fmt(p, 1)}%</span>`; }, x: r => { const b = budgetFor(r.projectId, r.year); return b.approved ? ((b.spent + b.committed) / b.approved * 100).toFixed(1) : 0; } }
  ]
},
/* ---------- Grievance & IIR (SoW §3.6) ---------- */
grievances: {
  title: 'Grievance / IIR', icon: '📢', sub: 'Landowner & community complaints and land-related IIRs — assignment, escalation, resolution workflow with full audit trail',
  code: r => nextCode('GRV-' + new Date().getFullYear() + '-', 4),
  fields: [
    { k: 'type', l: 'Type', t: 'select', req: true, opt: ['Landowner Complaint', 'Community Complaint', 'IIR — Land Matter'] },
    { k: 'landownerId', l: 'Landowner (if registered — unique ID)', t: 'ref', coll: 'landowners', lab: r => r.code + ' — ' + r.name + ' (' + r.cnic + ')' },
    { k: 'complainant', l: 'Complainant / reporting person', t: 'text', req: true }, { k: 'cnic', l: 'Complainant CNIC', t: 'text' }, { k: 'mobile', l: 'Mobile', t: 'text' },
    { k: 'projectId', l: 'Project', t: 'ref', coll: 'projects' }, { k: 'surveyId', l: 'Survey / Khasra', t: 'ref', coll: 'surveys' },
    { k: 'category', l: 'Category', t: 'select', req: true, opt: GRV_CATS },
    { k: 'severity', l: 'Severity', t: 'select', req: true, opt: ['Low', 'Medium', 'High', 'Critical'] },
    { k: 'channel', l: 'Received via', t: 'select', opt: ['Written application', 'Walk-in', 'Phone / helpline', 'Community meeting', 'DC / Revenue office', 'Field staff (IIR)'] },
    { k: 'receivedDate', l: 'Received date', t: 'date', req: true },
    { k: 'assignedTo', l: 'Assigned to', t: 'select', opt: userOpts }, { k: 'dueDate', l: 'Target resolution date', t: 'date' },
    { k: 'description', l: 'Description', t: 'textarea', req: true }, { k: 'resolution', l: 'Action taken / resolution', t: 'textarea' }
  ],
  defaults: () => ({ type: 'Landowner Complaint', severity: 'Medium', receivedDate: today(), dueDate: dOff(15), channel: 'Written application' }),
  prepare: r => { if (r.landownerId && !r.complainant) { const lo = byId('landowners', r.landownerId); r.complainant = lo?.name; r.cnic = lo?.cnic; } },
  onStage: (r, to) => { if (to === 'Resolved') r.resolvedAt = today(); },
  guard: (r, to) => to === 'Resolved' && !r.resolution ? 'Enter "Action taken / resolution" (Edit) before resolving.' : (to === 'Assigned' && !r.assignedTo ? 'Assign an officer (Edit) before moving to Assigned.' : null),
  cols: [
    { l: 'Ticket', v: r => `<span class="code">${esc(r.code)}</span>`, x: r => r.code },
    { l: 'Type', v: r => esc(r.type) },
    { l: 'Complainant', v: r => `${esc(r.complainant)}${r.landownerId ? `<br><small class="note">${esc(codeOf('landowners', r.landownerId))}</small>` : ''}`, x: r => r.complainant },
    { l: 'Project', v: r => esc(projCode(r.projectId)), x: r => projCode(r.projectId) },
    { l: 'Category', v: r => esc(r.category) }, { l: 'Severity', v: r => stageBadge(r.severity), x: r => r.severity },
    { l: 'Age', v: r => { const end = r.resolvedAt || today(); const d = Math.round((new Date(end) - new Date(r.receivedDate)) / 864e5); const over = !r.resolvedAt && r.dueDate && daysTo(r.dueDate) < 0; return `${d}d ${over ? '<span class="b b-d">overdue</span>' : ''}`; }, x: r => Math.round((new Date(r.resolvedAt || today()) - new Date(r.receivedDate)) / 864e5) },
    { l: 'Assigned', v: r => esc(uName(r.assignedTo)) },
    { l: 'Stage', v: r => stageBadge(r.stage) + (r.escalated ? ' <span class="b b-d">Escalated L' + r.escalationLevel + '</span>' : ''), x: r => r.stage + (r.escalated ? ' (Escalated)' : '') }
  ]
},
/* ---------- Encroachment (SoW §3.7) ---------- */
encroachments: {
  title: 'Encroachment / ROW Violation', icon: '⚠️', sub: 'GIS-located incidents on acquired / leased land, junctions and ROW · photo & document evidence · risk & impact · corrective-action and legal workflow',
  code: r => nextCode('ENC-' + new Date().getFullYear() + '-', 4),
  fields: [
    { k: 'category', l: 'Category', t: 'select', req: true, opt: ENC_CATS },
    { k: 'projectId', l: 'Project', t: 'ref', coll: 'projects', req: true },
    { k: 'surveyId', l: 'Survey / Khasra', t: 'ref', coll: 'surveys' }, { k: 'rowId', l: 'ROW segment', t: 'ref', coll: 'rows' },
    { k: 'lat', l: 'Latitude', t: 'number', req: true }, { k: 'lng', l: 'Longitude', t: 'number', req: true },
    { k: 'detectedOn', l: 'Detected on', t: 'date', req: true }, { k: 'reportedBy', l: 'Reported by', t: 'select', opt: userOpts },
    { k: 'encroacher', l: 'Encroacher (if known)', t: 'text' }, { k: 'areaAffected', l: 'Area affected', t: 'area' },
    { k: 'risk', l: 'Risk category', t: 'select', req: true, opt: ['Low', 'Medium', 'High', 'Critical'] },
    { k: 'description', l: 'Description', t: 'textarea', req: true }, { k: 'impact', l: 'Impact assessment', t: 'textarea' },
    { k: 'action', l: 'Corrective action / legal follow-up', t: 'textarea' }
  ],
  defaults: () => ({ detectedOn: today(), risk: 'Medium' }),
  formNote: 'Tip: pick the location on the GIS map ("Report encroachment here") to fill latitude/longitude automatically. Attach photographs after saving.',
  cols: [
    { l: 'Ref', v: r => `<span class="code">${esc(r.code)}</span>`, x: r => r.code },
    { l: 'Category', v: r => esc(r.category) }, { l: 'Project', v: r => esc(projCode(r.projectId)), x: r => projCode(r.projectId) },
    { l: 'Survey / ROW', v: r => esc([codeOf('surveys', r.surveyId), codeOf('rows', r.rowId)].filter(x => x !== '-').join(' · ') || '-') },
    { l: 'Detected', v: r => fdt(r.detectedOn), x: r => r.detectedOn }, { l: 'Risk', v: r => stageBadge(r.risk), x: r => r.risk },
    { l: 'Evidence', v: r => { const n = docsFor(r.id).filter(d => !d.deleted).length; return n ? `📎 ${n}` : '<span class="note">none</span>'; }, x: r => docsFor(r.id).filter(d => !d.deleted).length },
    { l: 'Stage', v: r => stageBadge(r.stage) + (r.escalated ? ' <span class="b b-d">Escalated</span>' : ''), x: r => r.stage }
  ]
},

/* ---------- Legal & litigation (SoW §3.4 disputes & legal obligations, §3.7 legal follow-up) ---------- */
legal: {
  title: 'Court Case', icon: '⚖️', sub: 'Land litigation register — LAA Section 18 / 30 references, title suits, writs, stay orders — linked to landowners, surveys and compensation cases. A stay order blocks payments automatically.',
  code: r => nextCode('LIT-', 4),
  fields: [
    { k: 'caseNo', l: 'Court case no.', t: 'text', req: true, ph: 'e.g. CS-234/2025' },
    { k: 'court', l: 'Court / forum', t: 'select', req: true, opt: ['Mukhtiarkar / Tehsildar', 'Assistant Commissioner', 'Deputy Commissioner', 'Board of Revenue', 'Senior Civil Judge', 'District & Sessions Court', 'High Court', 'Supreme Court', 'Ombudsman'] },
    { k: 'caseType', l: 'Case type', t: 'select', req: true, opt: ['LAA Section 18 — Enhancement', 'LAA Section 30 — Apportionment', 'Title / Ownership Suit', 'Writ Petition', 'Injunction / Stay', 'Rent / Lease Dispute', 'Trespass / Encroachment', 'Revenue Appeal / Mutation'] },
    { k: 'role', l: 'Company is', t: 'select', req: true, opt: ['Defendant / Respondent', 'Plaintiff / Petitioner', 'Proforma Party'] },
    { k: 'parties', l: 'Title / parties', t: 'text', req: true, full: true, ph: 'e.g. Heirs of Allah Dino vs Company & others' },
    { k: 'projectId', l: 'Project', t: 'ref', coll: 'projects' }, { k: 'caseId', l: 'Compensation case', t: 'ref', coll: 'cases' },
    { k: 'landownerIds', l: 'Landowners involved', t: 'multiref', coll: 'landowners' }, { k: 'surveyIds', l: 'Survey / khasra involved', t: 'multiref', coll: 'surveys' },
    { k: 'filingDate', l: 'Filing date', t: 'date', req: true }, { k: 'nextHearing', l: 'Next hearing', t: 'date' },
    { k: 'counsel', l: 'Counsel', t: 'text' }, { k: 'officer', l: 'In-house officer', t: 'select', opt: userOpts },
    { k: 'impact', l: 'Financial exposure (Rs)', t: 'number' },
    { k: 'stayOrder', l: 'Stay order in force?', t: 'select', req: true, opt: ['No', 'Yes'], help: 'Yes = all payments to these landowners / surveys are blocked' },
    { k: 'status', l: 'Status', t: 'select', req: true, opt: ['Pending', 'Under Hearing', 'Reserved for Judgment', 'Decided — In Favour', 'Decided — Against', 'In Appeal', 'Settled', 'Withdrawn'] },
    { k: 'hearings', l: 'Hearing log', t: 'sub', minRows: 0, cols: [{ k: 'date', l: 'Hearing date', t: 'date' }, { k: 'proceedings', l: 'Proceedings / order', t: 'text', w: 260 }, { k: 'nextDate', l: 'Next date', t: 'date' }] },
    { k: 'remarks', l: 'Remarks / strategy', t: 'textarea' }
  ],
  defaults: () => ({ filingDate: today(), stayOrder: 'No', status: 'Pending', role: 'Defendant / Respondent' }),
  prepare: r => { const nd = (r.hearings || []).map(h => h.nextDate).filter(Boolean).sort().at(-1); if (nd && (!r.nextHearing || nd > r.nextHearing)) r.nextHearing = nd; },
  cols: [
    { l: 'Ref', v: r => `<span class="code">${esc(r.code)}</span>`, x: r => r.code },
    { l: 'Case no. / court', v: r => `<b>${esc(r.caseNo)}</b><br><small class="note">${esc(r.court)}</small>`, x: r => r.caseNo + ' — ' + r.court },
    { l: 'Type', v: r => esc(r.caseType) }, { l: 'Parties', v: r => esc(r.parties) },
    { l: 'Linked', v: r => esc([...(r.landownerIds || []).map(i => codeOf('landowners', i)), ...(r.surveyIds || []).map(i => codeOf('surveys', i))].join(', ') || '-') },
    { l: 'Next hearing', v: r => r.nextHearing && legalOpen(r) ? fdt(r.nextHearing) + (daysTo(r.nextHearing) >= 0 && daysTo(r.nextHearing) <= 7 ? ` <span class="b b-w">${daysTo(r.nextHearing)}d</span>` : '') : '-', x: r => r.nextHearing || '' },
    { l: 'Stay', v: r => r.stayOrder === 'Yes' && legalOpen(r) ? '<span class="b b-d">STAY</span>' : '-', x: r => r.stayOrder },
    { l: 'Exposure (Rs)', v: r => fmt(r.impact), num: 1, x: r => r.impact },
    { l: 'Status', v: r => `<span class="b b-${legalOpen(r) ? 'w' : r.status.includes('Against') ? 'd' : 'g'}">${esc(r.status)}</span>`, x: r => r.status }
  ]
},
/* ---------- Mutation & succession (SoW §3.2 ownership records, mutations, ownership history) ---------- */
mutations: {
  title: 'Mutation / Succession', icon: '🔁', sub: 'Inheritance and sale mutations: deceased / transferring owner → legal heirs / buyers. On final approval the shares move automatically, leases and ROW lessors update, history is kept.',
  code: r => nextCode('MUT-', 4),
  formNote: 'Heir shares are % of the transferring owner\'s share and must total 100%. Register any heir not yet in the system as a landowner first (unique CNIC).',
  fields: [
    { k: 'type', l: 'Mutation type', t: 'select', req: true, opt: ['Inheritance (Virasat)', 'Sale / Transfer', 'Gift (Hiba)', 'Partition'] },
    { k: 'deceasedId', l: 'Transferring / deceased owner', t: 'ref', coll: 'landowners', req: true, rerender: true, lab: r => r.code + ' — ' + r.name + (r.status === 'Deceased' ? ' (deceased)' : '') },
    { k: 'deathDate', l: 'Date of death (inheritance)', t: 'date' },
    { k: 'surveyIds', l: 'Holdings to transfer', t: 'multiref', coll: 'surveys', req: true, allProv: true, filter: (s, rec) => !rec.deceasedId || (byId('landowners', rec.deceasedId)?.shares || []).some(x => x.surveyId === s.id) },
    { k: 'mutationNo', l: 'Revenue mutation no. (Intiqal)', t: 'text', ph: 'e.g. 1452' }, { k: 'mutationDate', l: 'Mutation date', t: 'date' },
    { k: 'revenueOffice', l: 'Revenue office', t: 'text', ph: 'e.g. Mukhtiarkar Daharki' }, { k: 'certificate', l: 'Succession certificate / FRC no.', t: 'text' },
    { k: 'heirs', l: 'Legal heirs / transferees', t: 'sub', req: true, cols: [{ k: 'landownerId', l: 'Heir (landowner ID)', t: 'ref', coll: 'landowners', lab: r => r.code + ' — ' + r.name + ' (' + r.cnic + ')' }, { k: 'relation', l: 'Relation', t: 'select', opt: ['Son', 'Daughter', 'Widow', 'Husband', 'Mother', 'Father', 'Brother', 'Sister', 'Buyer', 'Other'] }, { k: 'share', l: 'Share of transferor %', t: 'number' }] },
    { k: 'remarks', l: 'Remarks', t: 'textarea' }
  ],
  defaults: () => ({ type: 'Inheritance (Virasat)', heirs: [] }),
  compute: r => ({ heirs__tot: `Total: <b class="${Math.abs(sum(r.heirs || [], 'share') - 100) < .01 ? '' : 'is-bad'}">${fmt(sum(r.heirs || [], 'share'), 2)}%</b>` }),
  prepare: r => { r.heirs = (r.heirs || []).filter(h => h.landownerId); },
  validate: r => { if (!r.heirs.length) return 'Add at least one heir / transferee.'; if (Math.abs(sum(r.heirs, 'share') - 100) > .01) return 'Heir shares must total 100%.'; if (r.heirs.some(h => h.landownerId === r.deceasedId)) return 'The transferring owner cannot be an heir.'; return null; },
  guard: (r, to) => to === 'Revenue Verified' && !r.mutationNo ? 'Enter the revenue mutation (Intiqal) number before verification.' : (to === 'Legal Cleared' && r.type.startsWith('Inheritance') && !r.certificate ? 'Succession certificate / FRC number required for legal clearance.' : null),
  onStage: (r, to) => { if (to === 'Approved & Applied') applyMutation(r); },
  cols: [
    { l: 'Ref', v: r => `<span class="code">${esc(r.code)}</span>`, x: r => r.code }, { l: 'Type', v: r => esc(r.type) },
    { l: 'From', v: r => esc(lbl('landowners', r.deceasedId)), x: r => lbl('landowners', r.deceasedId) },
    { l: 'To (heirs)', v: r => esc((r.heirs || []).map(h => (byId('landowners', h.landownerId)?.name || '') + ' ' + fmt(h.share, 1) + '%').join(', ')) },
    { l: 'Surveys', v: r => esc((r.surveyIds || []).map(i => codeOf('surveys', i)).join(', ')) },
    { l: 'Mutation no.', v: r => esc(r.mutationNo || '-') }, { l: 'Stage', v: r => stageBadge(r.stage), x: r => r.stage }
  ]
},
/* ---------- Users (SoW §4.2) ---------- */
users: {
  title: 'User', icon: '🔐', provincial: false, sub: 'Role-based access control — Admin, Approver, User, Viewer — rights assigned to nominated positions and departments',
  code: r => nextCode('USR-', 3),
  fields: [
    { k: 'username', l: 'Username', t: 'text', req: true }, { k: 'fullName', l: 'Full name', t: 'text', req: true },
    { k: 'role', l: 'Role', t: 'select', req: true, opt: Object.keys(ROLES) },
    { k: 'department', l: 'Department', t: 'text' }, { k: 'position', l: 'Position / designation', t: 'text' },
    { k: 'groups', l: 'Approval groups (positions this user can act for in workflows)', t: 'checks', opt: GROUPS, req: true },
    { k: 'office', l: 'Office', t: 'select', opt: ['Head Office Islamabad', 'Daharki Field Office', 'Karachi Office', 'Quetta Office', 'Regional Office (other)'] },
    { k: 'provinces', l: 'Province access', t: 'checks', opt: Object.entries(PROV).map(([k, p]) => [k, p.name]) },
    { k: 'email', l: 'Email', t: 'text' }, { k: 'password', l: 'Password (demo)', t: 'text', req: true },
    { k: 'status', l: 'Status', t: 'select', req: true, opt: ['Active', 'Suspended'] }
  ],
  defaults: () => ({ role: 'User', status: 'Active', provinces: Object.keys(PROV), groups: ['Land Officer (Field)'] }),
  validate: (r, id) => S.users.some(u => u.id !== id && u.username.toLowerCase() === r.username.toLowerCase()) ? 'Username already exists.' : (id === ME.id && r.role !== 'Admin' ? 'You cannot remove your own Admin role.' : null),
  usage: r => r.id === ME.id ? 'your own session' : '',
  cols: [
    { l: 'Username', v: r => `<span class="mono">${esc(r.username)}</span>`, x: r => r.username },
    { l: 'Name', v: r => `<b>${esc(r.fullName)}</b>`, x: r => r.fullName }, { l: 'Role', v: r => `<span class="b b-${r.role === 'Admin' ? 'd' : r.role === 'Approver' ? 'p' : r.role === 'User' ? 'i' : 'n'}">${esc(r.role)}</span>`, x: r => r.role },
    { l: 'Department / position', v: r => esc((r.department || '') + ' · ' + (r.position || '')) }, { l: 'Approval groups', v: r => (r.groups || []).map(g => `<span class="pill">${esc(g)}</span>`).join(' '), x: r => (r.groups || []).join(', ') }, { l: 'Office', v: r => esc(r.office) },
    { l: 'Provinces', v: r => esc((r.provinces || Object.keys(PROV)).join(', ')) },
    { l: 'Last login', v: r => fdtt(r.lastLogin), x: r => r.lastLogin || '' }, { l: 'Status', v: r => stageBadge(r.status), x: r => r.status }
  ]
}
};
SPEC.dbpfc.fields.forEach(f => { if (f.k === 'districtId') f.when = r => r.province === 'SND'; });

function budgetFor(projectId, year) {
  const b = S.budgets.find(x => x.projectId === projectId && +x.year === +year); if (!b) return null;
  const inYear = p => new Date(p.periodFrom || p.createdAt).getFullYear() === +year;
  const spent = sum(S.payments.filter(p => p.projectId === projectId && p.stage === 'Released' && inYear(p)), 'net');
  const pending = sum(S.payments.filter(p => p.projectId === projectId && ['Requested', 'Verified'].includes(p.stage) && inYear(p)), 'net');
  const unpaidCases = sum(S.cases.filter(c => c.projectId === projectId && c.stage === 'HO Approved' && new Date(c.approvedAt || c.caseDate).getFullYear() === +year && !S.payments.some(p => p.caseId === c.id)), c => caseTotals(c).total);
  const committed = pending + unpaidCases;
  return { year: +year, approved: num(b.approved), spent, committed, balance: num(b.approved) - spent - committed };
}
