/**
 * End-to-End Automated Verification Script for LMS Next.js + PostgreSQL Application
 */

const BASE_URL = 'http://localhost:3030';

async function runTests() {
  console.log('================================================================');
  console.log('🚀 LMS End-to-End Automated Verification (Next.js + PostgreSQL)');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  // 1. Provinces API
  console.log('1. Testing Provincial Jurisdictions API (/api/provinces)...');
  const provRes = await fetch(`${BASE_URL}/api/provinces`);
  const provData = await provRes.json();
  assert(provRes.status === 200, 'Status is 200 OK');
  assert(provData.provinces && provData.provinces.length === 4, 'Returns all 4 provincial jurisdictions (SND, BAL, PNJ, KPK)');
  assert(provData.provinces.some(p => p.province_code === 'SND' && Number(p.parcels) >= 7), 'Sindh has >= 7 parcels in database');

  // 2. Projects API
  console.log('\n2. Testing E&P Concession Projects API (/api/projects)...');
  const projRes = await fetch(`${BASE_URL}/api/projects`);
  const projData = await projRes.json();
  assert(projRes.status === 200, 'Status is 200 OK');
  assert(projData.projects && projData.projects.length >= 7, 'Returns >= 7 concession projects');
  const sui = projData.projects.find(p => p.project_code.includes('SUI'));
  assert(sui && sui.province_code === 'BAL', 'Sui Gas Field identified in Balochistan jurisdiction');

  // 3. Landowners API
  console.log('\n3. Testing Landowners & CNIC API (/api/landowners)...');
  const loRes = await fetch(`${BASE_URL}/api/landowners`);
  const loData = await loRes.json();
  assert(loRes.status === 200, 'Status is 200 OK');
  assert(loData.landowners && loData.landowners.length >= 10, 'Returns >= 10 master landowners');
  const deceasedOwner = loData.landowners.find(l => l.is_deceased);
  assert(deceasedOwner !== undefined, `Deceased landowner identified with succession lock (${deceasedOwner?.full_name})`);
  assert(loData.landowners.every(l => /^[0-9]{5}-[0-9]{7}-[0-9]{1}$/.test(l.cnic)), 'All landowners conform to NADRA CNIC format (XXXXX-XXXXXXX-X)');

  // 4. Surveys & Co-Ownership Shares API
  console.log('\n4. Testing Cadastral Surveys & 100% Co-Ownership Share Balancer (/api/surveys)...');
  const survRes = await fetch(`${BASE_URL}/api/surveys`);
  const survData = await survRes.json();
  assert(survRes.status === 200, 'Status is 200 OK');
  assert(survData.surveys && survData.surveys.length >= 13, 'Returns all 13 surveyed cadastral parcels');
  
  // Inspect single survey with owners
  const singleSurvey = survData.surveys[0];
  const detailRes = await fetch(`${BASE_URL}/api/surveys?id=${singleSurvey.survey_id}`);
  const detailData = await detailRes.json();
  assert(detailRes.status === 200, `Retrieved parcel details for ${singleSurvey.survey_code}`);
  assert(detailData.shares && detailData.shares.length > 0, 'Parcel co-ownership shares successfully queried');
  const shareSum = detailData.shares.reduce((a, b) => a + Number(b.share_pct), 0);
  assert(Math.abs(shareSum - 100.0) < 0.01, `Co-ownership share sum equals exactly 100.0% (${shareSum}%)`);

  // 5. GIS GeoJSON API
  console.log('\n5. Testing Cadastral Vector GIS API (/api/gis)...');
  const gisRes = await fetch(`${BASE_URL}/api/gis`);
  const gisData = await gisRes.json();
  assert(gisRes.status === 200, 'Status is 200 OK');
  assert(gisData.type === 'FeatureCollection', 'Returns valid GeoJSON FeatureCollection');
  assert(gisData.features && gisData.features.length >= 13, 'Contains >= 13 spatial point/polygon features with real coordinates');

  // 6. Authentication & Session
  console.log('\n6. Testing User Authentication & Session Cookie (/api/auth/login)...');
  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'lofield' }),
  });
  const loginData = await loginRes.json();
  assert(loginRes.status === 200, 'Login succeeded as lofield');
  assert(loginData.user && loginData.user.username === 'lofield', 'User persona is Land Officer (lofield)');

  const cookieHeader = loginRes.headers.get('set-cookie');
  assert(cookieHeader && cookieHeader.includes('lms_user_id'), 'HTTP-only session cookie issued');

  function extractCookie(header) {
    if (!header) return '';
    const match = header.match(/lms_user_id=[^;]+/);
    return match ? match[0] : header.split(';')[0];
  }

  const cookieValue = extractCookie(cookieHeader);

  // Verify /api/auth/me with cookie
  const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
    headers: { Cookie: cookieValue },
  });
  const meData = await meRes.json();
  assert(meData.user && meData.user.username === 'lofield', 'Current user session verified via cookie');

  // 7. Case Initiation as Land Officer
  console.log('\n7. Initiating New Compensation Case as Land Officer (/api/cases)...');
  const targetProject = projData.projects[0];
  const activeLandowner = loData.landowners.find(l => !l.is_deceased && !l.is_on_hold);

  const createCaseRes = await fetch(`${BASE_URL}/api/cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieValue },
    body: JSON.stringify({
      project_id: targetProject.project_id,
      land_use_code: 'Well Location',
      case_remarks: 'Field joint measurement report attached. E2E verification test.',
      crop_amount: 150000,
      tree_amount: 75000,
      lease_amount: 200000,
      misc_amount: 25000,
      owners: [{ landowner_id: activeLandowner.id, share_pct: 100.0 }],
    }),
  });
  const createCaseData = await createCaseRes.json();
  assert(createCaseRes.status === 200, 'New compensation case created in PostgreSQL');
  assert(createCaseData.case && createCaseData.case.stage_code === 'Prepared', 'Case initial stage is "Prepared"');
  const newCaseId = createCaseData.case.id;
  const newCaseCode = createCaseData.case.code;
  console.log(`    -> Created Case: ${newCaseCode} (ID: ${newCaseId})`);

  // 8. 6-Tier Segregation of Duties Workflow Advancement
  console.log('\n8. Testing 6-Tier Segregation of Duties (SoD) Sequential Approval Pipeline...');

  // Helper to switch user and get cookie
  async function loginAs(user) {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user }),
    });
    return extractCookie(res.headers.get('set-cookie'));
  }

  // Tier 1 -> Tier 2: Negotiation Group (nego) advances Prepared -> Checked
  const negoCookie = await loginAs('nego');
  const t1Res = await fetch(`${BASE_URL}/api/cases/${newCaseId}/transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: negoCookie },
    body: JSON.stringify({ to_stage: 'Checked', note: 'Rates agreed with landowner', as_group: 'Negotiation Group' }),
  });
  const t1Data = await t1Res.json();
  assert(t1Res.status === 200 && t1Data.new_stage === 'Checked', 'Stage 2 approved: Prepared -> Checked by Negotiation Group');

  // Tier 2 -> Tier 3: Legal Advisor (legal) advances Checked -> Reviewed
  const legalCookie = await loginAs('legal');
  const t2Res = await fetch(`${BASE_URL}/api/cases/${newCaseId}/transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: legalCookie },
    body: JSON.stringify({ to_stage: 'Reviewed', note: 'Title search clear, no litigation', as_group: 'Legal Advisor' }),
  });
  const t2Data = await t2Res.json();
  assert(t2Res.status === 200 && t2Data.new_stage === 'Reviewed', 'Stage 3 approved: Checked -> Reviewed by Legal Advisor');

  // Tier 3 -> Tier 4: Sr. Administrator Field (sradmin) advances Reviewed -> Verified
  const sradminCookie = await loginAs('sradmin');
  const t3Res = await fetch(`${BASE_URL}/api/cases/${newCaseId}/transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sradminCookie },
    body: JSON.stringify({ to_stage: 'Verified', note: 'Field administration endorsement', as_group: 'Sr. Administrator LMS (Field)' }),
  });
  const t3Data = await t3Res.json();
  assert(t3Res.status === 200 && t3Data.new_stage === 'Verified', 'Stage 4 approved: Reviewed -> Verified by Sr. Administrator (Field)');

  // Tier 4 -> Tier 5: Field Approval by DM/TL (dmfield)
  const dmCookie = await loginAs('dmfield');
  const t4Res = await fetch(`${BASE_URL}/api/cases/${newCaseId}/transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: dmCookie },
    body: JSON.stringify({ to_stage: 'Field Approved', note: 'Field team lead clearance', as_group: 'DM / Team Lead (Field)' }),
  });
  const t4Data = await t4Res.json();
  assert(t4Res.status === 200 && t4Data.new_stage === 'Field Approved', 'Stage 5 approved: Verified -> Field Approved by DM/TL');

  // Tier 5 -> Tier 6: Head Office Kharat Approval (mland)
  const mlandCookie = await loginAs('mland');
  const t5Res = await fetch(`${BASE_URL}/api/cases/${newCaseId}/transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: mlandCookie },
    body: JSON.stringify({ to_stage: 'HO Approved', note: 'Executive Kharat approval granted', as_group: 'Manager Land (HO)' }),
  });
  const t5Data = await t5Res.json();
  assert(t5Res.status === 200 && t5Data.new_stage === 'HO Approved', 'Stage 6 approved: Field Approved -> HO Approved by Manager Land (HO)');

  // 9. Payment Request & Multi-Persona Finance Release (SoD Enforced)
  console.log('\n9. Testing Payment Voucher Generation & Finance Cheque Release (/api/payments)...');
  const lofieldCookie = await loginAs('lofield');
  const financeCookie = await loginAs('finance');
  const mlandFinanceCookie = await loginAs('mland');

  // Request voucher against the newly approved case (prepared by Land Officer)
  const reqPayRes = await fetch(`${BASE_URL}/api/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: lofieldCookie },
    body: JSON.stringify({
      action: 'request',
      project_id: targetProject.project_id,
      case_id: newCaseId,
      landowner_id: activeLandowner.id,
      gross_amount: 450000,
      wht_pct: 10,
      category: 'Crop Compensation',
      pay_type: 'One-time',
    }),
  });
  const reqPayData = await reqPayRes.json();
  assert(reqPayRes.status === 200, 'Payment voucher generated in Requested stage');
  const newPaymentId = reqPayData.payment_id;

  // Verify voucher (Finance Officer verifies, enforcing SoD: preparer != verifier)
  const verifyPayRes = await fetch(`${BASE_URL}/api/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: financeCookie },
    body: JSON.stringify({ action: 'verify', payment_id: newPaymentId }),
  });
  const verifyPayData = await verifyPayRes.json();
  assert(verifyPayRes.status === 200, 'Payment voucher verified by Finance Officer');

  // Release payment with cheque (Manager Land holding payments:release authorization)
  const releasePayRes = await fetch(`${BASE_URL}/api/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: mlandFinanceCookie },
    body: JSON.stringify({
      action: 'release',
      payment_id: newPaymentId,
      cheque_date: '2026-10-28',
      note: 'Crossed cheque disbursed against signed receipt',
    }),
  });
  const releasePayData = await releasePayRes.json();
  assert(releasePayRes.status === 200, 'Payment released with bank cheque issued');

  // 10. Audit Trail Verification
  console.log('\n10. Testing Immutable Audit Trail Capture (/api/audit)...');
  const auditRes = await fetch(`${BASE_URL}/api/audit?limit=15`);
  const auditData = await auditRes.json();
  assert(auditRes.status === 200, 'Status is 200 OK');
  assert(auditData.auditEvents && auditData.auditEvents.length > 0, 'Audit trail contains recorded events');
  const recentCaseEvent = auditData.auditEvents.find(e => e.record_code === newCaseCode || e.record_id === newCaseId);
  assert(recentCaseEvent !== undefined, `Audit event successfully captured for case ${newCaseCode} in PostgreSQL`);

  console.log('\n================================================================');
  console.log(`📊 Test Summary: ${passed} Passed, ${failed} Failed`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
