/* Derived calculations — case totals, lease info, areas, budgets
   Part of the LMS multi-page build. Loaded as a classic script;
   top-level declarations are shared across the bundle. */
/* =====================================================================
   MODULE SPECIFICATIONS — mapped to SoW §3.1–3.9 / SoR §8 and SoR UI screenshots
   ===================================================================== */
const PROJECT_TYPES = ['Well Location', 'Access Road', 'Pipeline Area', 'Camp Area', 'Compressor Area', 'Gathering Station', 'Processing Facility', 'Borrow Area (Green Area)', 'Extra Land', 'Seismic / Exploration'];
const LAND_STATUS = ['Proposed', 'Under Acquisition', 'Acquired', 'Leased', 'Disputed'];
const LAND_USE = ['Well Location', 'Access Road', 'Well, Access Road & Camp', 'Pipeline / ROW', 'Camp', 'Compressor Station', 'Borrow Area', 'Extra Land'];
const PAY_CATS = ['Case Compensation', 'Lease Rent', 'Crop Compensation', 'Tree Compensation', 'Misc / Structure', 'Lease Arrears', 'Govt Land Rent (DBPFC)', 'ROW Rent', 'LAA Award', 'Legal / Stamp Fees'];
const TREES = ['Babool', 'Bairi (Berry)', 'Neem', 'Shisham', 'Kikar', 'Khabar (Devi)', 'Shabar', 'Date Palm', 'Mango', 'Eucalyptus', 'Other'];
const CASE_DOCS = ['Original consent form (English & Sindhi / Urdu)', 'Measurement report', 'Copies of CNIC', 'Record of Rights (Form A / VII-B / Fard)', 'Power of Attorney (if attorney)', 'DC / Revenue report'];
const TITLE_CHECKS = ['Record of Rights / Fard obtained', 'Latest mutation verified', 'All owners CNIC verified', 'Ownership shares total 100%', 'No encumbrance / court stay', 'Legal advisor clearance'];
const GRV_CATS = ['Non-payment / Delay', 'Boundary / Measurement', 'Crop Damage', 'Tree / Structure Damage', 'Access Blocked', 'Environmental (dust, noise)', 'Water Course', 'Employment Demand', 'Title / Share Dispute', 'Other'];
const ENC_CATS = ['Encroachment on Acquired Land', 'Encroachment on Leased Land', 'ROW Violation / Conflict', 'Junction / Facility Encroachment', 'Illegal Construction', 'Cultivation inside ROW', 'Unauthorised Access'];
const userOpts = () => S.users.filter(u => u.status === 'Active').map(u => [u.username, u.fullName + ' — ' + u.position]);
const uName = un => S.users.find(u => u.username === un)?.fullName || un || '-';

/* ---------- calculations ---------- */
function caseTotals(r) {
  const ll = r.leaseLines || [], cl = r.cropLines || [], tl = r.treeLines || [], ml = r.miscLines || [];
  const leaseArea = sum(ll, 'leaseArea'), subArea = sum(ll, x => x.subsequentArea ?? x.leaseArea);
  const leaseAmt = leaseArea * num(r.leaseRate) * (num(r.leaseTerm || 12) / 12);
  const crop = sum(cl, x => num(x.rate) * num(x.damageArea)), tree = sum(tl, x => num(x.rate) * num(x.qty)), misc = sum(ml, 'amount');
  return { leaseArea, subArea, leaseAmt, crop, tree, misc, damageArea: sum(cl, 'damageArea'), total: leaseAmt + crop + tree + misc };
}
function leaseInfo(r) {
  const end = addYears(r.startDate, r.termYears); const days = daysTo(end);
  const area = r.subsequentArea ?? r.initialArea; const rent = num(area) * num(r.ratePerAcre);
  let status = 'Active'; if (r.stage === 'Stopped') status = 'Stopped'; else if (days == null) status = '-'; else if (days < 0) status = 'Expired'; else if (days <= 180) status = 'Expiring';
  return { end, days, rent, status, area };
}
function expiryBadge(days, status) {
  if (status === 'Stopped') return stageBadge('Stopped'); if (days == null) return '-';
  if (days < 0) return `<span class="b b-d">Expired ${-days}d ago</span>`;
  const band = days <= 30 ? ['d', '≤30d'] : days <= 60 ? ['d', '≤60d'] : days <= 90 ? ['w', '≤90d'] : days <= 180 ? ['w', '≤180d'] : ['g', ''];
  return `<span class="b b-${band[0]}">${days} days ${band[1] ? '· ' + band[1] : ''}</span>`;
}
function rowInfo(r) {
  const area = num(r.lengthM) * num(r.widthM) / 4046.8564224;
  let next = null; if (r.agreementDate) { const base = new Date(r.agreementDate); const t = new Date(today()); next = new Date(base); while (next <= t) next.setFullYear(next.getFullYear() + 1); next = iso(next); }
  const end = r.agreementDate && r.tenureYears ? addYears(r.agreementDate, r.tenureYears) : null;
  return { area, next, nextDays: daysTo(next), end, endDays: daysTo(end) };
}
function occupiedArea(surveyId) {
  return sum(S.cases.filter(c => c.stage !== 'Cancelled'), c => sum((c.leaseLines || []).filter(l => l.surveyId === surveyId), 'leaseArea'));
}
function ownerShareTotal(surveyId) { if (!CACHE.share) { const m = new Map(); S.landowners.forEach(lo => (lo.shares || []).forEach(s => m.set(s.surveyId, (m.get(s.surveyId) || 0) + num(s.share)))); CACHE.share = m; } return CACHE.share.get(surveyId) || 0; }
function titleIssues(surveyIds) {
  const out = [];
  (surveyIds || []).forEach(id => {
    const s = byId('surveys', id); if (!s) return; const tot = ownerShareTotal(id);
    if (s.landClass !== 'Government' && Math.abs(tot - 100) > 0.5) out.push(`${s.code}: owner shares total ${fmt(tot, 2)}% (must be 100%)`);
    S.landowners.filter(lo => (lo.shares || []).some(x => x.surveyId === id)).forEach(lo => {
      if (lo.status === 'Deceased') out.push(`${s.code}: owner ${lo.code} is deceased — legal heirs / mutation required`);
      if (!/^\d{5}-\d{7}-\d$/.test(lo.cnic || '')) out.push(`${s.code}: owner ${lo.code} has invalid CNIC`);
    });
    if (s.status === 'Disputed') out.push(`${s.code}: land is marked Disputed`);
    S.legal.filter(l => legalOpen(l) && (l.surveyIds || []).includes(id)).forEach(l => out.push(`${s.code}: pending court case ${l.code} (${l.caseType})${l.stayOrder === 'Yes' ? ' — STAY ORDER' : ''}`));
  });
  return out;
}
function paidTo(landownerId) {
  let m = CACHE.paid;
  if (!m) { m = CACHE.paid = new Map(); S.payments.forEach(p => { if (p.stage === 'Released') m.set(p.landownerId, (m.get(p.landownerId) || 0) + num(p.net)); }); }
  return m.get(landownerId) || 0;
}
function payOwners(totalByOwner, base) { // helper to create payment requests
  const made = [];
  totalByOwner.forEach(({ landownerId, payee, gross }) => {
    if (gross <= 0) return;
    const p = Object.assign({ id: uid(), landownerId: landownerId || '', payee: payee || '', gross: Math.round(gross), whtPct: landownerId ? (byId('landowners', landownerId)?.filer === 'Non-Filer' ? S.settings.wht * 2 : S.settings.wht) : 0, mode: 'Cross Cheque', createdAt: nowStr(), createdBy: ME.username, stage: 'Requested', history: [] }, base);
    SPEC.payments.prepare(p); const dup = SPEC.payments.validate(p, null); if (dup) { toast(dup, 'warning'); return; }
    p.code = nextCode('VCH-' + new Date().getFullYear() + '-', 5); pushHist(p, 'Created (auto-generated)', '', 'Requested', base.remarks || ''); S.payments.push(p); audit('payments', p, 'Created (auto)', null, p); made.push(p);
  });
  return made;
}


const LEGAL_CLOSED = ['Decided — In Favour', 'Decided — Against', 'Settled', 'Withdrawn'];
const legalOpen = l => !LEGAL_CLOSED.includes(l.status);
function stayFor(p) {
  const c = byId('cases', p.caseId); const lease = byId('leases', p.leaseId);
  const svs = uniq([...(c ? (c.leaseLines || []).map(x => x.surveyId) : []), ...(lease?.surveyIds || [])]);
  return S.legal.find(l => l.stayOrder === 'Yes' && legalOpen(l) && ((p.landownerId && (l.landownerIds || []).includes(p.landownerId)) || svs.some(s => (l.surveyIds || []).includes(s))));
}
function applyMutation(m) {
  const dec = byId('landowners', m.deceasedId); const applied = [];
  (m.surveyIds || []).forEach(sid => {
    const hold = (dec.shares || []).find(x => x.surveyId === sid); if (!hold) return;
    const base = num(hold.share); dec.shares = dec.shares.filter(x => x.surveyId !== sid);
    const to = [];
    (m.heirs || []).forEach(h => { const heir = byId('landowners', h.landownerId); if (!heir) return; const add = +(base * num(h.share) / 100).toFixed(4);
      heir.shares = heir.shares || []; const ex = heir.shares.find(x => x.surveyId === sid); if (ex) ex.share = +(num(ex.share) + add).toFixed(4); else heir.shares.push({ surveyId: sid, share: add, ref: 'Mutation ' + m.mutationNo });
      to.push(heir.code + ' ' + fmt(add, 2) + '%'); });
    applied.push({ survey: codeOf('surveys', sid), from: fmt(base, 2) + '%', to: to.join(', ') });
  });
  const heirs = (m.heirs || []).map(h => h.landownerId);
  ['leases', 'rows'].forEach(c => S[c].forEach(x => { if ((x.landownerIds || []).includes(dec.id)) { x.landownerIds = uniq([...x.landownerIds.filter(i => i !== dec.id), ...heirs]); pushHist(x, 'Lessor updated by mutation ' + m.code, x.stage, x.stage); } }));
  dec.status = 'Deceased'; pushHist(dec, 'Holdings transferred to legal heirs by ' + m.code, '', ''); m.applied = applied; m.appliedAt = nowStr();
}
